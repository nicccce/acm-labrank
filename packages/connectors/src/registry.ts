import type { PlatformId, ReadConnector } from './contracts/index';
import { ConnectorError } from './contracts/index';
import { codeforcesConnector } from './codeforces/index';
import { qojConnector } from './qoj/index';
import { luoguConnector } from './luogu/index';
export { luoguLogin } from './luogu/login';
export { fetchPractice as fetchLuoguPractice } from './luogu/index';
export { qojLogin } from './qoj/login';
export { qojResponseIssue } from './qoj/http';

// Register implemented adapters explicitly; missing entries remain explicit capability gaps.
const registry: Partial<Record<PlatformId, ReadConnector>> = { codeforces: codeforcesConnector, qoj: qojConnector, luogu: luoguConnector };

export function getConnector(platform: PlatformId): ReadConnector {
  const connector = registry[platform];
  if (!connector) throw new ConnectorError('NOT_IMPLEMENTED', `${platform} 采集连接器尚未实现`);
  return connector;
}
