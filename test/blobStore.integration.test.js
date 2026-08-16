/**
 * Integration tests for the storage layer, run against a real Azure Storage
 * API rather than in-memory fakes.
 *
 * These are skipped unless STORAGE_CONNECTION_STRING is set, so the default
 * `npm test` stays offline and dependency-free. To run them:
 *
 *   npx azurite-blob --location /tmp/azurite --blobPort 10000 &
 *   STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true npm test
 *
 * They exist because the unit tests substitute an in-memory store for
 * blobStore, which means nothing else verifies that the real SDK calls,
 * container creation, not-found handling, listing and prefix deletion behave
 * as this code assumes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONNECTION_STRING = process.env.STORAGE_CONNECTION_STRING;
const skip = CONNECTION_STRING
  ? false
  : 'set STORAGE_CONNECTION_STRING (e.g. UseDevelopmentStorage=true with Azurite) to run';

// A unique container per run keeps repeat runs and parallel checkouts from
// colliding.
process.env.STORAGE_CONTAINER = `test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
delete process.env.STORAGE_ACCOUNT_URL;

const smClient = require('../src/lib/surveyMonkeyClient');

const surveyDetails = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'richSurveyDetails.json'), 'utf8')
);
const allResponses = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'richResponses.json'), 'utf8')
);

let nextResponses = allResponses;
smClient.getSurveyDetails = async () => surveyDetails;
smClient.getResponsesBulk = async () => nextResponses;

const blobStore = require('../src/lib/blobStore');
const { syncSurvey } = require('../src/lib/syncEngine');

// Capture the serving handlers so the sync-then-serve path can be exercised
// against real storage.
const azureFunctions = require('@azure/functions');
const handlers = {};
azureFunctions.app.http = (name, config) => {
  handlers[name] = config.handler;
};
azureFunctions.app.timer = () => {};
require('../src/functions/getData');
require('../src/functions/getStatus');

const fnContext = { log() {}, warn() {}, error() {} };
const serve = (params, query = {}) =>
  handlers.getData(
    { params, query: { get: (k) => (k in query ? query[k] : null) } },
    fnContext
  );
const serveStatus = (params) =>
  handlers.getStatus({ params, query: { get: () => null } }, fnContext);

const SURVEY_ID = '888222';

// --- storage primitives ----------------------------------------------------

test('container is created on demand and writes round-trip', { skip }, async () => {
  await blobStore.ensureContainer();
  await blobStore.writeText('probe/hello.csv', 'a,b\r\n1,2\r\n');

  assert.equal(await blobStore.readText('probe/hello.csv'), 'a,b\r\n1,2\r\n');
  assert.equal(await blobStore.exists('probe/hello.csv'), true);
});

test('reading a blob that does not exist returns null, not an error', { skip }, async () => {
  assert.equal(await blobStore.readText('probe/definitely-absent.csv'), null);
  assert.equal(await blobStore.readJson('probe/definitely-absent.json'), null);
  assert.equal(await blobStore.exists('probe/definitely-absent.csv'), false);
});

test('JSON round-trips through storage intact', { skip }, async () => {
  const value = { watermark: '2025-03-13T16:02:00.000Z', counts: { answers: 12 }, list: [1, 2] };
  await blobStore.writeJson('probe/state.json', value);
  assert.deepEqual(await blobStore.readJson('probe/state.json'), value);
});

test('malformed JSON is treated as absent rather than wedging the sync', { skip }, async () => {
  await blobStore.writeText('probe/broken.json', '{ this is not json');
  assert.equal(await blobStore.readJson('probe/broken.json'), null);
});

test('non-ASCII and embedded newlines survive a storage round-trip', { skip }, async () => {
  const content = 'v\r\n"Café — 日本語"\r\n"line1\nline2"\r\n';
  await blobStore.writeText('probe/unicode.csv', content);
  assert.equal(await blobStore.readText('probe/unicode.csv'), content);
});

test('overwriting a blob replaces it rather than appending', { skip }, async () => {
  await blobStore.writeText('probe/overwrite.csv', 'first-and-longer');
  await blobStore.writeText('probe/overwrite.csv', 'second');
  assert.equal(await blobStore.readText('probe/overwrite.csv'), 'second');
});

test('listing returns blobs under a prefix only', { skip }, async () => {
  await blobStore.writeText('listing/a/one.csv', 'x');
  await blobStore.writeText('listing/a/two.csv', 'x');
  await blobStore.writeText('listing/b/three.csv', 'x');

  const names = await blobStore.listNames('listing/a/');
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => n.startsWith('listing/a/')));
});

test('openReadStream streams content back and returns null when absent', { skip }, async () => {
  await blobStore.writeText('probe/stream.csv', 'streamed content');

  const opened = await blobStore.openReadStream('probe/stream.csv');
  assert.ok(opened.stream);

  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'streamed content');

  assert.equal(await blobStore.openReadStream('probe/nope.csv'), null);
});

// --- snapshot retention ----------------------------------------------------

test('snapshot dates are discovered from the path, newest first', { skip }, async () => {
  const id = 'retention-survey';
  for (const date of ['2025-01-01', '2025-03-01', '2025-02-01']) {
    await blobStore.writeText(blobStore.paths.snapshot(id, date, 'answers'), 'x');
  }

  assert.deepEqual(await blobStore.listSnapshotDates(id), [
    '2025-03-01',
    '2025-02-01',
    '2025-01-01',
  ]);
});

test('pruning deletes snapshots past the retention window', { skip }, async () => {
  const id = 'prune-survey';
  const old = '2020-01-01';
  const recent = new Date().toISOString().slice(0, 10);

  await blobStore.writeText(blobStore.paths.snapshot(id, old, 'answers'), 'x');
  await blobStore.writeText(blobStore.paths.snapshot(id, old, 'responses'), 'x');
  await blobStore.writeText(blobStore.paths.snapshot(id, recent, 'answers'), 'x');

  const pruned = await blobStore.pruneSnapshots(id, 30);

  assert.deepEqual(pruned, [old]);
  assert.equal(await blobStore.exists(blobStore.paths.snapshot(id, old, 'answers')), false);
  assert.equal(await blobStore.exists(blobStore.paths.snapshot(id, old, 'responses')), false);
  assert.equal(await blobStore.exists(blobStore.paths.snapshot(id, recent, 'answers')), true);
});

test('pruning always keeps at least one snapshot, however old', { skip }, async () => {
  const id = 'keepmin-survey';
  await blobStore.writeText(blobStore.paths.snapshot(id, '2019-01-01', 'answers'), 'x');

  assert.deepEqual(await blobStore.pruneSnapshots(id, 30), []);
  assert.equal(await blobStore.exists(blobStore.paths.snapshot(id, '2019-01-01', 'answers')), true);
});

test('retention of zero or less disables pruning entirely', { skip }, async () => {
  const id = 'noprune-survey';
  await blobStore.writeText(blobStore.paths.snapshot(id, '2019-01-01', 'answers'), 'x');
  assert.deepEqual(await blobStore.pruneSnapshots(id, 0), []);
});

// --- full pipeline against real storage ------------------------------------

test('a full sync writes every table to real storage', { skip }, async () => {
  nextResponses = allResponses;
  const state = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-06-30', full: true });

  assert.equal(state.last_sync_mode, 'full');
  assert.equal(state.response_count, 4);

  for (const table of ['surveys', 'questions', 'choices', 'responses', 'answers', 'flat']) {
    const csv = await blobStore.readText(blobStore.paths.latest(SURVEY_ID, table));
    assert.ok(csv, `${table}.csv should exist in storage`);
    assert.ok(csv.startsWith('﻿'), `${table}.csv should carry a UTF-8 BOM`);
  }

  const answers = await blobStore.readText(blobStore.paths.latest(SURVEY_ID, 'answers'));
  assert.ok(answers.includes('Conference booth'), 'other-specify text should be present');
});

test('state.json is persisted and drives the next incremental sync', { skip }, async () => {
  const persisted = await blobStore.readJson(blobStore.paths.state(SURVEY_ID));
  assert.equal(persisted.watermark, '2025-03-13T16:02:00.000Z');

  nextResponses = [];
  const second = await syncSurvey(SURVEY_ID, { snapshotDate: '2025-07-01' });

  assert.equal(second.last_sync_mode, 'incremental');
  assert.equal(second.response_count, 4, 'stored responses must survive an empty delta');
});

test('CSV written to storage parses back with quoting intact', { skip }, async () => {
  const csv = await blobStore.readText(blobStore.paths.latest(SURVEY_ID, 'answers'));
  const body = csv.replace(/^﻿/, '');

  // The fixture contains an answer with quotes, a comma and a newline in it;
  // it must come back as one field rather than corrupting the row.
  assert.ok(body.includes('"Faster exports, please. Also: ""dark mode"", commas, and\nnewlines."'));

  // And the formula-injection guard must have survived serialization.
  assert.ok(body.includes("'=SUM(A1:A9)"));
});

test('snapshots are written to real storage when history is enabled', { skip }, async () => {
  const id = 'history-survey';
  nextResponses = allResponses;

  await syncSurvey(id, { snapshotDate: '2025-06-30', historyEnabled: true, full: true });

  const snapshot = await blobStore.readText(blobStore.paths.snapshot(id, '2025-06-30', 'answers'));
  const latest = await blobStore.readText(blobStore.paths.latest(id, 'answers'));

  assert.ok(snapshot);
  assert.equal(snapshot, latest, 'a snapshot is a frozen copy of latest');
});

// --- sync, then serve ------------------------------------------------------

test('a synced table is served straight back out as CSV', { skip }, async () => {
  const res = await serve({ surveyId: SURVEY_ID, table: 'answers' });

  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.equal(res.body, await blobStore.readText(blobStore.paths.latest(SURVEY_ID, 'answers')));
});

test('serving as JSON returns typed values from real storage', { skip }, async () => {
  const res = await serve({ surveyId: SURVEY_ID, table: 'answers' }, { format: 'json' });

  assert.equal(res.status, 200);

  const rating = res.jsonBody.data.find(
    (r) => r.response_id === 'resp_complete' && r.question_id === 'q_rating'
  );
  assert.equal(rating.value_numeric, 4, 'a weighted rating must survive as a number');
  assert.equal(rating.row_text, 'Overall rating');
  assert.equal(rating.is_skipped, false);

  const skipped = res.jsonBody.data.find((r) => r.is_skipped === true);
  assert.equal(skipped.value_text, null);
});

test('survey text with quotes, commas and newlines survives the full round trip', { skip }, async () => {
  const res = await serve({ surveyId: SURVEY_ID, table: 'answers' }, { format: 'json' });

  const comment = res.jsonBody.data.find((r) => r.question_id === 'q_comments' && r.value_text);
  assert.equal(
    comment.value_text,
    'Faster exports, please. Also: "dark mode", commas, and\nnewlines.',
    'the verbatim must come back exactly as the respondent typed it'
  );
});

test('the formula guard is applied in CSV and undone in JSON', { skip }, async () => {
  const csv = await serve({ surveyId: SURVEY_ID, table: 'answers' });
  assert.ok(csv.body.includes("'=SUM(A1:A9)"), 'CSV must stay safe to open in Excel');

  const json = await serve({ surveyId: SURVEY_ID, table: 'answers' }, { format: 'json' });
  const formula = json.jsonBody.data.find((r) => r.value_text === '=SUM(A1:A9)');
  assert.ok(formula, 'JSON consumers should see the original text');
});

test('status reflects a real sync and lists real snapshots', { skip }, async () => {
  const id = 'history-survey';
  const res = await serveStatus({ surveyId: id });

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.synced, true);
  assert.equal(res.jsonBody.history_enabled, true);
  assert.deepEqual(res.jsonBody.snapshots, ['2025-06-30']);
  assert.ok(res.jsonBody.row_counts.answers > 0);
});

test('a snapshot is servable by date from real storage', { skip }, async () => {
  const res = await serve(
    { surveyId: 'history-survey', table: 'answers' },
    { snapshot: '2025-06-30' }
  );

  assert.equal(res.status, 200);
  assert.ok(res.body.includes('Conference booth'));
});

test('an unsynced survey reports not_synced rather than an empty table', { skip }, async () => {
  const res = await serve({ surveyId: 'never-synced-survey', table: 'answers' });
  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.error, 'not_synced');
});
