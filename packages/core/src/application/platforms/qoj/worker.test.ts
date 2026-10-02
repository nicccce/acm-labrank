import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { RequestContext } from '@acm/connectors/contracts';
import { ConnectorError } from '@acm/connectors/contracts';
import { createQojReadWorker, qojReadJobSchema, type QojWorkerOptions } from './worker';
const fixture = (name: string) => readFileSync(new URL(`../../../../../connectors/src/qoj/fixtures/${name}.html`, import.meta.url), 'utf8');
const profile = '<h5 class="card-header">User profile</h5><h2><span class="uoj-username">sample_person</span><span class="uoj-favourite-block" data-type="U" data-id="sample_person"></span></h2><h4>Usergroup</h4>';
const identity = '<a href="/logout">Logout</a><ul class="nav"><a class="uoj-username" href="/user/profile/collector">collector</a></ul>';
const job = { target: 'sample_person', maxPages: 2 };
function fake(request: RequestContext['request']) {
  const raw: RequestContext = { signal: new AbortController().signal, session: null, request };
  const runtime = { scopedContext: vi.fn(() => raw), ctx: raw, transport: 'browser-chromium', screenshot: vi.fn(async () => undefined), cancelPage: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const factory = vi.fn(async () => runtime) as unknown as NonNullable<QojWorkerOptions['browserFactory']>;
  const options: QojWorkerOptions = { transport: 'browser', connectionId: 'test', signal: raw.signal, browserFactory: factory, expectedLoginHandle: 'collector' };
  return { options, runtime, factory };
}
function html(body: string, url: URL, status = 200) {
  const response = new Response(body, { status, headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: url.href });
  return response;
}
const normal = async (url: URL) => html(url.pathname === '/' ? identity : url.pathname.startsWith('/user/') ? profile : url.searchParams.get('page') === '2' ? fixture('last').replace('>41<', '>2<') : fixture('normal'), url);

it('recovers a 200 challenge only after identity verification and a fresh original navigation', async () => {
  let cleared = false;
  const requests: string[] = [];
  const f = fake(async url => { requests.push(url.href); return !cleared ? html(fixture('challenge'), url) : normal(url); });
  const onHumanInput = vi.fn(async () => { cleared = true; return true; });
  const worker = createQojReadWorker({ ...f.options, onHumanInput });
  const commit = vi.fn(async () => undefined);
  const result = await worker.execute(job, new AbortController().signal, commit);
  expect(result).toMatchObject({ status: 'completed', pages: 2, uniqueSubmissions: 3, stopReason: 'history_end' });
  expect(requests.slice(0, 3)).toEqual(['https://qoj.ac/user/profile/sample_person', 'https://qoj.ac/', 'https://qoj.ac/user/profile/sample_person']);
  expect(onHumanInput).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledTimes(2);
  await worker.close();
});
it('retains the successful cursor and old checkpoint when an overlap request is challenged', async () => {
  let submissions = 0;
  const f = fake(async url => url.pathname === '/submissions' && ++submissions > 1 ? html(fixture('challenge'), url, 403) : normal(url));
  const worker = createQojReadWorker(f.options);
  const checkpoint = { version: 1, data: { account: 'sample_person', parser: 'qoj-html-1', headId: '9000002' } };
  const result = await worker.execute({ ...job, checkpoint }, new AbortController().signal);
  expect(result).toMatchObject({ status: 'human_input_required', pages: 1, historyComplete: false, stopReason: 'more', cursor: { version: 1, data: { page: 2 } }, checkpoint, lastResponse: { status: 403, finalUrl: 'https://qoj.ac/submissions?submitter=sample_person', bodySource: 'response-html', headers: { 'content-type': 'text/html' } } });
  await worker.close();
});
it('does not accept human confirmation as proof that the challenge has cleared', async () => {
  const f = fake(async url => html(fixture('challenge'), url));
  const onHumanInput = vi.fn(async () => true);
  const worker = createQojReadWorker({ ...f.options, onHumanInput, humanRetries: 2 });
  expect(await worker.execute(job, new AbortController().signal)).toMatchObject({ status: 'human_input_required', pages: 0, checkpoint: null, historyComplete: false });
  expect(onHumanInput).toHaveBeenCalledTimes(2);
  await worker.close();
});
it('classifies an expired session separately and validates collecting identity after manual login', async () => {
  let loggedIn = false;
  const f = fake(async url => loggedIn ? normal(url) : html(fixture('login'), url));
  const worker = createQojReadWorker({ ...f.options, expectedLoginHandle: 'different_collector', onHumanInput: async input => { expect(input.kind).toBe('login'); loggedIn = true; return true; } });
  expect(await worker.execute(job, new AbortController().signal)).toMatchObject({ status: 'auth_required', pages: 0, code: 'AUTH_REQUIRED' });
  await worker.close();
});
it('bounds manual waiting even when an operator callback fails to respond', async () => {
  const f = fake(async url => html(fixture('challenge'), url));
  const worker = createQojReadWorker({ ...f.options, humanTimeoutMs: 25, onHumanInput: async () => new Promise(() => undefined) });
  expect(await worker.execute(job, new AbortController().signal)).toMatchObject({ status: 'human_input_required', code: 'TIMEOUT', cursor: null });
  expect(f.runtime.cancelPage).toHaveBeenCalledOnce();
  await worker.close();
});
it('cancels a queued waiter without closing the owner, then reuses one context for the next job', async () => {
  let challenged = true;
  let finish!: (confirmed: boolean) => void;
  const f = fake(async url => challenged ? html(fixture('challenge'), url) : normal(url));
  const worker = createQojReadWorker({ ...f.options, onHumanInput: async () => new Promise(resolve => { finish = resolve; }) });
  const ownerController = new AbortController();
  const owner = worker.execute(job, ownerController.signal);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const waiterController = new AbortController();
  const waiter = worker.execute(job, waiterController.signal);
  waiterController.abort();
  expect(await waiter).toMatchObject({ status: 'cancelled' });
  expect(f.runtime.close).not.toHaveBeenCalled();
  expect(f.runtime.cancelPage).not.toHaveBeenCalled();
  ownerController.abort();
  expect(await owner).toMatchObject({ status: 'cancelled', historyComplete: false });
  challenged = false;
  finish(true); // A late confirmation must not resurrect the cancelled scan.
  expect(await worker.execute(job, new AbortController().signal)).toMatchObject({ status: 'completed', pages: 2 });
  expect(f.factory).toHaveBeenCalledOnce();
  await worker.close();
  expect(f.runtime.close).toHaveBeenCalledOnce();
});
it.each([['permission', 'restricted'], ['changed', 'parse_changed']])('does not report history_end for %s', async (page, status) => {
  const f = fake(async url => url.pathname.startsWith('/user/') ? normal(url) : html(fixture(page), url));
  const worker = createQojReadWorker(f.options);
  expect(await worker.execute(job, new AbortController().signal)).toMatchObject({ status, pages: 0, historyComplete: false });
  await worker.close();
});
it('uses the configured Node adapter and rejects secret fields in job payloads', async () => {
  const factory = vi.fn(async () => ({ signal: new AbortController().signal, session: null, request: normal }));
  const f = fake(normal);
  const worker = createQojReadWorker({ ...f.options, transport: 'node', nodeFactory: factory });
  expect(await worker.execute(job, new AbortController().signal)).toMatchObject({ status: 'completed', pages: 2 });
  expect(f.factory).not.toHaveBeenCalled();
  expect(() => qojReadJobSchema.parse({ ...job, cookie: 'not-permitted' })).toThrow();
  await worker.close();
});
it('preserves HTTP timeout classification without claiming a human challenge', async () => {
  const f = fake(async () => { throw new ConnectorError('TIMEOUT', 'HTTP timeout'); });
  const worker = createQojReadWorker(f.options);
  expect(await worker.execute(job, new AbortController().signal)).toMatchObject({ status: 'timeout', code: 'TIMEOUT', pages: 0 });
  await worker.close();
});
