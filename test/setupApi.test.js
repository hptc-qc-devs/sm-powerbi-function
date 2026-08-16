/**
 * Tests the setup API by capturing handlers at registration and calling them
 * directly, as with getData.test.js.
 *
 * The OAuth tests carry most of the weight here. The callback endpoint is
 * anonymous by necessity — SurveyMonkey redirects a browser to it and cannot
 * attach a function key — so the `state` parameter is the only thing standing
 * between it and the open internet. These assert that it is required,
 * single-use, expiring, and that failures leak nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const azureFunctions = require('@azure/functions');
const handlers = {};
azureFunctions.app.http = (name, config) => {
  handlers[name] = config.handler;
};
azureFunctions.app.timer = () => {};

const blobStore = require('../src/lib/blobStore');
const secretsClient = require('../src/lib/secretsClient');
const smClient = require('../src/lib/surveyMonkeyClient');

// --- fakes -----------------------------------------------------------------

const store = new Map();
const secrets = new Map();

let storageFails = false;
let secretWriteFails = false;
let validateImpl = async () => ({ valid: true, account: { id: '1', username: 'demo' } });
let listSurveysImpl = async () => [];
let exchangeImpl = async () => 'new-token';

const guard = () => {
  if (storageFails) throw new Error('storage down');
};

blobStore.ensureContainer = async () => guard();
blobStore.readJson = async (p) => (guard(), store.has(p) ? JSON.parse(store.get(p)) : null);
blobStore.writeJson = async (p, v) => (guard(), void store.set(p, JSON.stringify(v)));
blobStore.deleteBlob = async (p) => (guard(), void store.delete(p));
blobStore.listSnapshotDates = async () => (guard(), ['2025-06-30']);

secretsClient.getSecret = async (name) => {
  if (!secrets.has(name)) throw new Error(`secret ${name} not found`);
  return secrets.get(name);
};
secretsClient.setSecret = async (name, value) => {
  if (secretWriteFails) throw new Error('cannot write secret');
  secrets.set(name, value);
};

smClient.validateToken = async (t) => validateImpl(t);
smClient.listSurveys = async () => listSurveysImpl();
smClient.exchangeCodeForToken = async (args) => exchangeImpl(args);

require('../src/functions/setup/status');
require('../src/functions/setup/token');
require('../src/functions/setup/oauth');
require('../src/functions/setup/surveys');
require('../src/functions/setup/syncConfig');
require('../src/functions/setup/connectionInfo');

const context = { log() {}, warn() {}, error() {} };

function req({ method = 'GET', query = {}, body, headers = {} } = {}) {
  return {
    method,
    params: {},
    url: 'https://app.azurewebsites.net/api/setup/x',
    query: { get: (k) => (k in query ? query[k] : null) },
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  };
}

const TOKEN_SECRET = 'surveymonkey-access-token';

function reset() {
  store.clear();
  secrets.clear();
  storageFails = false;
  secretWriteFails = false;
  validateImpl = async () => ({ valid: true, account: { id: '1', username: 'demo' } });
  listSurveysImpl = async () => [];
  exchangeImpl = async () => 'new-token';
  for (const k of ['SYNC_SURVEY_IDS', 'SYNC_HISTORY_ENABLED', 'SYNC_SCHEDULE']) delete process.env[k];
}

// --- status ----------------------------------------------------------------

test('status reports each check separately and names the next step', async () => {
  reset();
  const res = await handlers.setupStatus(req(), context);

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.ready, false);
  assert.equal(res.jsonBody.checks.tokenStored, false);
  assert.equal(res.jsonBody.checks.storageReachable, true);
  assert.equal(res.jsonBody.next_step, 'store_token');
});

test('status reports ready once a valid token and storage are in place', async () => {
  reset();
  secrets.set(TOKEN_SECRET, 'good-token');

  const res = await handlers.setupStatus(req(), context);

  assert.equal(res.jsonBody.ready, true);
  assert.equal(res.jsonBody.checks.tokenValid, true);
  assert.equal(res.jsonBody.account.username, 'demo');
  assert.equal(res.jsonBody.next_step, 'choose_surveys');
});

test('a stored but rejected token asks for reauthorization, not another paste', async () => {
  reset();
  secrets.set(TOKEN_SECRET, 'revoked');
  validateImpl = async () => ({ valid: false, status: 401, message: 'revoked' });

  const res = await handlers.setupStatus(req(), context);

  assert.equal(res.jsonBody.checks.tokenStored, true);
  assert.equal(res.jsonBody.checks.tokenValid, false);
  assert.equal(res.jsonBody.next_step, 'reauthorize');
});

test('status still answers when storage is down, and says storage is the problem', async () => {
  reset();
  secrets.set(TOKEN_SECRET, 'good-token');
  storageFails = true;

  const res = await handlers.setupStatus(req(), context);

  assert.equal(res.status, 200, 'a diagnostic endpoint must not fail when a check fails');
  assert.equal(res.jsonBody.checks.storageReachable, false);
  assert.equal(res.jsonBody.next_step, 'fix_storage');
});

test('status never returns the token itself', async () => {
  reset();
  secrets.set(TOKEN_SECRET, 'super-secret-token');

  const res = await handlers.setupStatus(req(), context);
  assert.ok(!JSON.stringify(res.jsonBody).includes('super-secret-token'));
});

// --- token paste -----------------------------------------------------------

test('a valid token is validated then stored', async () => {
  reset();
  const res = await handlers.setupToken(
    req({ method: 'POST', body: { token: 'good-token' } }),
    context
  );

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.stored, true);
  assert.equal(secrets.get(TOKEN_SECRET), 'good-token');
});

test('an invalid token is rejected and never stored', async () => {
  reset();
  validateImpl = async () => ({ valid: false, status: 401, message: 'SurveyMonkey said no' });

  const res = await handlers.setupToken(
    req({ method: 'POST', body: { token: 'bad-token' } }),
    context
  );

  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.stored, false);
  assert.equal(secrets.has(TOKEN_SECRET), false, 'a known-bad token must not be persisted');
});

test('a token is trimmed before use', async () => {
  reset();
  await handlers.setupToken(req({ method: 'POST', body: { token: '  padded  ' } }), context);
  assert.equal(secrets.get(TOKEN_SECRET), 'padded');
});

test('a missing or blank token is a 400', async () => {
  reset();
  for (const body of [{}, { token: '' }, { token: '   ' }, { token: 42 }]) {
    const res = await handlers.setupToken(req({ method: 'POST', body }), context);
    assert.equal(res.status, 400);
  }
});

test('a malformed request body is a 400, not a crash', async () => {
  reset();
  const res = await handlers.setupToken(req({ method: 'POST' }), context);
  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.error, 'invalid_body');
});

test('a secret-store failure is reported as such, not as a bad token', async () => {
  reset();
  secretWriteFails = true;

  const res = await handlers.setupToken(
    req({ method: 'POST', body: { token: 'good-token' } }),
    context
  );

  assert.equal(res.status, 502);
  assert.equal(res.jsonBody.error, 'store_failed');
});

test('the token is never echoed back in the response', async () => {
  reset();
  const res = await handlers.setupToken(
    req({ method: 'POST', body: { token: 'super-secret-token' } }),
    context
  );
  assert.ok(!JSON.stringify(res.jsonBody).includes('super-secret-token'));
});

// --- OAuth start -----------------------------------------------------------

const startBody = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://app.azurewebsites.net/api/setup/oauth/callback',
};

test('starting OAuth stores credentials and returns an authorize URL', async () => {
  reset();
  const res = await handlers.setupOAuthStart(req({ method: 'POST', body: startBody }), context);

  assert.equal(res.status, 200);
  assert.match(res.jsonBody.authorize_url, /^https:\/\/api\.surveymonkey\.com\/oauth\/authorize\?/);
  assert.match(res.jsonBody.authorize_url, /client_id=cid/);
  assert.match(res.jsonBody.authorize_url, /state=[a-f0-9]{64}/);
  assert.equal(secrets.get('surveymonkey-client-secret'), 'csecret');
});

test('the client secret is never returned to the caller', async () => {
  reset();
  const res = await handlers.setupOAuthStart(req({ method: 'POST', body: startBody }), context);
  assert.ok(!JSON.stringify(res.jsonBody).includes('csecret'));
});

test('each start mints a different state', async () => {
  reset();
  const a = await handlers.setupOAuthStart(req({ method: 'POST', body: startBody }), context);
  const b = await handlers.setupOAuthStart(req({ method: 'POST', body: startBody }), context);

  const stateOf = (r) => new URL(r.jsonBody.authorize_url).searchParams.get('state');
  assert.notEqual(stateOf(a), stateOf(b));
});

test('missing fields are named in the error', async () => {
  reset();
  const res = await handlers.setupOAuthStart(
    req({ method: 'POST', body: { clientId: 'cid' } }),
    context
  );

  assert.equal(res.status, 400);
  assert.match(res.jsonBody.message, /clientSecret/);
  assert.match(res.jsonBody.message, /redirectUri/);
});

test('a non-https redirect URI is rejected, except on localhost', async () => {
  reset();

  const insecure = await handlers.setupOAuthStart(
    req({ method: 'POST', body: { ...startBody, redirectUri: 'http://evil.example.com/cb' } }),
    context
  );
  assert.equal(insecure.status, 400);
  assert.equal(insecure.jsonBody.error, 'invalid_redirect_uri');

  const local = await handlers.setupOAuthStart(
    req({
      method: 'POST',
      body: { ...startBody, redirectUri: 'http://localhost:7071/api/setup/oauth/callback' },
    }),
    context
  );
  assert.equal(local.status, 200);
});

// --- OAuth callback --------------------------------------------------------

async function startFlow() {
  const res = await handlers.setupOAuthStart(req({ method: 'POST', body: startBody }), context);
  return new URL(res.jsonBody.authorize_url).searchParams.get('state');
}

test('a callback with valid state exchanges the code and stores the token', async () => {
  reset();
  const state = await startFlow();

  const res = await handlers.setupOAuthCallback(
    req({ query: { code: 'auth-code', state } }),
    context
  );

  assert.equal(res.status, 200);
  assert.match(res.body, /Connected/);
  assert.equal(secrets.get(TOKEN_SECRET), 'new-token');
});

test('the exchange uses the redirect URI captured at start', async () => {
  reset();
  let seen = null;
  exchangeImpl = async (args) => {
    seen = args;
    return 'new-token';
  };

  const state = await startFlow();
  await handlers.setupOAuthCallback(req({ query: { code: 'auth-code', state } }), context);

  assert.equal(seen.redirectUri, startBody.redirectUri);
  assert.equal(seen.clientSecret, 'csecret');
});

test('a callback with no state does nothing', async () => {
  reset();
  await startFlow();

  const res = await handlers.setupOAuthCallback(req({ query: { code: 'auth-code' } }), context);

  assert.equal(res.status, 400);
  assert.equal(secrets.has(TOKEN_SECRET), false);
});

test('a callback with a guessed state does nothing', async () => {
  reset();
  await startFlow();

  const res = await handlers.setupOAuthCallback(
    req({ query: { code: 'auth-code', state: 'f'.repeat(64) } }),
    context
  );

  assert.equal(res.status, 400);
  assert.equal(secrets.has(TOKEN_SECRET), false);
});

test('replaying a callback URL fails the second time', async () => {
  reset();
  const state = await startFlow();

  const first = await handlers.setupOAuthCallback(
    req({ query: { code: 'auth-code', state } }),
    context
  );
  assert.equal(first.status, 200);

  secrets.delete(TOKEN_SECRET);
  const second = await handlers.setupOAuthCallback(
    req({ query: { code: 'auth-code', state } }),
    context
  );

  assert.equal(second.status, 400);
  assert.equal(secrets.has(TOKEN_SECRET), false, 'a replayed callback must not store anything');
});

test('a declined authorization is explained, and consumes nothing', async () => {
  reset();
  const state = await startFlow();

  const res = await handlers.setupOAuthCallback(
    req({ query: { error: 'access_denied', state } }),
    context
  );

  assert.equal(res.status, 400);
  assert.match(res.body, /declined/i);

  // The flow can still be completed, since a decline should not burn the state.
  const retry = await handlers.setupOAuthCallback(
    req({ query: { code: 'auth-code', state } }),
    context
  );
  assert.equal(retry.status, 200);
});

test('a failed code exchange explains the likely cause and stores nothing', async () => {
  reset();
  const state = await startFlow();
  exchangeImpl = async () => {
    throw Object.assign(new Error('expired'), { name: 'OAuthExchangeError' });
  };

  const res = await handlers.setupOAuthCallback(
    req({ query: { code: 'stale-code', state } }),
    context
  );

  assert.equal(res.status, 502);
  assert.match(res.body, /expire/i);
  assert.equal(secrets.has(TOKEN_SECRET), false);
});

test('a token that arrives broken is not stored', async () => {
  reset();
  const state = await startFlow();
  validateImpl = async () => ({ valid: false, status: 401, message: 'no good' });

  const res = await handlers.setupOAuthCallback(
    req({ query: { code: 'auth-code', state } }),
    context
  );

  assert.equal(res.status, 502);
  assert.equal(secrets.has(TOKEN_SECRET), false);
});

test('callback error pages escape whatever came in the query string', async () => {
  reset();
  await startFlow();

  const res = await handlers.setupOAuthCallback(
    req({ query: { error: '<script>alert(1)</script>', state: 'wrong' } }),
    context
  );

  assert.ok(!res.body.includes('<script>'), 'query content must not reach the page as markup');
});

// --- survey browser --------------------------------------------------------

test('surveys are annotated with selection and sync state', async () => {
  reset();
  listSurveysImpl = async () => [
    { id: 111, title: 'Alpha', response_count: 10 },
    { id: 222, title: 'Beta', response_count: 4 },
  ];
  await handlers.setupSyncConfig(
    req({ method: 'POST', body: { surveyIds: ['111'] } }),
    context
  );
  store.set(blobStore.paths.state('111'), JSON.stringify({ last_sync_at: 'x', response_count: 10 }));

  const res = await handlers.setupSurveys(req(), context);

  assert.equal(res.status, 200);
  const alpha = res.jsonBody.data.find((s) => s.id === '111');
  const beta = res.jsonBody.data.find((s) => s.id === '222');

  assert.equal(alpha.selected, true);
  assert.equal(alpha.synced, true);
  assert.equal(beta.selected, false);
  assert.equal(beta.synced, false);
  assert.equal(res.jsonBody.syncing_all, false);
});

test('selecting nothing is reported as syncing everything', async () => {
  reset();
  listSurveysImpl = async () => [{ id: 111, title: 'Alpha' }];

  const res = await handlers.setupSurveys(req(), context);
  assert.equal(res.jsonBody.syncing_all, true);
});

test('numeric survey IDs are normalized to strings for comparison', async () => {
  reset();
  listSurveysImpl = async () => [{ id: 111, title: 'Alpha' }];
  await handlers.setupSyncConfig(req({ method: 'POST', body: { surveyIds: ['111'] } }), context);

  const res = await handlers.setupSurveys(req(), context);
  assert.equal(res.jsonBody.data[0].selected, true, 'a numeric id must match a stored string id');
});

// --- sync config -----------------------------------------------------------

test('sync config round-trips through save and read', async () => {
  reset();
  const saved = await handlers.setupSyncConfig(
    req({ method: 'POST', body: { surveyIds: ['111'], historyEnabled: true, retentionDays: 30 } }),
    context
  );

  assert.equal(saved.status, 200);
  assert.equal(saved.jsonBody.saved, true);

  const read = await handlers.setupSyncConfig(req({ method: 'GET' }), context);
  assert.deepEqual(read.jsonBody.config.surveyIds, ['111']);
  assert.equal(read.jsonBody.config.historyEnabled, true);
});

test('invalid config is refused with the specific problems listed', async () => {
  reset();
  const res = await handlers.setupSyncConfig(
    req({ method: 'POST', body: { retentionDays: -1, responseStatus: 'nope' } }),
    context
  );

  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.error, 'invalid_config');
  assert.equal(res.jsonBody.errors.length, 2);
});

test('a schedule change comes back flagged as needing an app setting', async () => {
  reset();
  process.env.SYNC_SCHEDULE = '0 0 */6 * * *';

  const res = await handlers.setupSyncConfig(
    req({ method: 'POST', body: { schedule: '0 0 */2 * * *' } }),
    context
  );

  assert.equal(res.jsonBody.pending_app_settings.SYNC_SCHEDULE, '0 0 */2 * * *');
  assert.match(res.jsonBody.message, /application settings/);
});

// --- connection info -------------------------------------------------------

test('connection info lists every table and a Power Query script', async () => {
  reset();
  const res = await handlers.setupConnectionInfo(
    req({ query: { surveyId: '111' }, headers: { host: 'app.azurewebsites.net' } }),
    context
  );

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.tables.length, 6);
  assert.ok(
    res.jsonBody.tables.some(
      (t) => t.url === 'https://app.azurewebsites.net/api/surveys/111/data/answers'
    )
  );
  assert.match(res.jsonBody.power_query, /RelativePath/);
});

test('the generated script uses RelativePath, which scheduled refresh requires', async () => {
  reset();
  const res = await handlers.setupConnectionInfo(
    req({ query: { surveyId: '111' }, headers: { host: 'app.azurewebsites.net' } }),
    context
  );

  // Concatenating the URL instead produces a "dynamic data source" that the
  // Power BI Service refuses to refresh.
  assert.match(res.jsonBody.power_query, /Web\.Contents\(\s*BaseUrl,/);
  assert.ok(!/Web\.Contents\(\s*BaseUrl\s*&/.test(res.jsonBody.power_query));
});

test('no live function key is ever embedded in the script', async () => {
  reset();
  const res = await handlers.setupConnectionInfo(
    req({ query: { surveyId: '111' }, headers: { host: 'app.azurewebsites.net' } }),
    context
  );

  assert.match(res.jsonBody.power_query, /PASTE-YOUR-FUNCTION-KEY-HERE/);
});

test('the base URL honours the forwarded protocol behind Azure front end', async () => {
  reset();
  const res = await handlers.setupConnectionInfo(
    req({
      query: { surveyId: '111' },
      headers: { host: 'app.azurewebsites.net', 'x-forwarded-proto': 'https' },
    }),
    context
  );

  assert.equal(res.jsonBody.base_url, 'https://app.azurewebsites.net');
});

test('a localhost host produces http URLs rather than https', async () => {
  reset();
  const res = await handlers.setupConnectionInfo(
    req({ query: { surveyId: '111' }, headers: { host: 'localhost:7071' } }),
    context
  );

  assert.equal(res.jsonBody.base_url, 'http://localhost:7071');
});

test('connection info requires a surveyId', async () => {
  reset();
  const res = await handlers.setupConnectionInfo(req({ query: {} }), context);
  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.error, 'missing_survey_id');
});

test('connection info still works for a survey that has never synced', async () => {
  reset();
  const res = await handlers.setupConnectionInfo(
    req({ query: { surveyId: 'brand-new' }, headers: { host: 'app.azurewebsites.net' } }),
    context
  );

  // The URLs are valid the moment the survey is selected; they just have no
  // data behind them yet.
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.synced, false);
  assert.equal(res.jsonBody.tables.length, 6);
});
