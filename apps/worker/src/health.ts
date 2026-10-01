import { checkWorkerReady, closeDb } from '@acm/db/server';
try { if (!await checkWorkerReady()) process.exitCode = 1; }
catch { process.exitCode = 1; }
finally { await closeDb(); }
