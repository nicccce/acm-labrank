import type { PlatformId, ReadConnector } from './contracts/index';
import { ConnectorError } from './contracts/index';
import { qojConnector } from './qoj/index';
export { qojLogin } from './qoj/login';
export { qojResponseIssue } from './qoj/http';

// Register implemented adapters explicitly; missing entries remain explicit capability gaps.
const registry: Partial<Record<PlatformId, ReadConnector>> = { qoj: qojConnector };

export function getConnector(platform: PlatformId): ReadConnector {
  const connector = registry[platform];
  if (!connector) throw new ConnectorError('NOT_IMPLEMENTED', `${platform} 采集连接器尚未实现`);
  return connector;
}
