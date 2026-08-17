const { app } = require('@azure/functions');
const { TABLE_NAMES, TABLE_TYPES } = require('../lib/schema');
const { fromCsv } = require('../lib/csv');
const blobStore = require('../lib/blobStore');
const { makeLogger } = require('../lib/logger');

/**
 * GET /api/surveys/{surveyId}/data/{table}
 *
 * Serves a synced table. This is the endpoint Power BI's Web connector points
 * at on scheduled refresh.
 *
 * It reads a file that the sync already produced, so it makes no SurveyMonkey
 * API calls and does no transformation — which is what makes refreshes fast
 * and immune to SurveyMonkey's rate limits and outages.
 *
 *   table       one of surveys | questions | choices | responses | answers | flat
 *   ?format     csv (default) or json
 *   ?snapshot   YYYY-MM-DD to read a frozen snapshot instead of current data
 *
 * A 404 here usually means "not synced yet" rather than "wrong URL", so the
 * response says which it is and what to do about it.
 */
app.http('getData', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'surveys/{surveyId}/data/{table}',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const start = Date.now();

    const surveyId = request.params.surveyId;
    const table = request.params.table;
    const format = (request.query.get('format') || 'csv').toLowerCase();
    const snapshot = request.query.get('snapshot');

    if (!TABLE_NAMES.includes(table)) {
      return {
        status: 404,
        jsonBody: {
          error: 'unknown_table',
          message: `Unknown table "${table}".`,
          available: TABLE_NAMES,
        },
      };
    }

    if (format !== 'csv' && format !== 'json') {
      return {
        status: 400,
        jsonBody: { error: 'invalid_format', message: 'format must be "csv" or "json".' },
      };
    }

    if (snapshot && !/^\d{4}-\d{2}-\d{2}$/.test(snapshot)) {
      return {
        status: 400,
        jsonBody: { error: 'invalid_snapshot', message: 'snapshot must be YYYY-MM-DD.' },
      };
    }

    try {
      const blobPath = snapshot
        ? blobStore.paths.snapshot(surveyId, snapshot, table)
        : await resolveCurrentPath(surveyId, table);

      // Buffered rather than streamed. The sync already holds a whole survey
      // in memory to build these tables, so buffering one table to serve it
      // does not raise the ceiling, and it keeps the response handling simple.
      const csv = await blobStore.readText(blobPath);

      if (csv === null) {
        return { status: 404, jsonBody: notSyncedBody(surveyId, table, snapshot) };
      }

      log.info('Served synced table', { surveyId, durationMs: Date.now() - start });

      if (format === 'json') {
        const rows = fromCsv(csv, { types: TABLE_TYPES[table] });
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          jsonBody: { survey_id: surveyId, table, snapshot: snapshot || null, data: rows },
        };
      }

      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `inline; filename="${table}.csv"`,
        },
        body: csv,
      };
    } catch (err) {
      log.error('Failed to serve synced table', { surveyId, errorName: err.name });
      return {
        status: 502,
        jsonBody: {
          error: 'storage_unavailable',
          message: 'Could not read synced data from storage.',
        },
      };
    }
  },
});

/**
 * Resolves which copy of a table is currently authoritative.
 *
 * The sync writes each table set into its own version directory and then
 * publishes it by writing `current_version` into state.json, so reading the
 * pointer first is what guarantees a caller sees one coherent set rather than
 * a half-replaced one.
 *
 * Deployments synced before versioning existed have no pointer and their data
 * still lives under `latest/`, so that path remains the fallback. It stops
 * being used the first time they sync again.
 */
async function resolveCurrentPath(surveyId, table) {
  const state = await blobStore.readJson(blobStore.paths.state(surveyId)).catch(() => null);

  if (state && state.current_version) {
    return blobStore.paths.version(surveyId, state.current_version, table);
  }

  return blobStore.paths.latest(surveyId, table);
}

function notSyncedBody(surveyId, table, snapshot) {
  if (snapshot) {
    return {
      error: 'snapshot_not_found',
      message:
        `No snapshot dated ${snapshot} for survey ${surveyId}. Call ` +
        `/api/surveys/${surveyId}/status to see which snapshots exist.`,
    };
  }

  return {
    error: 'not_synced',
    message:
      `Survey ${surveyId} has no synced "${table}" data yet. Trigger a sync with ` +
      `POST /api/sync/${surveyId} (admin key), or wait for the scheduled run.`,
  };
}
