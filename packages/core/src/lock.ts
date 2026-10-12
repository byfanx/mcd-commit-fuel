import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isObject, parseJson } from './json.js';

export type Release = () => Promise<void>;

/**
 * 用 `wx` 创建锁文件，拿到就返回释放函数，拿不到返回 undefined。
 * 锁文件里记录 pid 和时间，超过 staleMs 的锁视为持有者已经崩溃，清掉后重试。
 * 锁文件刚好被释放（读不到）时只重试、不删除，避免误删别人刚建好的新锁。
 */
export async function tryLock(path: string, staleMs: number, now: () => number = Date.now): Promise<Release | undefined> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomBytes(8).toString('hex');
    try {
      const fh = await open(path, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, ts: now(), token }));
      } finally {
        await fh.close();
      }
      return async () => {
        // 只删自己的锁，避免误删别人清理过期锁后新建的锁
        try {
          const current = parseJson(await readFile(path, 'utf8'));
          if (isObject(current) && current.token === token) await rm(path, { force: true });
        } catch {
          /* 锁已经不在了 */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const check = await inspectLock(path, staleMs, now());
      if (check.status === 'fresh') return undefined;
      if (check.status === 'stale') {
        // 删除前再读一次，内容没变才删，缩小与其他清理者之间的竞争窗口
        const again = await readRaw(path);
        if (again !== undefined && again === check.raw) await rm(path, { force: true });
      }
      // 'missing'：锁刚被释放，直接重试创建
    }
  }
  return undefined;
}

type LockCheck = { status: 'missing' } | { status: 'fresh' } | { status: 'stale'; raw: string };

async function readRaw(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function inspectLock(path: string, staleMs: number, now: number): Promise<LockCheck> {
  const raw = await readRaw(path);
  if (raw === undefined) return { status: 'missing' };
  const content = parseJson(raw);
  if (isObject(content) && typeof content.ts === 'number') {
    return now - content.ts > staleMs ? { status: 'stale', raw } : { status: 'fresh' };
  }
  // 内容不完整（持有者可能正在写入），按修改时间判断
  try {
    return now - (await stat(path)).mtimeMs > staleMs ? { status: 'stale', raw } : { status: 'fresh' };
  } catch {
    return { status: 'missing' };
  }
}

export interface AcquireOptions {
  staleMs: number;
  timeoutMs: number;
  retryMs?: number;
  now?: () => number;
}

/** 等锁，最多等 timeoutMs。用于写缓存这种很快就会结束的操作。 */
export async function acquireLock(path: string, options: AcquireOptions): Promise<Release | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const release = await tryLock(path, options.staleMs, options.now);
    if (release || Date.now() >= deadline) return release;
    await new Promise((r) => setTimeout(r, options.retryMs ?? 20));
  }
}
