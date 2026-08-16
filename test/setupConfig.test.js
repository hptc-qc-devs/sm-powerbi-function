const test = require('node:test');
const assert = require('node:assert/strict');

const blobStore = require('../src/lib/blobStore');

const store = new Map();
let storageFails = false;

const guard = () => {
  if (storageFails) throw new Error('storage down');
};

blobStore.ensureContainer = async () => guard();
blobStore.readJson = async (p) => (guard(), store.has(p) ? JSON.parse(store.get(p)) : null);
blobStore.writeJson = async (p, v) => (guard(), void store.set(p, JSON.stringify(v)));
blobStore.deleteBlob = async (p) => (guard(), void store.delete(p));

const {
  loadConfig,
  saveConfig,
  envConfig,
  saveOAuthState,
  consumeOAuthState,
  isNcrontab,
  OAUTH_STATE_TTL_MS,
} = require('../src/lib/setupConfig');

const ENV_KEYS = [
  'SYNC_SURVEY_IDS',
  'SYNC_HISTORY_ENABLED',
  'SYNC_SNAPSHOT_RETENTION_DAYS',
  'SYNC_RESPONSE_STATUS',
  'SYNC_SCHEDULE',
];

function reset() {
  store.clear();
  storageFails = false;
  for (const key of ENV_KEYS) delete process.env[key];
}

// --- layering --------------------------------------------------------------

test('with nothing saved, configuration comes from the environment', async () => {
  reset();
  process.env.SYNC_SURVEY_IDS = '111, 222';
  process.env.SYNC_HISTORY_ENABLED = 'true';
  process.env.SYNC_SNAPSHOT_RETENTION_DAYS = '30';

  const config = await loadConfig();

  assert.deepEqual(config.surveyIds, ['111', '222']);
  assert.equal(config.historyEnabled, true);
  assert.equal(config.retentionDays, 30);
  assert.equal(config.source, 'env');
});

test('saved configuration takes precedence over the environment', async () => {
  reset();
  process.env.SYNC_SURVEY_IDS = '111';
  process.env.SYNC_HISTORY_ENABLED = 'false';

  await saveConfig({ surveyIds: ['999'], historyEnabled: true });
  const config = await loadConfig();

  assert.deepEqual(config.surveyIds, ['999']);
  assert.equal(config.historyEnabled, true);
  assert.equal(config.source, 'saved');
  assert.ok(config.savedAt);
});

test('saving one field leaves the others untouched', async () => {
  reset();
  await saveConfig({ surveyIds: ['111'], retentionDays: 45, historyEnabled: true });
  await saveConfig({ retentionDays: 60 });

  const config = await loadConfig();
  assert.deepEqual(config.surveyIds, ['111'], 'unrelated fields must survive a partial save');
  assert.equal(config.historyEnabled, true);
  assert.equal(config.retentionDays, 60);
});

test('defaults apply when neither storage nor environment says anything', async () => {
  reset();
  const config = await loadConfig();

  assert.deepEqual(config.surveyIds, []);
  assert.equal(config.historyEnabled, false);
  assert.equal(config.retentionDays, 90);
  assert.equal(config.responseStatus, 'completed');
});

test('unreachable storage falls back to the environment rather than throwing', async () => {
  reset();
  process.env.SYNC_SURVEY_IDS = '111';
  storageFails = true;

  // A storage problem should degrade the sync, not stop it starting.
  const config = await loadConfig();
  assert.deepEqual(config.surveyIds, ['111']);
  assert.equal(config.source, 'env');
});

test('the fallback is reported, so callers can tell storage is down', async () => {
  reset();

  // Swallowing the error is right for the sync but wrong for a diagnostic,
  // so the outcome is reported rather than hidden.
  assert.equal((await loadConfig()).storageReachable, true);

  storageFails = true;
  assert.equal((await loadConfig()).storageReachable, false);
});

test('a corrupt config blob is ignored in favour of the environment', async () => {
  reset();
  process.env.SYNC_SURVEY_IDS = '111';
  store.set(blobStore.paths.config(), '{ not json');

  const config = await loadConfig();
  assert.deepEqual(config.surveyIds, ['111']);
});

test('envConfig reads only environment variables', () => {
  reset();
  process.env.SYNC_RESPONSE_STATUS = 'all';
  assert.equal(envConfig().responseStatus, 'all');
});

// --- validation ------------------------------------------------------------

test('surveyIds must be an array', async () => {
  reset();
  await assert.rejects(() => saveConfig({ surveyIds: '111,222' }), /must be an array/);
});

test('surveyIds are trimmed and blanks dropped', async () => {
  reset();
  const { config } = await saveConfig({ surveyIds: [' 111 ', '', '222', '   '] });
  assert.deepEqual(config.surveyIds, ['111', '222']);
});

test('historyEnabled must be a boolean, not a truthy string', async () => {
  reset();
  await assert.rejects(() => saveConfig({ historyEnabled: 'true' }), /must be true or false/);
});

test('retentionDays must be a non-negative number', async () => {
  reset();
  await assert.rejects(() => saveConfig({ retentionDays: -1 }), /zero or greater/);
  await assert.rejects(() => saveConfig({ retentionDays: 'lots' }), /zero or greater/);

  const { config } = await saveConfig({ retentionDays: 0 });
  assert.equal(config.retentionDays, 0, 'zero is valid and means no pruning');
});

test('responseStatus is restricted to known values', async () => {
  reset();
  await assert.rejects(() => saveConfig({ responseStatus: 'finished' }), /completed, partial, all/);

  const { config } = await saveConfig({ responseStatus: 'all' });
  assert.equal(config.responseStatus, 'all');
});

test('schedule must be a six-field NCRONTAB expression', async () => {
  reset();
  // Five fields is standard cron; NCRONTAB adds a leading seconds field, and
  // accepting the wrong one would silently change the sync cadence.
  await assert.rejects(() => saveConfig({ schedule: '0 */6 * * *' }), /six-field/);

  const { config } = await saveConfig({ schedule: '0 0 */6 * * *' });
  assert.equal(config.schedule, '0 0 */6 * * *');
});

test('isNcrontab counts fields rather than guessing', () => {
  assert.equal(isNcrontab('0 0 */6 * * *'), true);
  assert.equal(isNcrontab('  0   0 */6 * * *  '), true);
  assert.equal(isNcrontab('0 */6 * * *'), false);
  assert.equal(isNcrontab(''), false);
  assert.equal(isNcrontab(null), false);
});

test('several validation errors are reported together', async () => {
  reset();
  await assert.rejects(
    () => saveConfig({ retentionDays: -5, responseStatus: 'nope' }),
    (err) => {
      assert.equal(err.name, 'ValidationError');
      assert.equal(err.errors.length, 2);
      return true;
    }
  );
});

test('nothing is written when validation fails', async () => {
  reset();
  await saveConfig({ surveyIds: ['111'] });
  await assert.rejects(() => saveConfig({ surveyIds: 'bad', retentionDays: 30 }));

  const config = await loadConfig();
  assert.deepEqual(config.surveyIds, ['111']);
  assert.equal(config.retentionDays, 90, 'a rejected save must not partially apply');
});

// --- schedule is special ---------------------------------------------------

test('a schedule change is reported as pending rather than applied', async () => {
  reset();
  process.env.SYNC_SCHEDULE = '0 0 */6 * * *';

  const { pendingAppSettings } = await saveConfig({ schedule: '0 0 */2 * * *' });

  // The host binds the timer at startup, so this cannot take effect until it
  // is an app setting and the app restarts. Saying so beats silently storing
  // a value that does nothing.
  assert.equal(pendingAppSettings.SYNC_SCHEDULE, '0 0 */2 * * *');
});

test('saving the schedule already in force reports nothing pending', async () => {
  reset();
  process.env.SYNC_SCHEDULE = '0 0 */6 * * *';

  const { pendingAppSettings } = await saveConfig({ schedule: '0 0 */6 * * *' });
  assert.deepEqual(pendingAppSettings, {});
});

// --- OAuth state -----------------------------------------------------------

test('a stored state round-trips with its details', async () => {
  reset();
  await saveOAuthState('abc123', { redirectUri: 'https://example.com/cb' });

  const consumed = await consumeOAuthState('abc123');
  assert.equal(consumed.redirectUri, 'https://example.com/cb');
});

test('state is single use, so a replayed callback fails', async () => {
  reset();
  await saveOAuthState('abc123', {});

  await consumeOAuthState('abc123');
  await assert.rejects(() => consumeOAuthState('abc123'), /missing, does not match, or has expired/);
});

test('a mismatched state is rejected', async () => {
  reset();
  await saveOAuthState('the-real-state', {});
  await assert.rejects(() => consumeOAuthState('a-guess'), /missing, does not match/);
});

test('a missing or empty state is rejected', async () => {
  reset();
  await assert.rejects(() => consumeOAuthState('anything'), /missing, does not match/);

  await saveOAuthState('abc123', {});
  await assert.rejects(() => consumeOAuthState(''), /missing, does not match/);
  await assert.rejects(() => consumeOAuthState(undefined), /missing, does not match/);
});

test('an expired state is rejected and cleaned up', async () => {
  reset();
  const stale = new Date(Date.now() - OAUTH_STATE_TTL_MS - 1000).toISOString();
  store.set(
    blobStore.paths.oauthState(),
    JSON.stringify({ state: 'old-state', createdAt: stale, redirectUri: 'https://x/cb' })
  );

  await assert.rejects(() => consumeOAuthState('old-state'), /expired/);
  assert.equal(store.has(blobStore.paths.oauthState()), false, 'expired state should be removed');
});

test('a state with an unparseable timestamp is rejected', async () => {
  reset();
  store.set(
    blobStore.paths.oauthState(),
    JSON.stringify({ state: 'x', createdAt: 'not-a-date' })
  );
  await assert.rejects(() => consumeOAuthState('x'));
});

test('every rejection reason produces the same message', async () => {
  reset();
  const messages = [];

  const capture = async (fn) => {
    try {
      await fn();
    } catch (err) {
      messages.push(err.message);
    }
  };

  await capture(() => consumeOAuthState('nothing-stored'));
  await saveOAuthState('real', {});
  await capture(() => consumeOAuthState('wrong'));

  // A caller should not be able to tell "no flow in progress" from "wrong
  // value" — that distinction only helps someone guessing.
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1]);
});
