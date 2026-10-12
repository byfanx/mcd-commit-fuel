import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MINUTE, computeView, readCache } from '@mcd-commit-fuel/core';

/** 距上次刷新超过这个时间就在后台刷新一次（采集 git 信号；MCP 调用仍受 TTL 控制）。 */
export const SIGNAL_REFRESH_MS = 2 * MINUTE;
/** 两次拉起后台刷新之间至少间隔这么久，防止刷新进程启动失败时每次都重新拉起。 */
export const SPAWN_COOLDOWN_MS = MINUTE;
const SPAWN_MARKER = 'refresh.spawned';

/** Claude Code 通过 stdin 传入 JSON，只取工作目录。 */
export function parseStatuslineInput(text: string): string | undefined {
  try {
    const v = JSON.parse(text) as { workspace?: { current_dir?: unknown }; cwd?: unknown };
    const dir = v.workspace?.current_dir ?? v.cwd;
    return typeof dir === 'string' && dir ? dir : undefined;
  } catch {
    return undefined;
  }
}

export interface StatuslineOptions {
  dir: string;
  hasToken: boolean;
  now: number;
  stdin: string;
  spawnRefresh: (cwd: string | undefined) => void;
}

/**
 * 只读缓存、不发网络请求，输出一行状态。
 * 展示结果在内存里按当前时间重新计算（状态会随时间变化），但不写回缓存，写缓存交给刷新器。
 */
export async function statusline(options: StatuslineOptions): Promise<string> {
  const cache = await readCache(options.dir);
  const { view } = computeView(cache, options.now, { hasToken: options.hasToken });

  const due =
    cache.lastRefreshAt === undefined ||
    options.now - cache.lastRefreshAt >= SIGNAL_REFRESH_MS ||
    cache.view?.state !== view.state;
  if (due && (await claimSpawn(options.dir, options.now))) {
    options.spawnRefresh(parseStatuslineInput(options.stdin));
  }
  return view.text;
}

async function claimSpawn(dir: string, now: number): Promise<boolean> {
  const marker = join(dir, SPAWN_MARKER);
  try {
    const last = Number(await readFile(marker, 'utf8'));
    if (Number.isFinite(last) && now - last < SPAWN_COOLDOWN_MS && now >= last) return false;
  } catch {
    /* 第一次运行，没有标记文件 */
  }
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(marker, String(now), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
