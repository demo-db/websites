// The guards of the post-deploy smoke: stop at the first rate-limit answer, bound the total, stay sequential.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MAX_REQUESTS, SmokeStop, assertNotRateLimited, rateLimitProblem, requestBudget } from './smoke-guard.mjs';

test('HTTP 429 and a Cloudflare 1027/1015 page stop the smoke; an ordinary 403, 404 or 500 does not look like a rate limit', () => {
  assert.match(rateLimitProblem(429), /429/);
  assert.match(rateLimitProblem(403, 'error code: 1027'), /1027/);
  assert.match(rateLimitProblem(503, '<title>Error 1015</title> You are being rate limited'), /1015/);
  assert.match(rateLimitProblem(500, 'Error 1027: This Worker exceeded the request limit'), /1027/);
  assert.equal(rateLimitProblem(404, 'error code: 1027'), null, 'a missing file stays a missing file');
  assert.equal(rateLimitProblem(403, 'Forbidden'), null);
  assert.equal(rateLimitProblem(200, 'error code: 1027 in the text of a page'), null);
  assert.throws(() => assertNotRateLimited('https://x.demodb.dev/', 429, ''), SmokeStop);
  assert.doesNotThrow(() => assertNotRateLimited('https://x.demodb.dev/', 200, 'ok'));
});

test('the request budget stops the run at the first request over the cap', () => {
  const budget = requestBudget(3);
  for (const url of ['a', 'b', 'c']) budget.spend(url);
  assert.equal(budget.count(), 3);
  assert.throws(() => budget.spend('d'), /more than 3 requests/);
  assert.ok(MAX_REQUESTS >= 175 && MAX_REQUESTS <= 300, 'the cap leaves room for the 175 requests of a full run and nothing unbounded');
});

test('smoke-live.mjs is sequential, has no retry or timer, and uses the guards on every kind of response', async () => {
  const source = await readFile(new URL('./smoke-live.mjs', import.meta.url), 'utf8');
  assert.ok(!/Promise\.(all|allSettled|race|any)\b|setTimeout|setInterval|\bretry\b\s*\(|for await/.test(source.replace(/\/\/.*$/gm, '')), 'no concurrency, timer or retry');
  assert.ok(source.includes("from './smoke-guard.mjs'") && source.includes('budget.spend(key)'));
  assert.equal((source.match(/assertNotRateLimited\(/g) ?? []).length, 5, 'pages, downloads, redirects, 404 checks and HEAD all go through the guard');
  assert.match(source, /'\/data\/adventureworks\.sqlserver\.sql', '\/data\/adventureworks\.oracle\.sql'/, 'the single URLs of the chunked scripts must answer 404');
});
