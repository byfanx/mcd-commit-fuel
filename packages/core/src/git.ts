import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isReleaseTag, isRevertMessage, type Signal } from './signals.js';
import { DAY } from './time.js';

const exec = promisify(execFile);

/** 解析 `git log --format=%ct%x09%s`。subject 只用来判断是否 revert，不保留。 */
export function parseCommitLog(text: string): Signal[] {
  const out: Signal[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const sec = Number(line.slice(0, tab));
    if (!Number.isFinite(sec) || sec <= 0) continue;
    out.push({ kind: 'commit', ts: sec * 1000, revert: isRevertMessage(line.slice(tab + 1)) });
  }
  return out;
}

/** 解析 `git for-each-ref --format=%(creatordate:unix)%09%(refname:short)`，只保留 sinceMs 之后的。 */
export function parseTagRefs(text: string, sinceMs: number, releaseTagPattern?: string): Signal[] {
  const out: Signal[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const ts = Number(line.slice(0, tab)) * 1000;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    out.push({ kind: 'tag', ts, release: isReleaseTag(line.slice(tab + 1), releaseTagPattern) });
  }
  return out;
}

export interface GitOptions {
  releaseTagPattern?: string;
  timeoutMs?: number;
}

/**
 * 在 cwd 所在仓库里读取最近 24 小时的提交和 tag。只在本地执行 git，
 * 不是 git 仓库、没有 git 或执行失败时返回空数组。
 */
export async function collectGitSignals(cwd: string, now: number, options: GitOptions = {}): Promise<Signal[]> {
  const since = now - DAY;
  const git = async (args: string[]) =>
    (
      await exec('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
        timeout: options.timeoutMs ?? 3_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // 只读操作，不要去抢 index.lock
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })
    ).stdout;

  try {
    const [log, tags] = await Promise.all([
      git(['log', `--since=@${Math.floor(since / 1000)}`, '--no-merges', '--format=%ct%x09%s']),
      git(['for-each-ref', '--sort=-creatordate', '--count=100', '--format=%(creatordate:unix)%09%(refname:short)', 'refs/tags']),
    ]);
    return [...parseCommitLog(log), ...parseTagRefs(tags, since, options.releaseTagPattern)];
  } catch {
    return [];
  }
}
