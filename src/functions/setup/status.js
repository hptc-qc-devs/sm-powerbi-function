const { app } = require('@azure/functions');
const { getSecret } = require('../../lib/secretsClient');
const { validateToken } = require('../../lib/surveyMonkeyClient');
const { loadConfig } = require('../../lib/setupConfig');
const blobStore = require('../../lib/blobStore');
const { makeLogger } = require('../../lib/logger');

const TOKEN_SECRET_NAME = () =>
  process.env.SM_ACCESS_TOKEN_SECRET_NAME || 'surveymonkey-access-token';

/**
 * GET /api/setup/status
 *
 * One call that tells the wizard everything it needs to decide which step to
 * show: is a token stored, does it still work, can we reach storage, what is
 * configured, and what has been synced.
 *
 * Every check is reported independently rather than collapsing into a single
 * pass/fail, because the fixes are different — a missing token is a setup
 * step, a rejected token is a re-authorization, and unreachable storage is an
 * infrastructure problem.
 *
 * Requires the admin (master) key: this is configuration surface, not data.
 */
app.http('setupStatus', {
  methods: ['GET'],
  authLevel: 'admin',
  route: 'setup/status',
  handler: async (request, context) => {
    const log = makeLogger(context);

    const checks = {
      tokenStored: false,
      tokenValid: false,
      storageReachable: false,
    };
    let account = null;
    let tokenMessage = null;
    let config = null;
    let surveys = [];

    // --- token -------------------------------------------------------------
    let token = null;
    try {
      token = await getSecret(TOKEN_SECRET_NAME());
      checks.tokenStored = Boolean(token);
    } catch (err) {
      tokenMessage =
        'Could not read the stored token. If this deployment uses Key Vault, check the ' +
        'Function App has a managed identity with get/list permission on secrets.';
      log.warn('Setup status could not read token secret', { errorName: err.name });
    }

    if (token) {
      const result = await validateToken(token);
      checks.tokenValid = result.valid;
      account = result.account || null;
      if (!result.valid) tokenMessage = result.message;
    } else if (!tokenMessage) {
      tokenMessage = 'No SurveyMonkey token stored yet.';
    }

    // --- storage and config ------------------------------------------------
    // loadConfig deliberately does not throw on a storage failure — it falls
    // back to environment settings and reports what happened, so ask it.
    config = await loadConfig();
    checks.storageReachable = config.storageReachable !== false;
    if (!checks.storageReachable) {
      log.warn('Setup status could not reach storage', { statusCode: 200 });
    }

    // --- per-survey sync state --------------------------------------------
    if (checks.storageReachable && config && config.surveyIds.length > 0) {
      surveys = await Promise.all(
        config.surveyIds.map(async (surveyId) => {
          const state = await blobStore
            .readJson(blobStore.paths.state(surveyId))
            .catch(() => null);

          return {
            survey_id: surveyId,
            synced: Boolean(state),
            last_sync_at: state ? state.last_sync_at : null,
            response_count: state ? state.response_count : null,
            row_counts: state ? state.row_counts : null,
          };
        })
      );
    }

    const ready = checks.tokenValid && checks.storageReachable;
    log.info('Reported setup status', { statusCode: 200 });

    return {
      status: 200,
      jsonBody: {
        ready,
        checks,
        account,
        token_message: tokenMessage,
        config: config
          ? {
              surveyIds: config.surveyIds,
              historyEnabled: config.historyEnabled,
              retentionDays: config.retentionDays,
              responseStatus: config.responseStatus,
              schedule: config.schedule,
              source: config.source,
              savedAt: config.savedAt,
            }
          : null,
        // The timer schedule is bound at host startup, so the wizard shows
        // the live value separately from any saved-but-not-applied one.
        active_schedule: process.env.SYNC_SCHEDULE || null,
        surveys,
        next_step: nextStep(checks),
      },
    };
  },
});

function nextStep(checks) {
  if (!checks.storageReachable) return 'fix_storage';
  if (!checks.tokenStored) return 'store_token';
  if (!checks.tokenValid) return 'reauthorize';
  return 'choose_surveys';
}
