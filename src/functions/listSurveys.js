const { app } = require('@azure/functions');
const { listSurveys } = require('../lib/surveyMonkeyClient');
const { handleSurveyMonkeyError } = require('../lib/apiErrors');
const { makeLogger } = require('../lib/logger');

/**
 * GET /api/surveys
 *
 * Returns the list of surveys visible to the configured access token:
 * id, title, response_count, date_created, date_modified. No response
 * data — this is a discovery endpoint, not the data feed. Useful as a
 * quick check that the stored token still works, and reused by the setup
 * wizard's survey browser.
 */
app.http('listSurveys', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'surveys',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const start = Date.now();

    try {
      const surveys = await listSurveys();
      log.info('Listed surveys', { surveyCount: surveys.length, durationMs: Date.now() - start });

      return {
        status: 200,
        jsonBody: {
          data: surveys.map((s) => ({
            id: s.id,
            title: s.title,
            response_count: s.response_count,
            date_created: s.date_created,
            date_modified: s.date_modified,
          })),
        },
      };
    } catch (err) {
      return handleSurveyMonkeyError(err, log);
    }
  },
});
