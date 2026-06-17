const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildLookups } = require('../src/lib/surveyDetailsCache');
const { flattenResponse, flattenSurveyResponses, resolveAnswerValue } = require('../src/lib/flatten');

const surveyDetails = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'sampleSurveyDetails.json'), 'utf8')
);
const responses = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'sampleResponses.json'), 'utf8')
);

const lookups = buildLookups(surveyDetails);
const SNAPSHOT_DATE = '2025-06-30';

test('buildLookups resolves question text and choice text correctly', () => {
  assert.equal(lookups.questionMap.q_satisfaction.text, 'How satisfied are you with your visit?');
  assert.equal(lookups.questionMap.q_satisfaction.type, 'single_choice');
  assert.equal(lookups.choiceMap.ch_very, 'Very satisfied');
  assert.equal(lookups.choiceMap.row_doctor, 'Doctor');
  assert.equal(lookups.choiceMap.col_good, 'Good');
});

test('fully answered response produces one row per answered question', () => {
  const response = responses.find((r) => r.id === 'resp_fully_answered');
  const rows = flattenResponse(response, lookups.surveyMeta, lookups, SNAPSHOT_DATE);

  // q_satisfaction (1) + q_comments (1) + q_matrix (2 rows: doctor, nurse) = 4
  assert.equal(rows.length, 4);

  const satisfactionRow = rows.find((r) => r.question_id === 'q_satisfaction');
  assert.equal(satisfactionRow.answer_value, 'Very satisfied');
  assert.equal(satisfactionRow.choice_id, 'ch_very');
  assert.equal(satisfactionRow.survey_title, 'Patient Satisfaction Survey - Fixture');
  assert.equal(satisfactionRow.snapshot_date, SNAPSHOT_DATE);

  const commentsRow = rows.find((r) => r.question_id === 'q_comments');
  assert.equal(commentsRow.answer_value, 'Great visit, thank you.');
  assert.equal(commentsRow.choice_id, null);

  const matrixRows = rows.filter((r) => r.question_id === 'q_matrix');
  assert.equal(matrixRows.length, 2);
  assert.ok(matrixRows.some((r) => r.answer_value === 'Doctor: Good'));
  assert.ok(matrixRows.some((r) => r.answer_value === 'Nurse: Good'));
});

test('skipped question (empty answers array) emits exactly one null row', () => {
  const response = responses.find((r) => r.id === 'resp_skipped_question');
  const rows = flattenResponse(response, lookups.surveyMeta, lookups, SNAPSHOT_DATE);

  const commentsRow = rows.find((r) => r.question_id === 'q_comments');
  assert.ok(commentsRow, 'skipped question must still produce a row');
  assert.equal(commentsRow.answer_value, null);
  assert.equal(commentsRow.choice_id, null);

  // Confirm it did NOT silently disappear - total row count check
  // q_satisfaction(1) + q_comments(1 null row) + q_matrix(1 answered row) = 3
  assert.equal(rows.length, 3);
});

test('question absent from response entirely produces no row for it', () => {
  const response = responses.find((r) => r.id === 'resp_partial');
  const rows = flattenResponse(response, lookups.surveyMeta, lookups, SNAPSHOT_DATE);

  // Only q_satisfaction was present in this partial response.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question_id, 'q_satisfaction');
  // q_newly_added should never appear for any fixture response
  const allRows = flattenSurveyResponses(lookups.surveyMeta, lookups, responses, SNAPSHOT_DATE);
  assert.ok(!allRows.some((r) => r.question_id === 'q_newly_added'));
});

test('language and collector_id are carried through from response metadata', () => {
  const response = responses.find((r) => r.id === 'resp_partial');
  const rows = flattenResponse(response, lookups.surveyMeta, lookups, SNAPSHOT_DATE);
  assert.equal(rows[0].language, 'es');
  assert.equal(rows[0].collector_id, 'col_456');
});

test('resolveAnswerValue falls back to raw JSON for unrecognized answer shapes', () => {
  const weirdAnswer = { rank: 3 }; // no choice_id, no text, no row_id
  const result = resolveAnswerValue(weirdAnswer, {});
  assert.equal(result.answer_value, JSON.stringify(weirdAnswer));
  assert.equal(result.choice_id, null);
});

test('flattenSurveyResponses produces the union of all per-response rows', () => {
  const allRows = flattenSurveyResponses(lookups.surveyMeta, lookups, responses, SNAPSHOT_DATE);
  // 4 (fully answered) + 3 (skipped question) + 1 (partial) = 8
  assert.equal(allRows.length, 8);
  // Every row must carry the survey_id even though we only passed surveyMeta once
  assert.ok(allRows.every((r) => r.survey_id === '999111'));
});
