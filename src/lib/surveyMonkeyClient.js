/**
 * surveyMonkeyClient.js
 *
 * Thin wrapper over the SurveyMonkey v3 REST API.
 *
 * Important, verified fact about SurveyMonkey's OAuth implementation:
 * access tokens obtained via the three-step OAuth flow are long-lived and
 * do not currently expire on a fixed schedule (per SurveyMonkey's own API
 * docs). There is no refresh_token grant in their public API. This means:
 *   - We do NOT attempt silent token refresh.
 *   - A 401 means the token was revoked or deauthorized — this requires a
 *     human to re-run the OAuth setup script (scripts/setupOAuth.js), not
 *     an automated retry.
 *   - A 403 means the token is valid but lacks scope for the requested
 *     resource — this is a configuration problem in the SurveyMonkey
 *     Developer App, not a token lifecycle problem.
 */

const { getSecret } = require('./secretsClient');

const SM_API_BASE_URL = process.env.SM_API_BASE_URL || 'https://api.surveymonkey.com/v3';

// OAuth lives outside the versioned API path, so it is derived separately
// rather than by string-munging SM_API_BASE_URL.
const SM_AUTH_BASE_URL = process.env.SM_AUTH_BASE_URL || 'https://api.surveymonkey.com';
const SM_ACCESS_TOKEN_SECRET_NAME =
  process.env.SM_ACCESS_TOKEN_SECRET_NAME || 'surveymonkey-access-token';

class SurveyMonkeyAuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'SurveyMonkeyAuthError';
    this.statusCode = statusCode;
  }
}

class SurveyMonkeyScopeError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'SurveyMonkeyScopeError';
    this.statusCode = statusCode;
  }
}

class SurveyMonkeyRateLimitError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = 'SurveyMonkeyRateLimitError';
    this.statusCode = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// --- retry -----------------------------------------------------------------

/**
 * SurveyMonkey enforces per-minute and per-day request quotas and answers 429
 * when either is exceeded. A sync of a large survey is many paginated calls,
 * so brushing the per-minute limit partway through is an ordinary event, not
 * an exceptional one — without a retry, a single 429 abandons the whole sync
 * and leaves the data half-fetched.
 *
 * Retries cover 429 and 5xx only. A 4xx other than 429 means the request
 * itself is wrong (bad token, missing scope, unknown survey) and repeating it
 * would only burn more quota.
 */
const MAX_RETRIES = Number(process.env.SM_MAX_RETRIES) || 4;
const MAX_RETRY_DELAY_MS = Number(process.env.SM_MAX_RETRY_DELAY_MS) || 60_000;
const BASE_RETRY_DELAY_MS = Number(process.env.SM_BASE_RETRY_DELAY_MS) || 1_000;

// Test seam: swapped out so retry behaviour can be asserted without waiting.
let sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before the next attempt.
 *
 * SurveyMonkey's own Retry-After is authoritative when present, in either
 * accepted form (delay-seconds or an HTTP date). Otherwise exponential
 * backoff, with jitter so several surveys syncing in the same run do not all
 * retry on the same tick and re-collide.
 */
function retryDelayMs(response, attempt, now = Date.now()) {
  const header = response && response.headers && response.headers.get('retry-after');

  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }

    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(asDate - now, 0), MAX_RETRY_DELAY_MS);
    }
  }

  const backoff = BASE_RETRY_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_RETRY_DELAY_MS * 0.25;
  return Math.min(backoff + jitter, MAX_RETRY_DELAY_MS);
}

function isRetryable(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * fetch with retry on transient failures. Returns the final response; the
 * caller still interprets the status, so a 429 that outlives its retries
 * surfaces as a typed error rather than being swallowed here.
 */
async function fetchWithRetry(url, options = {}) {
  let attempt = 0;

  for (;;) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      // A transport failure (DNS, reset connection) is worth retrying on the
      // same schedule; the request never reached SurveyMonkey.
      if (attempt >= MAX_RETRIES) throw err;
      await sleepImpl(retryDelayMs(null, attempt));
      attempt += 1;
      continue;
    }

    if (!isRetryable(response.status) || attempt >= MAX_RETRIES) return response;

    await sleepImpl(retryDelayMs(response, attempt));
    attempt += 1;
  }
}

/** Raises the typed error for a response that is still 429 after retrying. */
function throwIfRateLimited(response, path) {
  if (response.status !== 429) return;

  const header = response.headers.get('retry-after');
  const seconds = Number(header);

  throw new SurveyMonkeyRateLimitError(
    `SurveyMonkey rate limit reached on ${path} and still limited after ${MAX_RETRIES} ` +
      'retries. This usually means the daily request quota is exhausted rather than a ' +
      'momentary burst. Narrow SYNC_SURVEY_IDS or reduce the sync frequency.',
    Number.isFinite(seconds) ? seconds : undefined
  );
}

async function getAccessToken() {
  return getSecret(SM_ACCESS_TOKEN_SECRET_NAME);
}

/**
 * Low-level authenticated GET against the SurveyMonkey API.
 * Throws typed errors for 401/403 so callers can branch on them without
 * inspecting status codes everywhere.
 */
async function smGet(path, { params } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${SM_API_BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }
  }

  const response = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 401) {
    throw new SurveyMonkeyAuthError(
      'SurveyMonkey rejected the access token (401). The token has likely ' +
        'been revoked or the app deauthorized. Re-run scripts/setupOAuth.js ' +
        'to re-authorize — this cannot be resolved automatically because ' +
        'SurveyMonkey does not issue refresh tokens.',
      401
    );
  }

  if (response.status === 403) {
    throw new SurveyMonkeyScopeError(
      'SurveyMonkey rejected the request due to insufficient scope (403). ' +
        'Check the SurveyMonkey Developer App permissions for this token.',
      403
    );
  }

  throwIfRateLimited(response, path);

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(
      `SurveyMonkey API error ${response.status} on ${path}: ${bodyText.slice(0, 200)}`
    );
  }

  return response.json();
}

/**
 * Paginate through a SurveyMonkey list endpoint, following `links.next`.
 * SurveyMonkey returns absolute URLs in `links.next`, already including
 * query params, so subsequent requests pass no params.
 */
async function getAllPages(path, { params, maxPages = 200 } = {}) {
  const results = [];
  let nextUrl = null;
  let pageCount = 0;
  let currentParams = params;

  do {
    const body = nextUrl
      ? await smGetAbsolute(nextUrl)
      : await smGet(path, { params: currentParams });

    results.push(...(body.data || []));
    nextUrl = body.links && body.links.next;
    currentParams = undefined;
    pageCount += 1;
  } while (nextUrl && pageCount < maxPages);

  return results;
}

async function smGetAbsolute(absoluteUrl) {
  const token = await getAccessToken();
  const response = await fetchWithRetry(absoluteUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (response.status === 401) {
    throw new SurveyMonkeyAuthError('SurveyMonkey rejected the access token (401) during pagination.', 401);
  }
  if (response.status === 403) {
    throw new SurveyMonkeyScopeError('SurveyMonkey rejected pagination request due to scope (403).', 403);
  }

  // Rate limiting is likeliest deep into pagination, which is exactly where
  // losing the run costs the most.
  throwIfRateLimited(response, absoluteUrl);

  if (!response.ok) {
    throw new Error(`SurveyMonkey API error ${response.status} during pagination of ${absoluteUrl}`);
  }
  return response.json();
}

/** GET /surveys — list all surveys visible to this token. */
async function listSurveys() {
  return getAllPages('/surveys', { params: { per_page: 100 } });
}

/** GET /surveys/{id}/details — full question/choice tree for a survey. */
async function getSurveyDetails(surveyId) {
  return smGet(`/surveys/${surveyId}/details`);
}

/** GET /collectors for a survey. */
async function listCollectors(surveyId) {
  return getAllPages(`/surveys/${surveyId}/collectors`, { params: { per_page: 100 } });
}

/**
 * GET /surveys/{id}/responses/bulk — paginated, optionally filtered by
 * modification date for incremental pulls.
 * @param {string} surveyId
 * @param {object} opts
 * @param {Date} [opts.modifiedSince] - only responses modified on/after this date
 * @param {string} [opts.status='completed'] - response status filter. Pass
 *   'all' to include partial responses, which SurveyMonkey expresses as
 *   omitting the filter entirely.
 */
async function getResponsesBulk(surveyId, { modifiedSince, status = 'completed' } = {}) {
  const params = { per_page: 100 };
  if (status && status !== 'all') {
    params.status = status;
  }
  if (modifiedSince) {
    params.start_modified_at = modifiedSince.toISOString();
  }
  return getAllPages(`/surveys/${surveyId}/responses/bulk`, { params });
}

/**
 * Checks a token by calling GET /users/me with it.
 *
 * Takes the token as an argument rather than reading it from the secret
 * store, because the setup flow has to validate a token *before* deciding to
 * store it. Returns account details on success so the wizard can show the
 * user which SurveyMonkey account they just connected — a useful confirmation
 * when someone has several.
 *
 * @param {string} token
 * @returns {Promise<{valid: boolean, account?: object, status?: number, message?: string}>}
 */
async function validateToken(token) {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return { valid: false, status: 400, message: 'No token was provided.' };
  }

  let response;
  try {
    response = await fetch(`${SM_API_BASE_URL}/users/me`, {
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' },
    });
  } catch (err) {
    return { valid: false, status: 502, message: `Could not reach SurveyMonkey: ${err.message}` };
  }

  if (response.status === 401) {
    return {
      valid: false,
      status: 401,
      message:
        'SurveyMonkey rejected this token (401). Check you copied the whole access token ' +
        'from your Developer App, and that the app has not been deauthorized.',
    };
  }

  if (response.status === 403) {
    return {
      valid: false,
      status: 403,
      message:
        'The token was accepted but lacks the required scopes (403). Grant the app ' +
        '"View Surveys" and "View Responses" permissions, then issue a new token.',
    };
  }

  if (!response.ok) {
    return {
      valid: false,
      status: response.status,
      message: `SurveyMonkey returned ${response.status} when checking the token.`,
    };
  }

  const body = await response.json().catch(() => ({}));
  return {
    valid: true,
    account: {
      id: body.id || null,
      username: body.username || null,
      email: body.email || null,
      account_type: body.account_type || null,
    },
  };
}

/**
 * Exchanges an OAuth authorization code for an access token.
 *
 * SurveyMonkey issues no refresh token, so what comes back is a long-lived
 * access token and this exchange is the only way to obtain one
 * programmatically. The authorization code expires after a few minutes.
 */
async function exchangeCodeForToken({ clientId, clientSecret, redirectUri, code }) {
  const response = await fetch(`${SM_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
    }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.access_token) {
    const err = new Error(
      body.error_description ||
        body.error ||
        `SurveyMonkey rejected the authorization code (${response.status}).`
    );
    err.name = 'OAuthExchangeError';
    err.statusCode = response.status;
    throw err;
  }

  return body.access_token;
}

/** Builds the URL the user visits to authorize the app. */
function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(`${SM_AUTH_BASE_URL}/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** Test seam: replaces the retry sleep so tests do not wait in real time. */
function _setSleepForTests(fn) {
  sleepImpl = fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

module.exports = {
  listSurveys,
  getSurveyDetails,
  listCollectors,
  getResponsesBulk,
  validateToken,
  exchangeCodeForToken,
  buildAuthorizeUrl,
  SurveyMonkeyAuthError,
  SurveyMonkeyScopeError,
  SurveyMonkeyRateLimitError,
  retryDelayMs,
  isRetryable,
  fetchWithRetry,
  MAX_RETRIES,
  _setSleepForTests,
};
