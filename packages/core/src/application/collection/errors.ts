import { ConnectorError, type ConnectorErrorCode, type PlatformId, type ReadAction, type ReadFailure, type ReadStatus } from '@acm/connectors/contracts';

const messages: Partial<Record<ConnectorErrorCode, string>> = {
  AUTH_REQUIRED: '采集连接需要重新登录', CHALLENGE_REQUIRED: '平台需要人工验证', RISK_CONTROL: '平台要求人工安全验证',
  ACCOUNT_NOT_FOUND: '平台账号不存在', ACCOUNT_AMBIGUOUS: '平台账号身份不明确', PRIVACY_RESTRICTED: '目标记录受隐私限制', FORBIDDEN: '当前采集身份没有目标读取权限',
  RATE_LIMITED: '平台限制请求频率，请等待冷却', PARSE_CHANGED: '平台响应结构变化，需要修复解析器', INVALID_CURSOR: '续跑状态不适用于本次请求', PAGINATION_DRIFT: '分页记录变化，需要重新核对进度',
  TIMEOUT: '读取预算或请求超时', CANCELLED: '读取已取消', NETWORK_ERROR: '平台网络请求失败', TEMP_UNAVAILABLE: '平台暂不可用', HTTP_ERROR: '平台返回 HTTP 错误',
  NOT_IMPLEMENTED: '平台尚不支持此能力', UNSUPPORTED_FLOW: '当前鉴权方式不受支持', LOGIN_FAILED: '平台登录失败', STALE_CHALLENGE: '鉴权挑战已失效', LEASE_LOST: '读取租约或连接版本失效', INVALID_INPUT: '平台读取参数不合法', RESPONSE_TOO_LARGE: '平台响应超过大小限制',
};
export function classifyReadFailure(error: unknown, platform: PlatformId): { status: ReadStatus; error: ReadFailure } {
  const source = error instanceof ConnectorError ? error : new ConnectorError('API_ERROR', '读取执行失败');
  const code = source.code;
  let status: ReadStatus = 'failed';
  let action: ReadAction = 'retry';
  if (code === 'AUTH_REQUIRED') { status = platform === 'codeforces' ? 'failed' : 'auth_required'; action = platform === 'codeforces' ? 'unsupported' : 'reauthenticate'; }
  else if (['CHALLENGE_REQUIRED', 'RISK_CONTROL'].includes(code)) { status = 'human_input_required'; action = 'human_verify'; }
  else if (['FORBIDDEN', 'PRIVACY_RESTRICTED'].includes(code)) { status = 'restricted'; action = 'fix_target'; }
  else if (code === 'PARSE_CHANGED') { status = 'parse_changed'; action = 'fix_parser'; }
  else if (code === 'TIMEOUT') status = 'timeout';
  else if (code === 'CANCELLED') { status = 'cancelled'; action = 'none'; }
  else if (['ACCOUNT_NOT_FOUND', 'ACCOUNT_AMBIGUOUS', 'INVALID_CURSOR', 'INVALID_INPUT', 'PAGINATION_DRIFT'].includes(code)) action = 'fix_target';
  else if (['NOT_IMPLEMENTED', 'UNSUPPORTED_FLOW'].includes(code)) action = 'unsupported';
  return { status, error: { code, message: messages[code] ?? '平台读取失败，请检查运行记录', httpStatus: source.httpStatus ?? null, retryAt: source.retryAt ?? null, action } };
}
