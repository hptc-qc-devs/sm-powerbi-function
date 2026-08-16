const { app } = require('@azure/functions');
const { TABLE_NAMES } = require('../lib/schema');
const blobStore = require('../lib/blobStore');
const { makeLogger } = require('../lib/logger');

/**
 * GET /api/surveys/{surveyId}/status
 *
 * Reports what has been synced for a survey: when it last ran, how many rows
 * each table holds, and which snapshots are available.
 *
 * This is the endpoint that answers "is my data current?" without downloading
 * it, and the one the setup wizard will poll after triggering a first sync.
 * The snapshot list is what a trend report needs in order to know which dates
 * it can ask for.
 */
app.http('getStatus', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'surveys/{surveyId}/status',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const surveyId = request.params.surveyId;

    try {
      const state = await blobStore.readJson(blobStore.paths.state(surveyId));

      if (state === null) {
        return {
          status: 404,
          jsonBody: {
            error: 'not_synced',
            message:
              `Survey ${surveyId} has never been synced. Trigger one with ` +
              `POST /api/sync/${surveyId} (admin key), or wait for the scheduled run.`,
            synced: false,
          },
        };
      }

      const snapshots = await blobStore.listSnapshotDates(surveyId);
      log.info('Reported sync status', { surveyId });

      return {
        status: 200,
        jsonBody: {
          synced: true,
          survey_id: surveyId,
          last_sync_at: state.last_sync_at || null,
          last_sync_mode: state.last_sync_mode || null,
          last_sync_duration_ms: state.last_sync_duration_ms || null,
          watermark: state.watermark || null,
          response_count: state.response_count || 0,
          row_counts: state.row_counts || {},
          history_enabled: Boolean(state.history_enabled),
          snapshots,
          tables: TABLE_NAMES.map((table) => ({
            table,
            url: `/api/surveys/${surveyId}/data/${table}`,
          })),
        },
      };
    } catch (err) {
      log.error('Failed to read sync status', { surveyId, errorName: err.name });
      return {
        status: 502,
        jsonBody: {
          error: 'storage_unavailable',
          message: 'Could not read sync state from storage.',
        },
      };
    }
  },
});
