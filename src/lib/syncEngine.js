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
const setupConfig = require('./setupConfig');

/**
 * How long a sync may hold its lock before another run is entitled to assume
 * it died. Comfortably longer than the 10-minute Function timeout, so a slow
 * but living sync is never elbowed aside by the next scheduled run.
 */
const LOCK_TTL_MS = Number(process.env.SYNC_LOCK_TTL_MS) || 20 * 60 * 1000;

/** Older table versions retained after a sync. */
const VERSIONS_KEPT = Number(process.env.SYNC_VERSIONS_KEPT) || 2;

/**
 * Ceiling on responses held in memory at once.
 *
 * The whole survey is materialised — raw responses, then the derived tables —
 * so memory scales with response count, and a Consumption plan caps around
 * 1.5 GB. Past some size the host is killed mid-write, which is a far worse
 * failure than a clear message: it looks like a hang, leaves no explanation,
 * and repeats every schedule. Set SYNC_MAX_RESPONSES higher on a plan with
 * more memory.
 */
const MAX_RESPONSES = Number(process.env.SYNC_MAX_RESPONSES) || 200_000;

function assertWithinMemoryBudget(responseCount, surveyId) {
  if (responseCount <= MAX_RESPONSES) return;

  const err = new Error(
    `Survey ${surveyId} has ${responseCount} responses, above the ${MAX_RESPONSES} that this ` +
      'connector holds in memory at once. Raise SYNC_MAX_RESPONSES if the Function App has ' +
      'the memory for it, or narrow the sync with modifiedSince or SYNC_SURVEY_IDS.'
  );
  err.name = 'SurveyTooLargeError';
  throw err;
}

/** Sortable, collision-free version identifier. */
function newVersionId() {
  return `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Effective sync configuration: whatever the setup wizard saved, layered over
 * application settings. See setupConfig.js for why it works that way.
 */
async function getSyncConfig() {
  return setupConfig.loadConfig();
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
  await blobStore.ensureContainer();

  // One sync per survey at a time. A second one skips rather than queueing:
  // it would fetch the same data and write the same blobs, so waiting for the
  // first to finish only burns quota and risks the HTTP request timing out.
  const lock = await blobStore.acquireLock(`sync-${surveyId}`, LOCK_TTL_MS);

  if (!lock.acquired) {
    (opts.log || noopLogger()).warn('Sync already running for this survey; skipping', {
      surveyId,
    });
    return {
      survey_id: surveyId,
      skipped: true,
      reason: 'already_running',
      held_until: lock.heldUntil || null,
    };
  }

  try {
    return await runSync(surveyId, opts);
  } finally {
    await blobStore.releaseLock(`sync-${surveyId}`, lock.token).catch(() => {
      // A lock we cannot release will expire on its own; failing the sync
      // over cleanup would turn a successful run into a reported failure.
    });
  }
}

/** The sync itself, with the lock already held. */
async function runSync(surveyId, opts = {}) {
  const config = await getSyncConfig();
  const log = opts.log || noopLogger();
  const startedAt = Date.now();

  const historyEnabled = opts.historyEnabled !== undefined ? opts.historyEnabled : config.historyEnabled;
  const retentionDays = opts.retentionDays !== undefined ? opts.retentionDays : config.retentionDays;
  const snapshotDate = opts.snapshotDate || new Date().toISOString().slice(0, 10);

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

  assertWithinMemoryBudget(merged.length, surveyId);

  const tables = buildTables(details, merged, { snapshotDate });
  const flat = buildFlatTable(tables);
  const allTables = { ...tables, flat };

  // Write the raw base first. If a later write fails, the next run still has
  // a consistent base to merge into rather than re-pulling from scratch.
  await blobStore.writeJson(blobStore.paths.raw(surveyId), merged);

  // Tables go into a fresh version directory rather than overwriting the one
  // being served. Six sequential writes are not atomic, so overwriting in
  // place means a crash or timeout partway through leaves readers with a mix
  // of new and stale tables — an `answers` row pointing at a `questions` row
  // that is not there yet. Writing aside and then flipping a single pointer
  // makes the switch all-or-nothing.
  const version = opts.version || newVersionId();

  for (const table of TABLE_NAMES) {
    const csv = toCsv(allTables[table], TABLE_COLUMNS[table]);
    await blobStore.writeText(blobStore.paths.version(surveyId, version, table), csv);
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
    current_version: version,
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

  // The commit point. Until this single write lands, readers keep seeing the
  // previous version; after it, they see the new one. There is no in-between.
  await blobStore.writeJson(blobStore.paths.state(surveyId), state);

  // Only prune once the pointer has moved, so a failure above leaves the
  // previous version intact and still being served.
  state.versions_pruned = await blobStore.pruneVersions(surveyId, VERSIONS_KEPT);

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
  newVersionId,
  assertWithinMemoryBudget,
  LOCK_TTL_MS,
  VERSIONS_KEPT,
  MAX_RESPONSES,
};
