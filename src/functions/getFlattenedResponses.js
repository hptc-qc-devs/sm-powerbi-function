const { app } = require('@azure/functions');
const { getResponsesBulk } = require('../lib/surveyMonkeyClient');
const { getLookupsForSurvey } = require('../lib/surveyDetailsCache');
const { flattenSurveyResponses } = require('../lib/flatten');
const { handleSurveyMonkeyError } = require('../lib/apiErrors');
const { makeLogger } = require('../lib/logger');

/**
 * GET /api/surveys/{surveyId}/flattened-responses
 *
 * Direct (live) mode: fetches from SurveyMonkey and flattens on every
 * request, returning one row per response x question x answer. Nothing is
 * stored, so `snapshot_date` marks when this particular fetch ran.
 *
 * Because every call re-pulls the full survey, this mode is bounded by
 * SurveyMonkey's rate limits and by request timeouts on large surveys. It
 * suits small surveys and quick validation; the synced-to-storage endpoints
 * are the better fit for regular Power BI refreshes.
 *
 * Optional query param `modifiedSince` (ISO 8601) narrows the pull to
 * responses modified on/after that timestamp — useful for manual testing,
 * though callers typically pass no params and pull the current full set of
 * completed responses.
 */
app.http('getFlattenedResponses', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'surveys/{surveyId}/flattened-responses',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const start = Date.now();
    const surveyId = request.params.surveyId;

    if (!surveyId) {
      return { status: 400, jsonBody: { error: 'missing_survey_id' } };
    }

    const modifiedSinceParam = request.query.get('modifiedSince');
    let modifiedSince;
    if (modifiedSinceParam) {
      modifiedSince = new Date(modifiedSinceParam);
      if (Number.isNaN(modifiedSince.getTime())) {
        return {
          status: 400,
          jsonBody: { error: 'invalid_modifiedSince', message: 'Must be a valid ISO 8601 date.' },
        };
      }
    }

    try {
      const lookups = await getLookupsForSurvey(surveyId);
      log.info('Survey lookups resolved', { surveyId, cacheHit: lookups.cacheHit });

      const responses = await getResponsesBulk(surveyId, { modifiedSince });
      log.info('Fetched responses', { surveyId, responseCount: responses.length });

      const snapshotDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
      const rows = flattenSurveyResponses(lookups.surveyMeta, lookups, responses, snapshotDate);

      log.info('Flattened rows', {
        surveyId,
        rowCount: rows.length,
        durationMs: Date.now() - start,
      });

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: { data: rows },
      };
    } catch (err) {
      return handleSurveyMonkeyError(err, log);
    }
  },
});
