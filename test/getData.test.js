/**
 * Tests the data-serving endpoints by capturing the handlers at registration
 * time and invoking them directly.
 *
 * The Azure Functions host is not involved, so these run offline like the rest
 * of the unit suite. What they cover is the endpoint's own logic — argument
 * validation, table and format checks, and the difference between "you asked
 * for the wrong thing" and "this has not been synced yet", which is the
 * distinction a user hitting a 404 actually needs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Capture handlers instead of registering them with a real Functions host.
const azureFunctions = require('@azure/functions');
const handlers = {};
azureFunctions.app.http = (name, config) => {
  handlers[name] = config.handler;
};
azureFunctions.app.timer = () => {};

const blobStore = require('../src/lib/blobStore');
const { toCsv } = require('../src/lib/csv');

// In-memory storage standing in for blob.
const store = new Map();
let storageFails = false;

const guard = () => {
  if (storageFails) throw Object.assign(new Error('storage down'), { name: 'RestError' });
};

blobStore.readText = async (p) => (guard(), store.has(p) ? store.get(p) : null);
blobStore.readJson = async (p) => (guard(), store.has(p) ? JSON.parse(store.get(p)) : null);
blobStore.listSnapshotDates = async () => (guard(), ['2025-06-30', '2025-05-30']);

require('../src/functions/getData');
require('../src/functions/getStatus');

const context = { log() {}, warn() {}, error() {} };

function request({ params = {}, query = {} } = {}) {
  return {
    params,
    query: { get: (key) => (key in query ? query[key] : null) },
  };
}

const callData = (params, query) => handlers.getData(request({ params, query }), context);
const callStatus = (params) => handlers.getStatus(request({ params }), context);

const ANSWERS_CSV = toCsv(
  [
    { response_id: 'r1', value_text: 'Good', value_numeric: 4, is_skipped: false },
    { response_id: 'r2', value_text: null, value_numeric: null, is_skipped: true },
  ],
  ['response_id', 'value_text', 'value_numeric', 'is_skipped']
);

function reset() {
  store.clear();
  storageFails = false;
  store.set(blobStore.paths.latest('s1', 'answers'), ANSWERS_CSV);
}

// --- serving data ----------------------------------------------------------

test('serves a synced table as CSV by default', async () => {
  reset();
  const res = await callData({ surveyId: 's1', table: 'answers' });

  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.equal(res.body, ANSWERS_CSV);
});

test('serves JSON with declared columns typed, on request', async () => {
  reset();
  const res = await callData({ surveyId: 's1', table: 'answers' }, { format: 'json' });

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.table, 'answers');
  assert.equal(res.jsonBody.survey_id, 's1');

  const [first, second] = res.jsonBody.data;
  assert.equal(first.value_numeric, 4, 'declared number columns must not come back as strings');
  assert.equal(first.is_skipped, false);
  assert.equal(second.value_text, null, 'blank fields become null');
  assert.equal(second.is_skipped, true);
});

test('format is case-insensitive', async () => {
  reset();
  const res = await callData({ surveyId: 's1', table: 'answers' }, { format: 'JSON' });
  assert.equal(res.status, 200);
  assert.ok(res.jsonBody.data);
});

test('an unknown table is rejected and the valid ones are listed', async () => {
  reset();
  const res = await callData({ surveyId: 's1', table: 'nonsense' });

  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.error, 'unknown_table');
  assert.ok(res.jsonBody.available.includes('answers'));
});

test('an unsupported format is rejected', async () => {
  reset();
  const res = await callData({ surveyId: 's1', table: 'answers' }, { format: 'xml' });

  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.error, 'invalid_format');
});

test('a never-synced survey explains how to sync rather than just 404ing', async () => {
  reset();
  const res = await callData({ surveyId: 'unsynced', table: 'answers' });

  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.error, 'not_synced');
  assert.match(res.jsonBody.message, /POST \/api\/sync\/unsynced/);
});

test('every declared table name is routable', async () => {
  reset();
  for (const table of ['surveys', 'questions', 'choices', 'responses', 'answers', 'flat']) {
    store.set(blobStore.paths.latest('s1', table), ANSWERS_CSV);
    const res = await callData({ surveyId: 's1', table });
    assert.equal(res.status, 200, `${table} should be servable`);
  }
});

// --- snapshots -------------------------------------------------------------

test('a snapshot is served when a valid date is given', async () => {
  reset();
  store.set(blobStore.paths.snapshot('s1', '2025-06-30', 'answers'), 'frozen,data\r\n1,2\r\n');

  const res = await callData({ surveyId: 's1', table: 'answers' }, { snapshot: '2025-06-30' });

  assert.equal(res.status, 200);
  assert.equal(res.body, 'frozen,data\r\n1,2\r\n');
});

test('a malformed snapshot date is rejected before touching storage', async () => {
  reset();
  const res = await callData({ surveyId: 's1', table: 'answers' }, { snapshot: 'yesterday' });

  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.error, 'invalid_snapshot');
});

test('a missing snapshot points at the status endpoint', async () => {
  reset();
  const res = await callData({ surveyId: 's1', table: 'answers' }, { snapshot: '2001-01-01' });

  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.error, 'snapshot_not_found');
  assert.match(res.jsonBody.message, /\/status/);
});

// --- status ----------------------------------------------------------------

test('status reports sync state, snapshots and table URLs', async () => {
  reset();
  store.set(
    blobStore.paths.state('s1'),
    JSON.stringify({
      survey_id: 's1',
      last_sync_at: '2026-08-16T19:00:00.000Z',
      last_sync_mode: 'incremental',
      watermark: '2025-03-13T16:02:00.000Z',
      response_count: 4,
      row_counts: { answers: 19 },
      history_enabled: true,
    })
  );

  const res = await callStatus({ surveyId: 's1' });

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.synced, true);
  assert.equal(res.jsonBody.last_sync_mode, 'incremental');
  assert.equal(res.jsonBody.response_count, 4);
  assert.deepEqual(res.jsonBody.snapshots, ['2025-06-30', '2025-05-30']);
  assert.ok(res.jsonBody.tables.some((t) => t.url === '/api/surveys/s1/data/answers'));
});

test('status for a never-synced survey says so explicitly', async () => {
  reset();
  const res = await callStatus({ surveyId: 'unsynced' });

  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.synced, false);
  assert.equal(res.jsonBody.error, 'not_synced');
});

// --- failure handling ------------------------------------------------------

test('a storage outage is reported as 502, not a broken 500', async () => {
  reset();
  storageFails = true;

  const data = await callData({ surveyId: 's1', table: 'answers' });
  assert.equal(data.status, 502);
  assert.equal(data.jsonBody.error, 'storage_unavailable');

  const status = await callStatus({ surveyId: 's1' });
  assert.equal(status.status, 502);
  assert.equal(status.jsonBody.error, 'storage_unavailable');
});

test('no response body ever leaks storage internals', async () => {
  reset();
  storageFails = true;

  const res = await callData({ surveyId: 's1', table: 'answers' });
  assert.ok(!JSON.stringify(res.jsonBody).includes('storage down'));
});
