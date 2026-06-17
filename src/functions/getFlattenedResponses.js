const { app } = require('@azure/functions');
const { getResponsesBulk } = require('../lib/surveyMonkeyClient');
const { getLookupsForSurvey } = require('../lib/surveyDetailsCache');
const { flattenSurveyResponses } = require('../lib/flatten');
const { makeLogger } = require('../lib/logger');
const { handleSurveyMonkeyError } = require('./listSurveys');

/**
 * GET /api/surveys/{surveyId}/flattened-responses
 *
 * This is the endpoint Power BI's Web connector calls on scheduled refresh.
 * Returns flat, analytics-ready rows: one row per response x question x
 * answer, per the locked-in Phase 1 schema.
 *
 * Phase 1 is intentionally stateless — every call re-fetches and re-flattens
 * from SurveyMonkey directly. There is no Blob Storage snapshot yet (that's
 * Phase 2 per SOW 3.1); "snapshot_date" here just marks when this particular
 * fetch ran, since there is no append-only history to look back through yet.
 *
 * Optional query param `modifiedSince` (ISO 8601) narrows the pull to
 * responses modified on/after that timestamp — useful for manual testing,
 * though Power BI itself will typically call this with no params and pull
 * the current full set of completed responses.
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
