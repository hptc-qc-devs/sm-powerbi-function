const { app } = require('@azure/functions');
const { loadConfig, saveConfig } = require('../../lib/setupConfig');
const { makeLogger } = require('../../lib/logger');

/**
 * GET  /api/setup/sync-config   read current configuration
 * POST /api/setup/sync-config   save configuration
 *
 * Body fields are all optional; anything omitted keeps its current value.
 *
 *   surveyIds       string[]  which surveys to sync ([] means all visible)
 *   historyEnabled  boolean   freeze a dated snapshot on every sync
 *   retentionDays   number    prune snapshots older than this
 *   responseStatus  string    completed | partial | all
 *   schedule        string    NCRONTAB, six fields
 *
 * Saved configuration lives in blob storage and takes precedence over
 * application settings, which is what lets the wizard change it at all — a
 * Function cannot rewrite its own app settings.
 *
 * `schedule` is the exception. The Functions host binds the timer trigger at
 * startup, so a new schedule only takes effect once it is an application
 * setting and the app restarts. The response returns it under
 * `pending_app_settings` rather than implying it has been applied.
 */
app.http('setupSyncConfig', {
  methods: ['GET', 'POST'],
  authLevel: 'admin',
  route: 'setup/sync-config',
  handler: async (request, context) => {
    const log = makeLogger(context);

    if (request.method === 'GET') {
      try {
        const config = await loadConfig();
        return {
          status: 200,
          jsonBody: { config, active_schedule: process.env.SYNC_SCHEDULE || null },
        };
      } catch (err) {
        log.error('Could not read sync config', { errorName: err.name });
        return {
          status: 502,
          jsonBody: {
            error: 'storage_unavailable',
            message: 'Could not read configuration from storage.',
          },
        };
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: 'invalid_body', message: 'Expected a JSON body.' } };
    }

    try {
      const { config, pendingAppSettings } = await saveConfig(body);
      log.info('Saved sync config', { surveyCount: config.surveyIds.length });

      return {
        status: 200,
        jsonBody: {
          saved: true,
          config,
          pending_app_settings: pendingAppSettings,
          message:
            Object.keys(pendingAppSettings).length > 0
              ? 'Saved. The schedule change needs SYNC_SCHEDULE set in the Function App ' +
                'application settings, followed by a restart, before it takes effect.'
              : 'Saved.',
        },
      };
    } catch (err) {
      if (err.name === 'ValidationError') {
        return {
          status: 400,
          jsonBody: { error: 'invalid_config', message: err.message, errors: err.errors },
        };
      }

      log.error('Could not save sync config', { errorName: err.name });
      return {
        status: 502,
        jsonBody: {
          error: 'storage_unavailable',
          message: 'Could not write configuration to storage.',
        },
      };
    }
  },
});
