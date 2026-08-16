const { app } = require('@azure/functions');
const { listSurveys } = require('../lib/surveyMonkeyClient');
const { syncAll, getSyncConfig } = require('../lib/syncEngine');
const { makeLogger } = require('../lib/logger');

/**
 * Timer-triggered sync.
 *
 * Runs on the schedule in the SYNC_SCHEDULE app setting (NCRONTAB, UTC),
 * defaulting to every six hours. This is the only thing that talks to
 * SurveyMonkey on a schedule; Power BI reads the synced files, so refresh
 * frequency in Power BI has no effect on SurveyMonkey API usage.
 *
 * Which surveys get synced comes from SYNC_SURVEY_IDS (comma-separated). If
 * that is empty, every survey the token can see is synced — convenient to
 * start with, but worth narrowing on a large account so a run stays well
 * inside the daily API quota.
 */
app.timer('syncTimer', {
  schedule: '%SYNC_SCHEDULE%',
  handler: async (timer, context) => {
    const log = makeLogger(context);
    const start = Date.now();

    if (timer.isPastDue) {
      log.warn('Timer fired past due; the previous run may have been missed or slow');
    }

    try {
      const surveyIds = await resolveSurveyIds(log);

      if (surveyIds.length === 0) {
        log.warn('No surveys to sync', { surveyCount: 0 });
        return;
      }

      const results = await syncAll(surveyIds, { log });
      const failed = results.filter((r) => r.status === 'failed');

      log.info('Scheduled sync finished', {
        surveyCount: results.length,
        durationMs: Date.now() - start,
      });

      // Throwing marks the invocation as failed so it surfaces in Application
      // Insights and any alert rule built on failure count. The successful
      // surveys have already been written, so this costs nothing.
      if (failed.length > 0) {
        throw new Error(`${failed.length} of ${results.length} surveys failed to sync`);
      }
    } catch (err) {
      log.error('Scheduled sync failed', { errorName: err.name });
      throw err;
    }
  },
});

/**
 * Returns the configured survey IDs, or discovers all visible surveys when
 * none are configured.
 */
async function resolveSurveyIds(log) {
  const { surveyIds } = await getSyncConfig();
  if (surveyIds.length > 0) return surveyIds;

  const surveys = await listSurveys();
  log.info('No SYNC_SURVEY_IDS configured; syncing all visible surveys', {
    surveyCount: surveys.length,
  });
  return surveys.map((s) => s.id);
}

module.exports = { resolveSurveyIds };
