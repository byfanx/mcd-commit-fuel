import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import {
  McdApi,
  McpClient,
  VERSION,
  classifyTask,
  collectGitSignals,
  prepareReceipt,
  recordSignals,
  resolveCacheDir,
  runRefresh,
  type Signal,
} from '@mcd-commit-fuel/core';
import { statusline } from './statusline.js';

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** 外部依赖，测试时替换。 */
export interface Deps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => number;
  readStdin: () => Promise<string>;
  spawnRefresh: (cwd: string | undefined) => void;
  runCommand: (cmd: string[], io: Io) => Promise<number>;
  collectSignals: (cwd: string, now: number) => Promise<Signal[]>;
}

const USAGE = `mcd-fuel ${VERSION}

用法：
  mcd-fuel statusline                      给 Claude Code statusline 用：读缓存输出一行，必要时后台刷新
  mcd-fuel refresh [--cwd 目录] [--force] [--quiet]
                                           采集本地 git 信号并刷新数据（只调用只读接口）
  mcd-fuel receipt [--cwd 目录]            打印今日 Commit 小票
  mcd-fuel run -- <命令> [参数...]          运行命令，记录构建/测试的耗时和结果
  mcd-fuel --version | --help

环境变量：
  MCD_MCP_TOKEN        麦当劳 MCP token，只从环境变量读取，不会写入任何文件
  MCD_FUEL_CACHE_DIR   缓存目录，默认 ~/.cache/mcd-commit-fuel`;

/** CLI 入口，返回进程退出码。 */
export async function run(argv: string[], io: Io, overrides: Partial<Deps> = {}): Promise<number> {
  const deps: Deps = { ...defaultDeps(), ...overrides };
  const [cmd, ...args] = argv;
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      io.stdout(USAGE);
      return 0;
    case '-v':
    case '--version':
      io.stdout(VERSION);
      return 0;
    case 'statusline':
      return cmdStatusline(io, deps);
    case 'refresh':
      return cmdRefresh(args, io, deps);
    case 'receipt':
      return cmdReceipt(args, io, deps);
    case 'run':
      return cmdRun(args, io, deps);
    default:
      io.stderr(`未知命令：${cmd}\n\n${USAGE}`);
      return 2;
  }
}

async function cmdStatusline(io: Io, deps: Deps): Promise<number> {
  try {
    const text = await statusline({
      dir: resolveCacheDir(deps.env),
      hasToken: Boolean(deps.env.MCD_MCP_TOKEN?.trim()),
      now: deps.now(),
      stdin: await deps.readStdin(),
      spawnRefresh: deps.spawnRefresh,
    });
    io.stdout(text);
  } catch {
    // 状态栏不能报错刷屏，出问题时只显示一个图标
    io.stdout('🍟');
  }
  return 0;
}

async function cmdRefresh(args: string[], io: Io, deps: Deps): Promise<number> {
  const { flags, options } = parseArgs(args, ['--force', '--quiet'], ['--cwd']);
  const quiet = flags.has('--quiet');
  const dir = resolveCacheDir(deps.env);
  await collectAndRecord(options.get('--cwd') ?? deps.cwd, dir, deps);

  const result = await runRefresh({ dir, api: makeApi(deps.env), force: flags.has('--force'), clock: deps.now });
  if (quiet) return 0;
  if (result.skipped) {
    io.stdout('另一个刷新正在进行，本次跳过');
    return 0;
  }
  const view = result.cache?.view;
  if (view) io.stdout(view.text);
  io.stdout(`状态 ${view?.state ?? '-'}；已更新 ${result.fetched.join(', ') || '无（数据未过期）'}`);
  for (const key of result.failed) {
    const entry = result.cache?.data[key];
    io.stderr(`更新失败 ${key}：${entry?.errorKind ?? ''} ${entry?.error ?? ''}`.trim());
  }
  return 0;
}

async function cmdReceipt(args: string[], io: Io, deps: Deps): Promise<number> {
  const { options } = parseArgs(args, [], ['--cwd']);
  const dir = resolveCacheDir(deps.env);
  await collectAndRecord(options.get('--cwd') ?? deps.cwd, dir, deps);

  io.stdout(await prepareReceipt({ dir, api: makeApi(deps.env), now: deps.now() }));
  return 0;
}

async function cmdRun(args: string[], io: Io, deps: Deps): Promise<number> {
  const sep = args.indexOf('--');
  const cmd = sep >= 0 ? args.slice(sep + 1) : args;
  if (cmd.length === 0) {
    io.stderr('用法：mcd-fuel run -- <命令> [参数...]');
    return 2;
  }
  const dir = resolveCacheDir(deps.env);
  const started = deps.now();
  const id = `run-${process.pid}-${started}`;
  const category = classifyTask(cmd.join(' '));

  // 记录信号失败不能影响用户自己的命令
  const record = async (signal: Signal) => {
    try {
      await recordSignals(dir, [signal], signal.ts);
    } catch (err) {
      io.stderr(`mcd-fuel：记录信号失败（${err instanceof Error ? err.message : String(err)}）`);
    }
  };

  await record({ kind: 'task-start', ts: started, id, category });
  const exitCode = await deps.runCommand(cmd, io);
  await record({ kind: 'task-end', ts: deps.now(), id, category, exitCode });
  return exitCode;
}

async function collectAndRecord(cwd: string, dir: string, deps: Deps): Promise<void> {
  const now = deps.now();
  const signals = await deps.collectSignals(cwd, now);
  if (signals.length) await recordSignals(dir, signals, now);
}

function makeApi(env: NodeJS.ProcessEnv): McdApi | undefined {
  const token = env.MCD_MCP_TOKEN?.trim();
  return token ? new McdApi(new McpClient({ token })) : undefined;
}

function parseArgs(args: string[], flagNames: string[], optionNames: string[]) {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (flagNames.includes(a)) flags.add(a);
    else if (optionNames.includes(a) && args[i + 1] !== undefined) options.set(a, args[++i]!);
  }
  return { flags, options };
}

function defaultDeps(): Deps {
  return {
    env: process.env,
    cwd: process.cwd(),
    now: Date.now,
    readStdin,
    spawnRefresh,
    runCommand,
    collectSignals: (cwd, now) => collectGitSignals(cwd, now),
  };
}

function readStdin(timeoutMs = 200): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    const finish = () => {
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * 以独立进程在后台刷新，当前进程立刻返回。
 * 用当前脚本路径重新启动自己，所以源码运行和打包成单文件后都能用。
 */
function spawnRefresh(cwd: string | undefined): void {
  const self = process.argv[1];
  if (!self) return;
  const child = spawn(process.execPath, [self, 'refresh', '--quiet', ...(cwd ? ['--cwd', cwd] : [])], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

function runCommand(cmd: string[], io: Io): Promise<number> {
  return new Promise((resolve) => {
    // Ctrl+C 会同时发给子进程；这里先忽略，等子进程退出后记录结果
    const ignore = () => {};
    process.on('SIGINT', ignore);
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', ignore);
      resolve(code);
    };
    // Windows 上 npm、npx 等是 .cmd 文件，需要通过 shell 执行
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', (err) => {
      io.stderr(`无法运行 ${cmd[0]}：${err.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
  });
}
