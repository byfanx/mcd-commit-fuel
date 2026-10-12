/**
 * NETWORK：网络失败、超时、非 2xx（401/403 除外）
 * AUTH：token 缺失、无效或过期
 * TOOL：JSON-RPC error 或 result.isError
 * BIZ：业务返回 success=false
 * PROTOCOL：响应结构无法解析
 */
export type McpErrorKind = 'NETWORK' | 'AUTH' | 'TOOL' | 'BIZ' | 'PROTOCOL';

export interface McpErrorDetail {
  status?: number;
  code?: number;
}

export class McpError extends Error {
  override readonly name = 'McpError';

  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly detail: McpErrorDetail = {},
  ) {
    super(message);
  }
}
