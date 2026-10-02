// Focused server entry for read-only workers; importing it does not initialize authentication sessions.
export * from './collection/request-context';
export * from './collection/read-account';
export * from './collection/read';
export * from './collection/contracts';
export * from './collection/jobs';
export type { PlatformId, PlatformReadRequest, PlatformReadOutcome } from '@acm/connectors/contracts';
export { ConnectorError } from '@acm/connectors/contracts';
