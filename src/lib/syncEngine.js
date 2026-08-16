/**
 * syncEngine.js
 *
 * Pulls a survey from SurveyMonkey, rebuilds the tables, and writes them to
 * blob storage. This is what decouples Power BI's refresh schedule from
 * SurveyMonkey's rate limits: refreshes read static files, and SurveyMonkey
 * is only contacted on the sync schedule.
 *
 * Incremental by design. After the first sync, only responses modified since
 * the stored watermark are fetched, merged into the retained raw set, and the
 * tables are rebuilt from the merged whole. Rebuilding everything rather than
 * patching table rows keeps the output identical to a full sync — no drift
 * accumulates over months of incremental runs, which is the usual failure
 * mode of this kind of pipeline.
 *
 * The merge is keyed on response id, so an edited response replaces its
 * earlier version rather than appearing twice.
 */

const { getSurveyDetails, getResponsesBulk } = require('./surveyMonkeyClient');
const { buildTables, buildFlatTable, TABLE_COLUMNS, TABLE_NAMES } = require('./schema');
const { toCsv } = require('./csv');
const blobStore = require('./blobStore');

/** Reads sync configuration from app settings, with sensible defaults. */
function getSyncConfig() {
  return {
    surveyIds: (process.env.SYNC_SURVEY_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    historyEnabled: process.env.SYNC_HISTORY_ENABLED === 'true',
    retentionDays: Number(process.env.SYNC_SNAPSHOT_RETENTION_DAYS) || 90,
    responseStatus: process.env.SYNC_RESPONSE_STATUS || 'completed',
  };
}

/**
 * Syncs one survey.
 *
 * @param {string} surveyId
 * @param {object} [opts]
 * @param {boolean} [opts.full=false] - ignore the watermark and re-pull everything
 * @param {boolean} [opts.historyEnabled] - freeze a dated snapshot
 * @param {number} [opts.retentionDays] - prune snapshots older than this
 * @param {string} [opts.snapshotDate] - override the stamped date (testing)
 * @param {object} [opts.log] - logger; defaults to a no-op
 * @returns {Promise<object>} summary of what happened
 */
async function syncSurvey(surveyId, opts = {}) {
  const config = getSyncConfig();
  const log = opts.log || noopLogger();
  const startedAt = Date.now();

  const historyEnabled = opts.historyEnabled !== undefined ? opts.historyEnabled : config.historyEnabled;
  const retentionDays = opts.retentionDays !== undefined ? opts.retentionDays : config.retentionDays;
  const snapshotDate = opts.snapshotDate || new Date().toISOString().slice(0, 10);

  await blobStore.ensureContainer();

  const previousState = (await blobStore.readJson(blobStore.paths.state(surveyId))) || {};
  const storedResponses = (await blobStore.readJson(blobStore.paths.raw(surveyId))) || [];

  // A full sync is forced on request, and also whenever there is nothing to
  // merge into — an incremental pull against an empty base would silently
  // produce a partial dataset.
  const isFull = Boolean(opts.full) || !previousState.watermark || storedResponses.length === 0;
  const modifiedSince = isFull ? undefined : new Date(previousState.watermark);

  log.info('Sync starting', { surveyId, cacheHit: !isFull });

  const details = await getSurveyDetails(surveyId);
  const fetched = await getResponsesBulk(surveyId, {
    modifiedSince,
    status: config.responseStatus,
  });

  log.info('Fetched responses', { surveyId, responseCount: fetched.length });

  const merged = mergeResponses(isFull ? [] : storedResponses, fetched.map(stripResponsePii));

  const tables = buildTables(details, merged, { snapshotDate });
  const flat = buildFlatTable(tables);
  const allTables = { ...tables, flat };

  // Write the raw base first. If a later write fails, the next run still has
  // a consistent base to merge into rather than re-pulling from scratch.
  await blobStore.writeJson(blobStore.paths.raw(surveyId), merged);

  for (const table of TABLE_NAMES) {
    const csv = toCsv(allTables[table], TABLE_COLUMNS[table]);
    await blobStore.writeText(blobStore.paths.latest(surveyId, table), csv);
    if (historyEnabled) {
      await blobStore.writeText(blobStore.paths.snapshot(surveyId, snapshotDate, table), csv);
    }
  }

  const pruned = historyEnabled ? await blobStore.pruneSnapshots(surveyId, retentionDays) : [];

  const watermark = maxDateModified(merged) || previousState.watermark || null;
  const durationMs = Date.now() - startedAt;

  const state = {
    survey_id: surveyId,
    watermark,
    last_sync_at: new Date().toISOString(),
    last_sync_mode: isFull ? 'full' : 'incremental',
    last_sync_duration_ms: durationMs,
    responses_fetched: fetched.length,
    response_count: merged.length,
    row_counts: Object.fromEntries(TABLE_NAMES.map((t) => [t, allTables[t].length])),
    history_enabled: historyEnabled,
    snapshot_date: historyEnabled ? snapshotDate : null,
    snapshots_pruned: pruned,
  };

  await blobStore.writeJson(blobStore.paths.state(surveyId), state);

  log.info('Sync complete', {
    surveyId,
    responseCount: merged.length,
    rowCount: allTables.answers.length,
    durationMs,
  });

  return state;
}

/**
 * Syncs every configured survey, isolating failures so one bad survey does
 * not abandon the rest of the run.
 */
async function syncAll(surveyIds, opts = {}) {
  const results = [];

  for (const surveyId of surveyIds) {
    try {
      results.push({ surveyId, status: 'ok', state: await syncSurvey(surveyId, opts) });
    } catch (err) {
      (opts.log || noopLogger()).error('Sync failed', { surveyId, errorName: err.name });
      results.push({ surveyId, status: 'failed', error: err.message });
    }
  }

  return results;
}

/**
 * Merges freshly fetched responses over the retained set, keyed on id.
 * Later versions of a response win; order is stable by id so the written
 * CSV does not churn between syncs.
 */
function mergeResponses(existing, fetched) {
  const byId = new Map();
  for (const response of existing) byId.set(response.id, response);
  for (const response of fetched) byId.set(response.id, response);

  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Removes respondent identifiers before anything is persisted.
 *
 * SurveyMonkey returns contact details on responses collected through email
 * collectors. The tables never expose them, so retaining them in the stored
 * raw set would mean holding personal data the connector has no use for.
 * Language is kept because it is genuinely analytical.
 */
function stripResponsePii(response) {
  const clean = { ...response };
  delete clean.ip_address;

  if (clean.metadata && clean.metadata.contact) {
    const { language } = clean.metadata.contact;
    clean.metadata = { ...clean.metadata, contact: language ? { language } : {} };
  }

  return clean;
}

/** Latest date_modified across responses, as an ISO string. */
function maxDateModified(responses) {
  let max = null;

  for (const response of responses) {
    const value = response.date_modified || response.date_created;
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) continue;
    if (max === null || time > max) max = time;
  }

  return max === null ? null : new Date(max).toISOString();
}

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

module.exports = {
  syncSurvey,
  syncAll,
  getSyncConfig,
  mergeResponses,
  stripResponsePii,
  maxDateModified,
};
