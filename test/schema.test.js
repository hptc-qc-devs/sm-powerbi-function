const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTables,
  buildFlatTable,
  resolveAnswer,
  stripHtml,
  toNumber,
  TABLE_COLUMNS,
  TABLE_NAMES,
} = require('../src/lib/schema');

const surveyDetails = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'richSurveyDetails.json'), 'utf8')
);
const responses = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'richResponses.json'), 'utf8')
);

const SNAPSHOT_DATE = '2025-06-30';
const tables = buildTables(surveyDetails, responses, { snapshotDate: SNAPSHOT_DATE });

const answersFor = (responseId, questionId) =>
  tables.answers.filter((a) => a.response_id === responseId && a.question_id === questionId);

// --- dimension tables ------------------------------------------------------

test('surveys table has exactly one row carrying survey-level metadata', () => {
  assert.equal(tables.surveys.length, 1);

  const survey = tables.surveys[0];
  assert.equal(survey.survey_id, '888222');
  assert.equal(survey.title, 'Product Feedback Survey - Fixture');
  assert.equal(survey.language, 'en');
  assert.equal(survey.page_count, 2);
  assert.equal(survey.question_count, 8);
  assert.equal(survey.snapshot_date, SNAPSHOT_DATE);
});

test('questions table records page, position, family and subtype', () => {
  assert.equal(tables.questions.length, 8);

  const rating = tables.questions.find((q) => q.question_id === 'q_rating');
  assert.equal(rating.page_id, 'page_1');
  assert.equal(rating.page_position, 1);
  assert.equal(rating.position, 1);
  assert.equal(rating.family, 'matrix');
  assert.equal(rating.subtype, 'rating');
  assert.equal(rating.is_required, true);

  // Questions on the second page keep their own page position.
  const details = tables.questions.find((q) => q.question_id === 'q_details');
  assert.equal(details.page_position, 2);
  assert.equal(details.is_required, false);
});

test('HTML in a question heading is stripped so Power BI shows readable text', () => {
  const rating = tables.questions.find((q) => q.question_id === 'q_rating');
  assert.equal(rating.heading, 'Overall, how would you rate the product?');
});

test('choices table separates choices, matrix rows and the "other" option by kind', () => {
  const forChannel = tables.choices.filter((c) => c.question_id === 'q_channel');
  const kinds = forChannel.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['choice', 'choice', 'other']);

  const other = forChannel.find((c) => c.kind === 'other');
  assert.equal(other.choice_id, 'ch_other');
  assert.equal(other.text, 'Other (please specify)');

  const matrixRows = tables.choices.filter(
    (c) => c.question_id === 'q_staff_matrix' && c.kind === 'row'
  );
  assert.equal(matrixRows.length, 2);
  assert.ok(matrixRows.some((r) => r.text === 'Customer support'));
});

test('choice weights are captured so ratings can be averaged', () => {
  const excellent = tables.choices.find((c) => c.choice_id === 'ch_5');
  assert.equal(excellent.weight, 5);

  // A "Not applicable" option is flagged and carries no weight, so it can be
  // excluded from averages rather than silently counting as zero.
  const notApplicable = tables.choices.find((c) => c.choice_id === 'ch_na');
  assert.equal(notApplicable.is_na, true);
  assert.equal(notApplicable.weight, null);
});

test('responses table carries status, collector and timing but no contact PII', () => {
  assert.equal(tables.responses.length, 4);

  const complete = tables.responses.find((r) => r.response_id === 'resp_complete');
  assert.equal(complete.response_status, 'completed');
  assert.equal(complete.collector_id, 'col_web');
  assert.equal(complete.total_time_seconds, 720);
  assert.equal(complete.language, 'en');

  // Respondent identifiers must never reach the BI model by default.
  for (const row of tables.responses) {
    for (const field of ['ip_address', 'email', 'first_name', 'last_name']) {
      assert.equal(row[field], undefined, `${field} must not be present`);
    }
  }
});

// --- the fact table --------------------------------------------------------

test('rating answers carry the numeric weight, not just the label', () => {
  const [answer] = answersFor('resp_complete', 'q_rating');
  assert.equal(answer.value_text, 'Good');
  assert.equal(answer.value_numeric, 4);
  assert.equal(answer.choice_id, 'ch_4');
  assert.equal(answer.row_id, 'row_overall');
});

test('matrix answers put the row in its own column instead of concatenating', () => {
  const rows = answersFor('resp_complete', 'q_staff_matrix');
  assert.equal(rows.length, 2);

  const support = rows.find((r) => r.row_id === 'row_support');
  assert.equal(support.row_text, 'Customer support');
  assert.equal(support.value_text, 'Good');
  assert.equal(support.value_numeric, 3);

  // The old flat transform produced "Customer support: Good" in one string.
  assert.ok(!rows.some((r) => String(r.value_text).includes(':')));
});

test('"Other (please specify)" keeps both the choice and the typed text', () => {
  const [answer] = answersFor('resp_other_specified', 'q_channel');
  assert.equal(answer.choice_id, 'ch_other');
  assert.equal(answer.value_text, 'Other (please specify)');
  assert.equal(answer.other_text, 'Conference booth');
});

test('open-ended text lands in value_text with no choice attached', () => {
  const [answer] = answersFor('resp_complete', 'q_comments');
  assert.equal(answer.choice_id, null);
  assert.equal(answer.value_numeric, null);
  assert.ok(answer.value_text.startsWith('Faster exports, please.'));
});

test('numerical-textbox answers are parsed into value_numeric', () => {
  const [answer] = answersFor('resp_complete', 'q_age');
  assert.equal(answer.value_text, '3');
  assert.equal(answer.value_numeric, 3);

  // Negative numbers are still numbers.
  const [negative] = answersFor('resp_skipped', 'q_age');
  assert.equal(negative.value_numeric, -2);
});

test('non-numeric text in a numerical question stays text rather than becoming 0', () => {
  const [answer] = answersFor('resp_other_specified', 'q_age');
  assert.equal(answer.value_text, 'not sure');
  assert.equal(answer.value_numeric, null);
});

test('free text in a non-numeric question is never coerced to a number', () => {
  // "12" here is a team-size textbox on an essay-family question. Guessing at
  // numeric intent across every text field would mistype postcodes and years.
  const rows = answersFor('resp_complete', 'q_details');
  const size = rows.find((r) => r.row_id === 'row_size');
  assert.equal(size.value_text, '12');
  assert.equal(size.value_numeric, null);
  assert.equal(size.row_text, 'Team size');
});

test('ranking answers expose the rank as a number', () => {
  const rows = answersFor('resp_complete', 'q_priorities');
  const speed = rows.find((r) => r.row_id === 'row_speed');
  assert.equal(speed.value_numeric, 1);
  assert.equal(speed.value_text, 'Speed');
});

test('skipped question emits exactly one flagged row with null values', () => {
  const rows = answersFor('resp_skipped', 'q_comments');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_skipped, true);
  assert.equal(rows[0].value_text, null);
  assert.equal(rows[0].value_numeric, null);
  assert.equal(rows[0].choice_id, null);
});

test('question absent from a response produces no answer row at all', () => {
  // q_added_later exists in the survey but in none of the responses.
  assert.equal(tables.answers.filter((a) => a.question_id === 'q_added_later').length, 0);
  // It must still appear as a question, so the survey structure is complete.
  assert.ok(tables.questions.some((q) => q.question_id === 'q_added_later'));
});

test('unrecognized answer shapes are preserved verbatim rather than dropped', () => {
  const [answer] = answersFor('resp_unknown_shape', 'q_rating');
  assert.equal(answer.value_text, JSON.stringify({ future_field: 'something new', value: 42 }));
  assert.equal(answer.is_skipped, false);
});

test('resolveAnswer handles a choice with no matching label without throwing', () => {
  const result = resolveAnswer({ choice_id: 'unknown_choice' }, undefined, {});
  assert.equal(result.choice_id, 'unknown_choice');
  assert.equal(result.value_text, 'unknown_choice');
  assert.equal(result.value_numeric, null);
});

// --- flat view -------------------------------------------------------------

test('flat view has one row per answer and agrees with the star tables', () => {
  const flat = buildFlatTable(tables);
  assert.equal(flat.length, tables.answers.length);

  const row = flat.find(
    (r) => r.response_id === 'resp_complete' && r.question_id === 'q_rating'
  );
  assert.equal(row.survey_title, 'Product Feedback Survey - Fixture');
  assert.equal(row.question_text, 'Overall, how would you rate the product?');
  assert.equal(row.response_status, 'completed');
  assert.equal(row.value_numeric, 4);
  assert.equal(row.row_text, 'Overall rating');
});

// --- helpers and contracts -------------------------------------------------

test('every declared column exists on the rows it describes', () => {
  for (const name of TABLE_NAMES) {
    const rows = name === 'flat' ? buildFlatTable(tables) : tables[name];
    assert.ok(rows.length > 0, `${name} should have rows in the fixture`);

    for (const column of TABLE_COLUMNS[name]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(rows[0], column),
        `${name}.${column} is declared in TABLE_COLUMNS but missing from the row`
      );
    }
  }
});

test('toNumber distinguishes empty from zero', () => {
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber('  7  '), 7);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(Infinity), null);
});

test('stripHtml removes markup and decodes common entities', () => {
  assert.equal(stripHtml('<b>Bold</b> text'), 'Bold text');
  assert.equal(stripHtml('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(stripHtml('  <p>Padded</p>  '), 'Padded');
  assert.equal(stripHtml(null), null);
});

test('buildTables tolerates a survey with no responses', () => {
  const empty = buildTables(surveyDetails, [], { snapshotDate: SNAPSHOT_DATE });
  assert.equal(empty.responses.length, 0);
  assert.equal(empty.answers.length, 0);
  assert.equal(empty.questions.length, 8);
  assert.equal(empty.surveys.length, 1);
});
