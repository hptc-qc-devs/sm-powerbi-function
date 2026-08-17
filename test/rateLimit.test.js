/**
 * Tests the retry layer in front of the SurveyMonkey API.
 *
 * Rate limiting is not an exceptional case for this connector — a large
 * survey is many paginated calls, so brushing the per-minute quota partway
 * through a sync is ordinary. Without a retry, one 429 abandons the run and
 * leaves the dataset half-fetched, which is exactly the failure the storage
 * layer exists to prevent.
 *
 * The sleep is stubbed out, so these assert the retry *schedule* without
 * spending it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const smClient = require('../src/lib/surveyMonkeyClient');
const {
  retryDelayMs,
  isRetryable,
  fetchWithRetry,
  MAX_RETRIES,
  _setSleepForTests,
} = smClient;

// Record what we would have waited instead of waiting.
let slept = [];
_setSleepForTests(async (ms) => {
  slept.push(ms);
});

const headers = (map = {}) => ({
  get: (name) => {
    const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? map[key] : null;
  },
});

const response = (status, headerMap) => ({ status, ok: status < 400, headers: headers(headerMap) });

function reset() {
  slept = [];
}

// --- what is worth retrying ------------------------------------------------

test('429 and 5xx are retried; other 4xx are not', () => {
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(500), true);
  assert.equal(isRetryable(503), true);

  // Repeating these would only burn more quota — the request itself is wrong.
  assert.equal(isRetryable(400), false);
  assert.equal(isRetryable(401), false);
  assert.equal(isRetryable(403), false);
  assert.equal(isRetryable(404), false);
  assert.equal(isRetryable(200), false);
});

// --- how long to wait ------------------------------------------------------

test("SurveyMonkey's Retry-After in seconds is honoured exactly", () => {
  assert.equal(retryDelayMs(response(429, { 'Retry-After': '30' }), 0), 30_000);
});

test('Retry-After as an HTTP date is converted to a delay', () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const at = new Date(now + 20_000).toUTCString();

  const delay = retryDelayMs(response(429, { 'Retry-After': at }), 0, now);
  assert.ok(delay >= 19_000 && delay <= 20_000, `expected ~20s, got ${delay}`);
});

test('a Retry-After date already in the past waits zero rather than negative', () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const past = new Date(now - 60_000).toUTCString();

  assert.equal(retryDelayMs(response(429, { 'Retry-After': past }), 0, now), 0);
});

test('an absurd Retry-After is capped rather than parking the sync for hours', () => {
  assert.equal(retryDelayMs(response(429, { 'Retry-After': '99999' }), 0), 60_000);
});

test('a nonsense Retry-After falls back to backoff instead of NaN', () => {
  const delay = retryDelayMs(response(429, { 'Retry-After': 'soon' }), 0);
  assert.ok(Number.isFinite(delay) && delay > 0);
});

test('backoff grows exponentially when no Retry-After is given', () => {
  const first = retryDelayMs(response(429), 0);
  const second = retryDelayMs(response(429), 1);
  const third = retryDelayMs(response(429), 2);

  assert.ok(first >= 1000 && first < 1500);
  assert.ok(second >= 2000 && second < 2500);
  assert.ok(third >= 4000 && third < 4500);
});

test('backoff is jittered so parallel surveys do not re-collide', () => {
  const delays = new Set(Array.from({ length: 20 }, () => retryDelayMs(response(429), 1)));
  assert.ok(delays.size > 1, 'identical delays would resynchronize every caller');
});

test('backoff is capped', () => {
  assert.equal(retryDelayMs(response(429), 40), 60_000);
});

// --- the retry loop --------------------------------------------------------

test('a 429 followed by success returns the success', async () => {
  reset();

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1 ? response(429, { 'Retry-After': '2' }) : response(200);
  };

  const result = await fetchWithRetry('https://example.test/limited-once');
  global.fetch = originalFetch;

  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(slept, [2000], "the server's own Retry-After was used");
});

test('retries stop at the configured maximum and return the last response', async () => {
  reset();

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return response(429, { 'Retry-After': '1' });
  };

  const result = await fetchWithRetry('https://example.test/limited');
  global.fetch = originalFetch;

  assert.equal(result.status, 429);
  assert.equal(calls, MAX_RETRIES + 1, 'one initial attempt plus each retry');
  assert.equal(slept.length, MAX_RETRIES);
});

test('a transient 500 that recovers is retried and succeeds', async () => {
  reset();

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls < 3 ? response(500) : response(200);
  };

  const result = await fetchWithRetry('https://example.test/flaky');
  global.fetch = originalFetch;

  assert.equal(result.status, 200);
  assert.equal(calls, 3);
  assert.equal(slept.length, 2);
});

test('a 403 is returned immediately without retrying', async () => {
  reset();

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return response(403);
  };

  const result = await fetchWithRetry('https://example.test/forbidden');
  global.fetch = originalFetch;

  assert.equal(result.status, 403);
  assert.equal(calls, 1);
  assert.equal(slept.length, 0, 'a scope problem will not fix itself by waiting');
});

test('a network failure is retried, then rethrown if it never recovers', async () => {
  reset();

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  };

  await assert.rejects(() => fetchWithRetry('https://example.test/down'), /ECONNRESET/);
  global.fetch = originalFetch;

  assert.equal(calls, MAX_RETRIES + 1);
});

test('a network failure that recovers returns the eventual response', async () => {
  reset();

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('ECONNRESET');
    return response(200);
  };

  const result = await fetchWithRetry('https://example.test/recovers');
  global.fetch = originalFetch;

  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});
