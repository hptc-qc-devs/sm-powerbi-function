/**
 * setupConfig.js
 *
 * Sync configuration that the setup wizard can change at runtime, and the
 * short-lived state used to secure the OAuth flow.
 *
 * Why this exists: a Function cannot rewrite its own application settings, so
 * configuration held purely in environment variables can only be changed in
 * the Azure portal. A wizard whose "Save" button told you to go and edit app
 * settings by hand would not be much of a wizard. Configuration therefore
 * lives in blob storage, layered over the environment variables as defaults:
 *
 *   defaults  <  environment variables  <  saved configuration
 *
 * so an untouched deployment behaves exactly as before, and anything the
 * wizard saves wins from then on.
 *
 * One setting genuinely cannot work this way. SYNC_SCHEDULE is read by the
 * Functions host when it binds the timer trigger at startup, before any of
 * this code runs, so changing it requires an application setting and a
 * restart. `saveConfig` accepts a schedule and reports it back as a pending
 * change rather than pretending to have applied it.
 */

const blobStore = require('./blobStore');

const DEFAULTS = {
  surveyIds: [],
  historyEnabled: false,
  retentionDays: 90,
  responseStatus: 'completed',
};

/** Configuration from environment variables only. */
function envConfig() {
  return {
    surveyIds: splitIds(process.env.SYNC_SURVEY_IDS),
    historyEnabled: process.env.SYNC_HISTORY_ENABLED === 'true',
    retentionDays: Number(process.env.SYNC_SNAPSHOT_RETENTION_DAYS) || DEFAULTS.retentionDays,
    responseStatus: process.env.SYNC_RESPONSE_STATUS || DEFAULTS.responseStatus,
    schedule: process.env.SYNC_SCHEDULE || null,
  };
}

/**
 * Effective configuration: saved values layered over environment values.
 * Falls back to the environment alone when storage is unreachable, so a
 * storage problem degrades the sync rather than stopping it.
 */
async function loadConfig() {
  const base = envConfig();

  let saved = null;
  try {
    saved = await blobStore.readJson(blobStore.paths.config());
  } catch {
    // Reported rather than thrown: callers that just want to sync should
    // carry on with environment settings, while the status endpoint needs to
    // know storage is unreachable so it can say so.
    return { ...base, source: 'env', savedAt: null, storageReachable: false };
  }

  if (!saved) return { ...base, source: 'env', savedAt: null, storageReachable: true };

  return {
    storageReachable: true,
    surveyIds: Array.isArray(saved.surveyIds) ? saved.surveyIds : base.surveyIds,
    historyEnabled:
      typeof saved.historyEnabled === 'boolean' ? saved.historyEnabled : base.historyEnabled,
    retentionDays:
      Number.isFinite(saved.retentionDays) && saved.retentionDays >= 0
        ? saved.retentionDays
        : base.retentionDays,
    responseStatus: saved.responseStatus || base.responseStatus,
    schedule: saved.schedule || base.schedule,
    source: 'saved',
    savedAt: saved.savedAt || null,
  };
}

/**
 * Validates and persists configuration.
 *
 * @returns {Promise<{config: object, pendingAppSettings: object}>}
 *   pendingAppSettings lists anything the caller must apply in the Azure
 *   portal for it to take effect.
 */
async function saveConfig(input = {}) {
  const errors = [];
  const current = await loadConfig();
  const next = { ...current };

  if (input.surveyIds !== undefined) {
    if (!Array.isArray(input.surveyIds)) {
      errors.push('surveyIds must be an array of survey ID strings.');
    } else {
      next.surveyIds = input.surveyIds.map((id) => String(id).trim()).filter(Boolean);
    }
  }

  if (input.historyEnabled !== undefined) {
    if (typeof input.historyEnabled !== 'boolean') {
      errors.push('historyEnabled must be true or false.');
    } else {
      next.historyEnabled = input.historyEnabled;
    }
  }

  if (input.retentionDays !== undefined) {
    const days = Number(input.retentionDays);
    if (!Number.isFinite(days) || days < 0) {
      errors.push('retentionDays must be a number of days, zero or greater.');
    } else {
      next.retentionDays = days;
    }
  }

  if (input.responseStatus !== undefined) {
    if (!['completed', 'partial', 'all'].includes(input.responseStatus)) {
      errors.push('responseStatus must be one of: completed, partial, all.');
    } else {
      next.responseStatus = input.responseStatus;
    }
  }

  if (input.schedule !== undefined) {
    if (!isNcrontab(input.schedule)) {
      errors.push(
        'schedule must be a six-field NCRONTAB expression, for example "0 0 */6 * * *".'
      );
    } else {
      next.schedule = input.schedule;
    }
  }

  if (errors.length > 0) {
    const err = new Error(errors.join(' '));
    err.name = 'ValidationError';
    err.errors = errors;
    throw err;
  }

  const record = {
    surveyIds: next.surveyIds,
    historyEnabled: next.historyEnabled,
    retentionDays: next.retentionDays,
    responseStatus: next.responseStatus,
    schedule: next.schedule,
    savedAt: new Date().toISOString(),
  };

  await blobStore.ensureContainer();
  await blobStore.writeJson(blobStore.paths.config(), record);

  // The timer binding is resolved at host startup, so a schedule change is
  // only real once it is an app setting and the app has restarted. Saying so
  // is better than silently storing a value that does nothing.
  const pendingAppSettings = {};
  if (next.schedule && next.schedule !== process.env.SYNC_SCHEDULE) {
    pendingAppSettings.SYNC_SCHEDULE = next.schedule;
  }

  return { config: { ...record, source: 'saved' }, pendingAppSettings };
}

// --- OAuth state -----------------------------------------------------------

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Stores the one-time `state` for an OAuth round trip.
 *
 * The callback endpoint has to be anonymous, because SurveyMonkey redirects
 * the browser to it and cannot attach a function key. `state` is what makes
 * that safe: it is unguessable, single-use, short-lived, and the callback
 * refuses anything that does not match. Storing it in blob rather than in
 * memory means it survives the cold start that is likely between starting the
 * flow and returning from SurveyMonkey.
 */
async function saveOAuthState(state, details = {}) {
  await blobStore.ensureContainer();
  await blobStore.writeJson(blobStore.paths.oauthState(), {
    state,
    createdAt: new Date().toISOString(),
    ...details,
  });
}

/**
 * Verifies and consumes the stored state. Returns the stored details on
 * success. Throws for missing, mismatched or expired state — the caller
 * should treat every failure the same way and not reveal which it was.
 */
async function consumeOAuthState(state) {
  const stored = await blobStore.readJson(blobStore.paths.oauthState());

  const reject = () => {
    const err = new Error('OAuth state is missing, does not match, or has expired.');
    err.name = 'OAuthStateError';
    throw err;
  };

  if (!stored || !stored.state || !state) reject();
  if (!timingSafeEqual(stored.state, state)) reject();

  const age = Date.now() - new Date(stored.createdAt).getTime();
  if (!Number.isFinite(age) || age > OAUTH_STATE_TTL_MS) {
    await blobStore.deleteBlob(blobStore.paths.oauthState());
    reject();
  }

  // Single use: a state that has been redeemed must not work again.
  await blobStore.deleteBlob(blobStore.paths.oauthState());
  return stored;
}

/** Length-independent comparison, so a mismatch reveals nothing by timing. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// --- helpers ---------------------------------------------------------------

function splitIds(value) {
  return (value || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** NCRONTAB is six fields (seconds first), unlike standard five-field cron. */
function isNcrontab(value) {
  return typeof value === 'string' && value.trim().split(/\s+/).length === 6;
}

module.exports = {
  loadConfig,
  saveConfig,
  envConfig,
  saveOAuthState,
  consumeOAuthState,
  isNcrontab,
  DEFAULTS,
  OAUTH_STATE_TTL_MS,
};
