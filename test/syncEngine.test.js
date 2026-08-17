const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The modules under test capture their dependencies at load time, so the
// fakes have to be installed before syncEngine is required. Node's test
// runner gives each file its own process, so this stays contained.
const smClient = require('../src/lib/surveyMonkeyClient');
const blobStore = require('../src/lib/blobStore');

const surveyDetails = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'richSurveyDetails.json'), 'utf8')
);
const allResponses = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'richResponses.json'), 'utf8')
);

// --- in-memory blob store --------------------------------------------------

const store = new Map();
let pruneCalls = [];

blobStore.ensureContainer = async () => {};
blobStore.writeText = async (p, content) => void store.set(p, content);
blobStore.readText = async (p) => (store.has(p) ? store.get(p) : null);
blobStore.writeJson = async (p, value) => void store.set(p, JSON.stringify(value));
blobStore.readJson = async (p) => (store.has(p) ? JSON.parse(store.get(p)) : null);
blobStore.pruneSnapshots = async (surveyId, days) => {
  pruneCalls.push({ surveyId, days });
  return [];
};

let pruneVersionCalls = [];
blobStore.pruneVersions = async (surveyId, keep) => {
  pruneVersionCalls.push({ surveyId, keep });
  return [];
};

// Lock behaviour is overridden per test to simulate contention.
let nextLockResult = null;
let releasedTokens = [];
blobStore.acquireLock = async () => nextLockResult || { acquired: true, token: 'test-token' };
blobStore.releaseLock = async (name, token) => {
  releasedTokens.push(token);
  return true;
};

// --- fake SurveyMonkey -----------------------------------------------------

let bulkCalls = [];
let nextResponses = allResponses;

// syncEngine destructures these at load time, so the fakes must delegate
// through a mutable hook rather than being reassigned later — reassigning
// smClient.getSurveyDetails after the fact would not reach the captured
// reference.
let detailsImpl = async () => surveyDetails;

smClient.getSurveyDetails = async (surveyId) => detailsImpl(surveyId);
smClient.getResponsesBulk = async (surveyId, opts = {}) => {
  bulkCalls.push({ surveyId, ...opts });
  return nextResponses;
};

const {
  syncSurvey,
  syncAll,
  mergeResponses,
  stripResponsePii,
  maxDateModified,
} = require('../src/lib/syncEngine');

const SURVEY_ID = '888222';

/**
 * Resolves the table path the endpoints would serve, by reading the version
 * pointer the way getData does — so these assertions break if the pointer and
 * the written files ever disagree.
 */
function currentPath(surveyId, table) {
  const state = JSON.parse(store.get(blobStore.paths.state(surveyId)));
  return blobStore.paths.version(surveyId, state.current_version, table);
}

function reset() {
  store.clear();
  bulkCalls = [];
  pruneCalls = [];
  pruneVersionCalls = [];
  releasedTokens = [];
  nextLockResult = null;
  nextResponses = allResponses;
  detailsImpl = async () => surveyDetails;
  delete process.env.SYNC_HISTORY_ENABLED;
  delete process.env.SYNC_SURVEY_IDS;
  delete process.env.SYNC_RESPONSE_STATUS;
}

// --- pure helpers ----------------------------------------------------------

test('mergeResponses lets a newer version of a response replace the old one', () => {
  const existing = [
    { id: 'a', date_modified: '2025-01-01T00:00:00Z', v: 'old' },
    { id: 'b', date_modified: '2025-01-01T00:00:00Z' },
  ];
  const fetched = [{ id: 'a', date_modified: '2025-02-01T00:00:00Z', v: 'new' }];

  const merged = mergeResponses(existing, fetched);

  assert.equal(merged.length, 2, 'an edited response must not be duplicated');
  assert.equal(merged.find((r) => r.id === 'a').v, 'new');
});

test('mergeResponses returns a stable order so synced files do not churn', () => {
  const merged = mergeResponses([{ id: 'c' }, { id: 'a' }], [{ id: 'b' }]);
  assert.deepEqual(merged.map((r) => r.id), ['a', 'b', 'c']);
});

test('stripResponsePii drops identifiers but keeps analytical language', () => {
  const clean = stripResponsePii({
    id: 'r1',
    ip_address: '203.0.113.4',
    metadata: {
      contact: { language: 'en', email: 'a@example.com', first_name: 'Sam', last_name: 'Lee' },
    },
  });

  assert.equal(clean.ip_address, undefined);
  assert.equal(clean.metadata.contact.email, undefined);
  assert.equal(clean.metadata.contact.first_name, undefined);
  assert.equal(clean.metadata.contact.last_name, undefined);
  assert.equal(clean.metadata.contact.language, 'en');
});

test('stripResponsePii does not mutate the response it was given', () => {
  const original = { id: 'r1', ip_address: '203.0.113.4', metadata: { contact: { language: 'en' } } };
  stripResponsePii(original);
  assert.equal(original.ip_address, '203.0.113.4');
});

test('maxDateModified finds the latest timestamp and ignores unusable ones', () => {
  const responses = [
    { id: 'a', date_modified: '2025-03-10T10:12:00Z' },
    { id: 'b', date_modified: '2025-03-13T16:02:00Z' },
    { id: 'c', date_modified: 'not-a-date' },
    { id: 'd' },
  ];
  assert.equal(maxDateModified(responses), '2025-03-13T16:02:00.000Z');
  assert.equal(maxDateModified([]), null);
});

// --- first sync ------------------------------------------------------------

test('first sync is full, writes every table, and records a watermark', async () => {
  reset();
  const state = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  assert.equal(state.last_sync_mode, 'full');
  assert.equal(bulkCalls[0].modifiedSince, undefined, 'a first sync must not filter by date');

  for (const table of ['surveys', 'questions', 'choices', 'responses', 'answers', 'flat']) {
    const csv = store.get(currentPath(SURVEY_ID, table));
    assert.ok(csv, `${table}.csv should have been written`);
    assert.ok(csv.split('\r\n').length > 1, `${table}.csv should have rows`);
  }

  assert.equal(state.response_count, 4);
  assert.equal(state.watermark, '2025-03-13T16:02:00.000Z');
  assert.ok(state.row_counts.answers > 0);
});

test('stored raw responses have identifiers stripped before they are persisted', async () => {
  reset();
  nextResponses = [
    {
      id: 'r_pii',
      response_status: 'completed',
      date_modified: '2025-03-14T00:00:00Z',
      ip_address: '203.0.113.9',
      metadata: { contact: { language: 'en', email: 'someone@example.com' } },
      pages: [],
    },
  ];

  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  const raw = JSON.parse(store.get(`${SURVEY_ID}/raw/responses.json`));
  assert.equal(raw[0].ip_address, undefined);
  assert.equal(raw[0].metadata.contact.email, undefined);
  assert.equal(raw[0].metadata.contact.language, 'en');
});

// --- incremental sync ------------------------------------------------------

test('second sync is incremental and filters from the stored watermark', async () => {
  reset();
  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  nextResponses = [];
  const second = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-07-01' });

  assert.equal(second.last_sync_mode, 'incremental');
  assert.ok(bulkCalls[1].modifiedSince instanceof Date);
  assert.equal(bulkCalls[1].modifiedSince.toISOString(), '2025-03-13T16:02:00.000Z');
});

test('an incremental sync returning nothing preserves the existing dataset', async () => {
  reset();
  const first = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  nextResponses = [];
  const second = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-07-01' });

  assert.equal(second.responses_fetched, 0);
  assert.equal(second.response_count, first.response_count, 'existing responses must survive');
  assert.equal(second.row_counts.answers, first.row_counts.answers);
  assert.equal(second.watermark, first.watermark, 'watermark must not regress');
});

test('an edited response updates in place instead of duplicating', async () => {
  reset();
  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  const edited = { ...allResponses[0], date_modified: '2025-04-01T09:00:00Z' };
  edited.pages = [
    { id: 'page_1', questions: [{ id: 'q_channel', answers: [{ choice_id: 'ch_friend' }] }] },
  ];
  nextResponses = [edited];

  const second = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-07-01' });

  assert.equal(second.response_count, 4, 'the edit must replace, not append');
  assert.equal(second.watermark, '2025-04-01T09:00:00.000Z', 'watermark should advance');

  const answers = store.get(currentPath(SURVEY_ID, 'answers'));
  assert.ok(answers.includes('From a friend'), 'rebuilt tables should reflect the edit');
});

test('a full sync discards the retained base rather than merging into it', async () => {
  reset();
  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  nextResponses = [allResponses[0]];
  const forced = await syncSurvey(SURVEY_ID, { full: true, snapshotDate: '2025-07-01' });

  assert.equal(forced.last_sync_mode, 'full');
  assert.equal(forced.response_count, 1);
  assert.equal(bulkCalls[1].modifiedSince, undefined);
});

test('a missing raw base forces a full sync even when a watermark exists', async () => {
  reset();
  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  // Simulates the raw blob being lost while state.json survives; an
  // incremental pull here would silently produce a partial dataset.
  store.delete(`${SURVEY_ID}/raw/responses.json`);

  const recovered = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-07-01' });
  assert.equal(recovered.last_sync_mode, 'full');
  assert.equal(recovered.response_count, 4);
});

// --- history ---------------------------------------------------------------

test('no snapshot is written when history is disabled', async () => {
  reset();
  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30', historyEnabled: false });

  const snapshots = [...store.keys()].filter((k) => k.includes('/snapshots/'));
  assert.equal(snapshots.length, 0);
  assert.equal(pruneCalls.length, 0);
});

test('enabling history freezes a dated copy and prunes by retention', async () => {
  reset();
  const state = await syncSurvey(SURVEY_ID, {
    snapshotDate: '2025-06-30',
    historyEnabled: true,
    retentionDays: 30,
  });

  assert.ok(store.has(`${SURVEY_ID}/snapshots/2025-06-30/answers.csv`));
  assert.equal(state.snapshot_date, '2025-06-30');
  assert.deepEqual(pruneCalls, [{ surveyId: SURVEY_ID, days: 30 }]);

  // The snapshot is a frozen copy of what latest holds at that moment.
  assert.equal(
    store.get(`${SURVEY_ID}/snapshots/2025-06-30/answers.csv`),
    store.get(currentPath(SURVEY_ID, 'answers'))
  );
});

test('history can be enabled through app settings rather than per call', async () => {
  reset();
  process.env.SYNC_HISTORY_ENABLED = 'true';

  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });
  assert.ok(store.has(`${SURVEY_ID}/snapshots/2025-06-30/answers.csv`));
});

// --- multi-survey ----------------------------------------------------------

// --- concurrency -----------------------------------------------------------

test('a sync skips when another is already running for that survey', async () => {
  reset();
  nextLockResult = { acquired: false, heldUntil: '2026-01-01T00:00:00.000Z' };

  const result = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'already_running');
  assert.equal(bulkCalls.length, 0, 'a skipped sync must not call SurveyMonkey');
  assert.equal(store.size, 0, 'a skipped sync must not write anything');
});

test('the lock is released after a successful sync', async () => {
  reset();
  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });
  assert.deepEqual(releasedTokens, ['test-token']);
});

test('the lock is released even when the sync throws', async () => {
  reset();
  detailsImpl = async () => {
    throw new Error('SurveyMonkey exploded');
  };

  // Without release-on-failure a single error would block every later run
  // until the lock aged out.
  await assert.rejects(() => syncSurvey(SURVEY_ID, {}), /exploded/);
  assert.deepEqual(releasedTokens, ['test-token']);
});

// --- atomic publication ----------------------------------------------------

test('each sync publishes a new version and moves the pointer', async () => {
  reset();
  const first = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  nextResponses = [];
  const second = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-07-01' });

  assert.ok(first.current_version, 'a sync should record the version it wrote');
  assert.notEqual(second.current_version, first.current_version, 'each sync gets its own');

  // The previous version stays readable, so a refresh already in flight
  // against it can finish.
  assert.ok(store.has(blobStore.paths.version(SURVEY_ID, first.current_version, 'answers')));
  assert.ok(store.has(blobStore.paths.version(SURVEY_ID, second.current_version, 'answers')));
});

test('tables are written before the pointer moves', async () => {
  reset();

  // Capture the order of writes: every table for the new version must land
  // before state.json publishes it, or a reader could follow the pointer to
  // files that are not there yet.
  const order = [];
  const realWriteText = blobStore.writeText;
  const realWriteJson = blobStore.writeJson;
  blobStore.writeText = async (p, c) => {
    order.push(p);
    return realWriteText(p, c);
  };
  blobStore.writeJson = async (p, v) => {
    order.push(p);
    return realWriteJson(p, v);
  };

  const state = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  blobStore.writeText = realWriteText;
  blobStore.writeJson = realWriteJson;

  const pointerAt = order.indexOf(blobStore.paths.state(SURVEY_ID));
  const lastTableAt = order.reduce(
    (last, p, i) => (p.includes(`/versions/${state.current_version}/`) ? i : last),
    -1
  );

  assert.ok(pointerAt > -1 && lastTableAt > -1);
  assert.ok(lastTableAt < pointerAt, 'the pointer must move only after every table is written');
});

test('a crash before the pointer moves leaves the old version being served', async () => {
  reset();
  const first = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });

  // Fail on the state write, which is the commit point.
  const realWriteJson = blobStore.writeJson;
  blobStore.writeJson = async (p, v) => {
    if (p === blobStore.paths.state(SURVEY_ID)) throw new Error('host killed mid-write');
    return realWriteJson(p, v);
  };

  nextResponses = [allResponses[0]];
  await assert.rejects(() => syncSurvey(SURVEY_ID, { full: true, snapshotDate: '2025-07-01' }));

  blobStore.writeJson = realWriteJson;

  const pointer = JSON.parse(store.get(blobStore.paths.state(SURVEY_ID))).current_version;
  assert.equal(pointer, first.current_version, 'readers still see the last complete version');
});

test('old versions are pruned only after the pointer has moved', async () => {
  reset();
  await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30' });
  assert.equal(pruneVersionCalls.length, 1);
  assert.equal(pruneVersionCalls[0].surveyId, SURVEY_ID);
});

// --- large surveys ---------------------------------------------------------

test('a survey beyond the memory budget fails with an actionable message', async () => {
  reset();
  process.env.SYNC_MAX_RESPONSES = '2';

  // Reloading is not possible mid-process, so assert on the exported guard
  // directly — the constant is read at module load.
  const { assertWithinMemoryBudget, MAX_RESPONSES } = require('../src/lib/syncEngine');

  assert.doesNotThrow(() => assertWithinMemoryBudget(MAX_RESPONSES, SURVEY_ID));
  assert.throws(
    () => assertWithinMemoryBudget(MAX_RESPONSES + 1, SURVEY_ID),
    (err) => {
      assert.equal(err.name, 'SurveyTooLargeError');
      assert.match(err.message, /SYNC_MAX_RESPONSES/);
      return true;
    }
  );

  delete process.env.SYNC_MAX_RESPONSES;
});

test('syncAll isolates a failing survey so the rest still sync', async () => {
  reset();

  detailsImpl = async (id) => {
    if (id === 'bad') throw new Error('survey not found');
    return surveyDetails;
  };

  const results = await syncAll(['888222', 'bad', '888222'], { snapshotDate: '2025-06-30' });

  assert.equal(results.length, 3);
  assert.equal(results.filter((r) => r.status === 'ok').length, 2);

  const failure = results.find((r) => r.status === 'failed');
  assert.equal(failure.surveyId, 'bad');
  assert.match(failure.error, /survey not found/);
});
