const { app } = require('@azure/functions');
const { listSurveys, SurveyMonkeyAuthError, SurveyMonkeyScopeError } = require('../lib/surveyMonkeyClient');
const { makeLogger } = require('../lib/logger');

/**
 * GET /api/surveys
 *
 * Returns the list of surveys visible to the configured access token:
 * id, title, response_count, date_created, date_modified. No response
 * data — this is a discovery/validation endpoint, not the data feed.
 * Used during setup (SOW 2.9 endpoint validation) and as a quick sanity
 * check that the token still works.
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

/**
 * Shared error-to-HTTP-response mapping for SurveyMonkey-backed endpoints.
 * Exported so the other data endpoint can reuse the exact same mapping —
 * one place to keep the 401/403 story consistent, per SOW 2.9.
 */
function handleSurveyMonkeyError(err, log) {
  if (err instanceof SurveyMonkeyAuthError) {
    log.error('SurveyMonkey auth error', { statusCode: 401, errorName: err.name });
    return {
      status: 502,
      jsonBody: {
        error: 'surveymonkey_token_invalid',
        message:
          'The stored SurveyMonkey access token was rejected (401). It has likely been ' +
          'revoked. Re-run the OAuth setup script to re-authorize; this requires a human ' +
          'because SurveyMonkey does not issue refresh tokens.',
      },
    };
  }

  if (err instanceof SurveyMonkeyScopeError) {
    log.error('SurveyMonkey scope error', { statusCode: 403, errorName: err.name });
    return {
      status: 502,
      jsonBody: {
        error: 'surveymonkey_insufficient_scope',
        message: 'The access token is valid but lacks permission for this resource (403).',
      },
    };
  }

  log.error('Unhandled SurveyMonkey API error', { errorName: err.name });
  return {
    status: 502,
    jsonBody: { error: 'surveymonkey_api_error', message: 'Upstream SurveyMonkey API call failed.' },
  };
}

module.exports = { handleSurveyMonkeyError };
