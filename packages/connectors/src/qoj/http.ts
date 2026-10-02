import { load } from 'cheerio';
import { ConnectorError, type RequestContext } from '../contracts/index';

export const ORIGIN = 'https://qoj.ac';
function hasChallengeHtml(html: string) {
  const $ = load(html);
  // QOJ's normal pages also contain Cloudflare JavaScript Detections scripts.
  // A /cdn-cgi/challenge-platform/ URL by itself does not indicate an interstitial.
  return /Just a moment|Attention Required/i.test($('title').text()) || $('#challenge-form, #cf-challenge-running, #cf-challenge-body').length > 0;
}
export function isCloudflareChallenge(response: Response, html: string) {
  return response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge' ||
    hasChallengeHtml(html);
}
/** Shared response classification for application-managed human recovery. */
export function qojResponseIssue(response: Response, html: string): 'cloudflare' | 'login' | null {
  if (isCloudflareChallenge(response, html)) return 'cloudflare';
  const location = response.headers.get('location');
  if (response.status === 401 || /\/login(?:[/?]|$)/.test(new URL(response.url || ORIGIN).pathname) ||
      (location && /\/login(?:[/?]|$)/.test(new URL(location, ORIGIN).pathname)) ||
      load(html)('#form-login, input[type=password]').length) return 'login';
  return null;
}
export function assertHtml(html: string) {
  const $ = load(html);
  if (hasChallengeHtml(html)) {
    throw new ConnectorError('CHALLENGE_REQUIRED', 'QOJ Cloudflare requires human browser verification');
  }
  if ($('#form-login, input[type=password]').length) throw new ConnectorError('AUTH_REQUIRED', 'QOJ session expired or login required');
  const message = $('.alert-danger, .uoj-content h2, .uoj-content .card-body').text();
  if (/permission denied|no permission|access denied|not authorized|权限不足|无权访问/i.test(message)) {
    throw new ConnectorError('FORBIDDEN', 'QOJ reports a permission gap');
  }
  return $;
}
export async function getHtml(url: URL, ctx: RequestContext) {
  const response = await ctx.request(url, { redirect: 'manual' });
  const html = await response.text();
  if (isCloudflareChallenge(response, html)) throw new ConnectorError('CHALLENGE_REQUIRED', 'QOJ Cloudflare requires human browser verification', { httpStatus: response.status });
  // Check challenges before treating 403 as a platform permission decision.
  assertHtml(html);
  const location = response.headers.get('location');
  if (location && /\/login(?:[/?]|$)/.test(new URL(location, url).pathname)) {
    throw new ConnectorError('AUTH_REQUIRED', 'QOJ redirects to login');
  }
  if (response.status === 401) throw new ConnectorError('AUTH_REQUIRED', 'QOJ requires login');
  if (response.status === 403) throw new ConnectorError('FORBIDDEN', 'QOJ denies access');
  if (response.status === 404) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'QOJ resource not found');
  if (response.status === 429) throw new ConnectorError('RATE_LIMITED', 'QOJ rate limited the request');
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
    throw new ConnectorError('PARSE_CHANGED', 'Unexpected QOJ response or redirect');
  }
  if (response.url) {
    const final = siteUrl(response.url);
    if (final.pathname !== url.pathname) throw new ConnectorError('PARSE_CHANGED', 'QOJ final document differs from the requested page');
    if (url.pathname === '/submissions') {
      if (final.searchParams.get('submitter') !== url.searchParams.get('submitter') ||
          (final.searchParams.get('page') ?? '1') !== (url.searchParams.get('page') ?? '1') ||
          final.searchParams.getAll('submitter').length !== 1 || final.searchParams.getAll('page').length > 1 ||
          [...final.searchParams.keys()].some(name => !['submitter', 'page'].includes(name))) throw new ConnectorError('PARSE_CHANGED', 'QOJ final submission filters changed');
    }
  }
  return html;
}
export function siteUrl(href: string | undefined) {
  const url = new URL(href || '/', ORIGIN);
  if (url.origin !== ORIGIN) throw new ConnectorError('PARSE_CHANGED', 'Unexpected external link in QOJ record');
  return url;
}
