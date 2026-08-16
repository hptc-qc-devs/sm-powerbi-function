const { app } = require('@azure/functions');
const { listSurveys } = require('../../lib/surveyMonkeyClient');
const { loadConfig } = require('../../lib/setupConfig');
const { handleSurveyMonkeyError } = require('../../lib/apiErrors');
const blobStore = require('../../lib/blobStore');
const { makeLogger } = require('../../lib/logger');

/**
 * GET /api/setup/surveys
 *
 * The wizard's survey browser: every survey the stored token can see, each
 * annotated with whether it is currently selected for syncing and what its
 * last sync looked like.
 *
 * Combining all three in one response is deliberate — the wizard's survey
 * step needs to render checkboxes with live state, and doing that from three
 * separate calls would make the list flicker through inconsistent states.
 */
app.http('setupSurveys', {
  methods: ['GET'],
  authLevel: 'admin',
  route: 'setup/surveys',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const start = Date.now();

    try {
      const [surveys, config] = await Promise.all([listSurveys(), loadConfig()]);
      const selected = new Set(config.surveyIds);

      const rows = await Promise.all(
        surveys.map(async (survey) => {
          const state = await blobStore
            .readJson(blobStore.paths.state(String(survey.id)))
            .catch(() => null);

          return {
            id: String(survey.id),
            title: survey.title,
            response_count: survey.response_count,
            date_created: survey.date_created,
            date_modified: survey.date_modified,
            selected: selected.has(String(survey.id)),
            synced: Boolean(state),
            last_sync_at: state ? state.last_sync_at : null,
            synced_response_count: state ? state.response_count : null,
          };
        })
      );

      log.info('Listed surveys for setup', {
        surveyCount: rows.length,
        durationMs: Date.now() - start,
      });

      return {
        status: 200,
        jsonBody: {
          data: rows,
          // Selecting nothing means "sync everything", which is convenient to
          // start with but worth narrowing on a large account.
          syncing_all: config.surveyIds.length === 0,
          total: rows.length,
        },
      };
    } catch (err) {
      return handleSurveyMonkeyError(err, log);
    }
  },
});
