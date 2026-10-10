import { DISCLAIMER, VERSION } from '@mcd-commit-fuel/core';

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = `mcd-fuel ${VERSION}（${DISCLAIMER}）

用法：
  mcd-fuel --version     显示版本
  mcd-fuel --help        显示帮助`;

/** CLI 入口，返回进程退出码。拆出来是为了在测试里注入 io。 */
export async function run(argv: string[], io: Io): Promise<number> {
  const [cmd] = argv;
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
    default:
      io.stderr(`未知命令：${cmd}\n\n${USAGE}`);
      return 2;
  }
}
