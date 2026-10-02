import { z } from 'zod';
import { ConnectorError, type AccountRef } from '../contracts/index';
import { assertHtml, ORIGIN, siteUrl } from './http';

export const PARSER_VERSION = 'qoj-html-1';
const utc = z.iso.datetime();
function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ConnectorError('PARSE_CHANGED', 'QOJ normalized record failed schema validation');
  return result.data;
}
export const accountSchema = z.object({ platform: z.literal('qoj'), kind: z.enum(['person', 'team']), handle: z.string().min(1), externalId: z.null() });
const problemSchema = z.object({ platform: z.literal('qoj'), problemKey: z.string().regex(/^\d+$/), title: z.string().min(1), nativeDifficulty: z.null(), sourceUrl: z.url(), parserVersion: z.literal(PARSER_VERSION), observedAt: utc });
const submissionSchema = z.object({
  platform: z.literal('qoj'), externalSubmissionId: z.string().regex(/^\d+$/), problemKey: z.string().regex(/^\d+$/), submittedAt: utc,
  verdict: z.enum(['accepted', 'rejected', 'pending', 'unknown']), nativeScore: z.number().finite().nullable(), nativeResult: z.string().min(1), sourceUrl: z.url(),
  subjectEvidence: z.object({ authorAccountKeys: z.array(z.string()).length(1), contestId: z.string().optional() }), parserVersion: z.literal(PARSER_VERSION), observedAt: utc,
});

export function parseAccount(html: string, requested: string): AccountRef {
  const $ = assertHtml(html);
  const heading = $('h2 .uoj-username');
  if (heading.length !== 1 || !/User profile|Team profile/.test($('.card-header').text())) {
    throw new ConnectorError('PARSE_CHANGED', 'QOJ profile identity structure changed');
  }
  const href = heading.attr('href');
  const match = href ? siteUrl(href).pathname.match(/^\/user\/profile\/([^/]+)$/) : null;
  const handle = match ? decodeURIComponent(match[1]!) : heading.text().trim();
  if ($('h2 .uoj-favourite-block[data-type=U]').attr('data-id') !== handle) throw new ConnectorError('PARSE_CHANGED', 'QOJ profile handle evidence missing');
  // No assumed case folding, stable UID or alias merging.
  if (handle !== requested) throw new ConnectorError('PARSE_CHANGED', 'QOJ profile identity differs from requested account');
  const team = $('h4').toArray().some(e => /^Team Members\b/i.test($(e).text().trim()));
  if (!team && !$('h4').toArray().some(e => /^Usergroup\b/.test($(e).text().trim()))) {
    throw new ConnectorError('PARSE_CHANGED', 'QOJ account kind cannot be established');
  }
  return accountSchema.parse({ platform: 'qoj', kind: team ? 'team' : 'person', handle, externalId: null });
}

export function parseSubmissionHtml(html: string, account: AccountRef, page: number, observedAt: string) {
  const $ = assertHtml(html);
  if ($('#input-submitter').attr('value') !== account.handle) throw new ConnectorError('PARSE_CHANGED', 'QOJ submitter filter mismatch');
  const headers = ['ID', 'Problem', 'Submitter', 'Result', 'Time', 'Memory', 'Language', 'File size', 'Submit time'];
  const table = $('table').filter((_, e) => $(e).find('thead th').map((_, t) => $(t).text().trim()).get().join('|') === headers.join('|'));
  if (table.length !== 1) throw new ConnectorError('PARSE_CHANGED', 'QOJ submissions table headers changed');
  const pager = $('.pagination');
  const active = pager.find('.active a').text().trim();
  if (pager.length !== 1 || active !== String(page)) throw new ConnectorError('PARSE_CHANGED', 'QOJ active page mismatch');
  const forward = pager.find('li').filter((_, e) => $(e).find('.glyphicon-forward').length > 0);
  if (forward.length !== 1) throw new ConnectorError('PARSE_CHANGED', 'QOJ next-page control missing');
  const terminal = forward.hasClass('disabled');
  const nextHref = forward.find('a').attr('href');
  if (!terminal) {
    const next = siteUrl(nextHref);
    if (!nextHref || next.pathname !== '/submissions' || next.searchParams.get('submitter') !== account.handle || next.searchParams.get('page') !== String(page + 1)) {
      throw new ConnectorError('PARSE_CHANGED', 'QOJ pagination target changed');
    }
  } else if (nextHref) throw new ConnectorError('PARSE_CHANGED', 'Contradictory QOJ terminal page');
  const problems = new Map<string, z.infer<typeof problemSchema>>();
  const submissions: z.infer<typeof submissionSchema>[] = [];
  const rows = table.find('tbody tr');
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    // A known full-width empty row must be checked separately, never ignore arbitrary rows.
    if (cells.length === 1 && cells.attr('colspan') === '9' && /^(No submissions|No data|无提交记录)\.?$/i.test(cells.text().trim())) continue;
    if (cells.length !== headers.length) throw new ConnectorError('PARSE_CHANGED', 'QOJ submission row fields changed');
    const submissionUrl = siteUrl(cells.eq(0).find('a').attr('href'));
    const id = submissionUrl.pathname.match(/^\/submission\/(\d+)$/)?.[1];
    const problemUrl = siteUrl(cells.eq(1).find('a').attr('href'));
    const problemMatch = problemUrl.pathname.match(/^\/(?:contest\/(\d+)\/)?problem\/(\d+)$/);
    const authors = cells.eq(2).find('.uoj-username');
    const authorHref = authors.attr('href');
    const author = authorHref ? siteUrl(authorHref).pathname : null;
    if (authors.length !== 1 || (author ? author !== `/user/profile/${encodeURIComponent(account.handle)}` : authors.text().trim() !== account.handle || authors.attr('data-nickname') === undefined)) throw new ConnectorError('PARSE_CHANGED', 'QOJ row belongs to another submitter');
    const time = cells.eq(8).find('time').attr('datetime');
    if (!id || !problemMatch || !time || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(time) || !Number.isFinite(Date.parse(time))) {
      throw new ConnectorError('PARSE_CHANGED', 'QOJ stable ID or time with timezone missing');
    }
    const result = cells.eq(3).text().trim();
    const scoreText = cells.eq(3).find('.uoj-score').attr('data-score');
    if (scoreText !== undefined && !/^-?\d+(?:\.\d+)?$/.test(scoreText)) throw new ConnectorError('PARSE_CHANGED', 'QOJ score format changed');
    const score = scoreText === undefined ? null : Number(scoreText);
    // Observed QOJ renders a distinct check mark for full acceptance. 100 alone is insufficient.
    const verdict = /^Accepted$/.test(result) || /✓/.test(result) ? 'accepted' : /^(Compile Error|Wrong Answer|Runtime Error|Time Limit Exceeded|Memory Limit Exceeded|Output Limit Exceeded|Judgement Failed)$/.test(result) ? 'rejected' : /^(Judging|Waiting|Pending|Compiling)/i.test(result) ? 'pending' : 'unknown';
    const problemKey = problemMatch[2]!;
    problems.set(problemKey, validated(problemSchema, { platform: 'qoj', problemKey, title: cells.eq(1).text().replace(/^#\d+\.\s*/, '').trim(), nativeDifficulty: null, sourceUrl: `${ORIGIN}/problem/${problemKey}`, parserVersion: PARSER_VERSION, observedAt }));
    // A problem's contest URL alone is not evidence that this submission was in that contest.
    const contestHref = cells.eq(2).find('sup a').attr('href');
    const contestId = contestHref ? siteUrl(contestHref).pathname.match(/^\/contest\/(\d+)$/)?.[1] : undefined;
    if (contestHref && !contestId) throw new ConnectorError('PARSE_CHANGED', 'QOJ submission contest evidence changed');
    submissions.push(validated(submissionSchema, { platform: 'qoj', externalSubmissionId: id, problemKey, submittedAt: new Date(time).toISOString(), verdict, nativeScore: score, nativeResult: result, sourceUrl: submissionUrl.href,
      subjectEvidence: { authorAccountKeys: [account.handle], ...(contestId ? { contestId } : {}) }, parserVersion: PARSER_VERSION, observedAt }));
  }
  if (!submissions.length && !terminal) throw new ConnectorError('PARSE_CHANGED', 'Nonterminal QOJ page is empty');
  if (new Set(submissions.map(s => s.externalSubmissionId)).size !== submissions.length) throw new ConnectorError('PARSE_CHANGED', 'Duplicate QOJ IDs within page');
  for (let i = 1; i < submissions.length; i++) {
    if (BigInt(submissions[i - 1]!.externalSubmissionId) <= BigInt(submissions[i]!.externalSubmissionId)) throw new ConnectorError('PARSE_CHANGED', 'QOJ submission ordering changed');
  }
  return { submissions, problems: [...problems.values()], terminal };
}
