import type { PlatformId, ReadConnector } from './contracts/index';
import { ConnectorError } from './contracts/index';

// Register each verified adapter explicitly here. An empty registry is a visible capability gap.
const registry: Partial<Record<PlatformId, ReadConnector>> = {};

export function getConnector(platform: PlatformId): ReadConnector {
  const connector = registry[platform];
  if (!connector) throw new ConnectorError('NOT_IMPLEMENTED', `${platform} 采集连接器尚未实现`);
  return connector;
}
