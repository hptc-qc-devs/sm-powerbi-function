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

  const response = await fetch(url.toString(), {
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
  const response = await fetch(absoluteUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (response.status === 401) {
    throw new SurveyMonkeyAuthError('SurveyMonkey rejected the access token (401) during pagination.', 401);
  }
  if (response.status === 403) {
    throw new SurveyMonkeyScopeError('SurveyMonkey rejected pagination request due to scope (403).', 403);
  }
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
 */
async function getResponsesBulk(surveyId, { modifiedSince } = {}) {
  const params = { per_page: 100, status: 'completed' };
  if (modifiedSince) {
    params.start_modified_at = modifiedSince.toISOString();
  }
  return getAllPages(`/surveys/${surveyId}/responses/bulk`, { params });
}

module.exports = {
  listSurveys,
  getSurveyDetails,
  listCollectors,
  getResponsesBulk,
  SurveyMonkeyAuthError,
  SurveyMonkeyScopeError,
};
