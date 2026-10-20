// Guards of scripts/smoke-live.mjs, kept apart so they are tested without a network.
//
// On 2026-10-16 a request loop helped exhaust the account's Workers request quota (Cloudflare Error 1027, HTTP 429 or a short
// "error code: 1027" page). The smoke is sequential (no Promise.all, no timers, no retry) and sends one request per URL and method;
// these two guards make it stop at once when the edge says it is being rate limited, and bound the total.

// The complete smoke sends 175 requests (104 pages and manifests, 63 export files and parts, the comparison fixture twice,
// 2 redirects, 4 expected 404s). The cap leaves room for a few more files and stops anything unbounded.
export const MAX_REQUESTS = 220;

export class SmokeStop extends Error {}

export function requestBudget(max = MAX_REQUESTS) {
  let sent = 0;
  return { count: () => sent, spend(label) { sent += 1; if (sent > max) throw new SmokeStop(`smoke budget: more than ${max} requests (the next is ${label})`); } };
}

// A response that says the zone or account is being limited: HTTP 429, or a Cloudflare 403/5xx page that names error 1027 or 1015.
export function rateLimitProblem(status, bodyText = '') {
  if (status === 429) return `HTTP 429`;
  if ((status === 403 || status >= 500) && /error code:?\s*10(?:27|15)|Error 10(?:27|15)/i.test(bodyText.slice(0, 4096))) return `HTTP ${status} with a Cloudflare rate-limit error (1027/1015)`;
  return null;
}

export function assertNotRateLimited(url, status, bodyText) {
  const problem = rateLimitProblem(status, bodyText);
  if (problem) throw new SmokeStop(`${url}: ${problem}: stopping the smoke at once, no further request is sent`);
}
