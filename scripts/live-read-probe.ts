import assert from 'node:assert/strict';
import { closeDb, getCollectionControl } from '@acm/db/server';
import { createQojReadWorker, readPlatform, readOutcomeSummary } from '../packages/core/src/application/index';
import type { AccountRef, PlatformId, SubmissionPage } from '../packages/connectors/src/contracts/index';

// Run inside the existing worker; CDP disconnect preserves the user's Chromium session.
const platform = process.argv[2] as PlatformId;
assert.ok(['codeforces', 'luogu', 'qoj'].includes(platform));
const target = process.argv[3] ?? ({ codeforces: 'tourist', luogu: '863154', qoj: 'muhammad' }[platform]);
const signal = AbortSignal.timeout(150000);
const qoj = platform === 'qoj' ? createQojReadWorker({ transport: 'browser', connectionId: process.env.QOJ_CONNECTION_ID ?? 'qoj-lab', signal, humanRetries: 0, browser: { cdpEndpoint: 'http://127.0.0.1:9222', headed: true, timeoutMs: 30000, maxRetries: 1 } }) : undefined;
let account: AccountRef | undefined;
const pages: SubmissionPage[] = [];
try {
  assert.equal((await getCollectionControl()).enabled, false, 'Bounded acceptance precedes collection activation');
  const result = await readPlatform({ platform, target, maxPages: 2, maxDurationMs: 120000, operation: 'submissions', mode: 'backfill' }, { signal, qoj, persist: false, onAccount: async value => { account = value; }, onPage: async page => {
    assert.ok(account);
    assert.equal(page.coverage, 'visible');
    const ids = page.submissions.map(row => row.externalSubmissionId);
    assert.equal(new Set(ids).size, ids.length, 'Duplicate IDs within page');
    for (const row of page.submissions) {
      assert.equal(row.platform, platform); assert.ok(row.externalSubmissionId); assert.ok(row.problemKey);
      assert.ok(row.submittedAt && Number.isFinite(Date.parse(row.submittedAt)), 'Submission time is missing');
      assert.ok(Date.parse(row.submittedAt) <= Date.now() + 300000, 'Future submission time');
      assert.ok(['accepted', 'rejected', 'pending', 'unknown'].includes(row.verdict));
      assert.ok(row.subjectEvidence.authorAccountKeys.length, 'Author evidence missing');
      const expected = platform === 'luogu' ? account.externalId : account.handle;
      const normalize = (value: string) => platform === 'codeforces' ? value.toLowerCase() : value;
      assert.ok(row.subjectEvidence.authorAccountKeys.some(key => normalize(key) === normalize(expected!)), 'List filter is not author evidence');
    }
    pages.push(page);
    const verdicts: Record<string, number> = {};
    for (const row of page.submissions) verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
    console.log(JSON.stringify({ event: 'live_page_validated', platform, page: pages.length, count: page.submissions.length, verdicts, sourceUrl: page.sourceUrl, stopReason: page.stopReason, cursor: page.nextCursor, samples: page.submissions.slice(0, 2).map(row => ({ id: row.externalSubmissionId, problem: row.problemKey, time: row.submittedAt, verdict: row.verdict, nativeVerdict: row.nativeVerdict ?? row.nativeResult ?? row.nativeStatus, authors: row.subjectEvidence.authorAccountKeys })) }));
  } });
  console.log(JSON.stringify({ event: 'live_read_result', ...readOutcomeSummary(result) }));
  assert.equal(result.status, 'completed', `Read failed: ${result.error?.code}`);
  assert.ok(pages.length === 2 || result.stopReason === 'history_end', 'Two pages or explicit visible history end required');
  if (pages.length === 2 && pages[0]!.submissions.length && pages[1]!.submissions.length) {
    assert.notDeepEqual(pages[0]!.nextCursor, pages[1]!.nextCursor, 'Pagination did not advance');
    assert.ok(pages[1]!.submissions.some(row => !pages[0]!.submissions.some(old => old.externalSubmissionId === row.externalSubmissionId)), 'Second page has no new IDs');
  }
} finally { await qoj?.close(); await closeDb(); }
