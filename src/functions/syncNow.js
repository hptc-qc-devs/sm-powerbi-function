const { app } = require('@azure/functions');
const { syncSurvey, syncAll } = require('../lib/syncEngine');
const { handleSurveyMonkeyError } = require('../lib/apiErrors');
const { makeLogger } = require('../lib/logger');
const { resolveSurveyIds } = require('./syncTimer');

/**
 * POST /api/sync                     sync every configured survey
 * POST /api/sync/{surveyId}          sync one survey
 *
 * On-demand equivalent of the timer, for the setup wizard's "Sync now" button
 * and for a first sync straight after configuration rather than waiting for
 * the next scheduled run.
 *
 * Requires the admin (master) key rather than a function key: this triggers
 * real SurveyMonkey API usage against the account's daily quota, so it should
 * be available to whoever administers the deployment, not to every holder of
 * a read key handed to Power BI.
 *
 * Query params:
 *   full=true   ignore the stored watermark and re-pull the whole survey
 *
 * A sync of a large survey can outlast the HTTP request. The Function
 * timeout in host.json governs it; if you hit that, narrow SYNC_SURVEY_IDS
 * and let the timer handle the rest.
 */
app.http('syncNow', {
  methods: ['POST'],
  authLevel: 'admin',
  route: 'sync/{surveyId?}',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const start = Date.now();

    const surveyId = request.params.surveyId;
    const full = request.query.get('full') === 'true';

    try {
      if (surveyId) {
        const state = await syncSurvey(surveyId, { full, log });
        return {
          status: 200,
          jsonBody: { status: 'ok', durationMs: Date.now() - start, result: state },
        };
      }

      const surveyIds = await resolveSurveyIds(log);
      if (surveyIds.length === 0) {
        return {
          status: 400,
          jsonBody: {
            error: 'no_surveys',
            message:
              'No surveys to sync. Set SYNC_SURVEY_IDS, or check that the stored ' +
              'token can see at least one survey.',
          },
        };
      }

      const results = await syncAll(surveyIds, { full, log });
      const failed = results.filter((r) => r.status === 'failed');

      return {
        // 207: some surveys synced and some did not, and the caller needs to
        // see which. A flat 200 would hide partial failure from the wizard.
        status: failed.length === 0 ? 200 : 207,
        jsonBody: {
          status: failed.length === 0 ? 'ok' : 'partial',
          durationMs: Date.now() - start,
          synced: results.length - failed.length,
          failed: failed.length,
          results,
        },
      };
    } catch (err) {
      return handleSurveyMonkeyError(err, log);
    }
  },
});
