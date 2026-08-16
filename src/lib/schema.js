/**
 * schema.js
 *
 * Turns SurveyMonkey's nested JSON into a star schema Power BI can model
 * directly. This is the standardized output the connector advertises.
 *
 *   surveys    1 row per survey        (dimension)
 *   questions  1 row per question      (dimension)
 *   choices    1 row per choice/row    (dimension)
 *   responses  1 row per response      (dimension)
 *   answers    1 row per answer        (fact)
 *
 * In Power BI these relate as answers[question_id] -> questions[question_id],
 * answers[response_id] -> responses[response_id], and so on, which is what
 * lets DAX aggregate without unpicking a wide denormalized table.
 *
 * Pure functions only — no network, no storage, no logging. Same contract as
 * flatten.js, and for the same reason: this is the layer most likely to need
 * changes as real survey data reveals edge cases, so it has to stay cheap to
 * test with fixtures.
 *
 * Why this exists alongside flatten.js: the flat shape repeats survey and
 * question text on every row and stringifies everything, so a rating of 4
 * arrives as the label "Satisfied" with no way to average it. Here, numeric
 * meaning is preserved in `value_numeric`, matrix rows get their own columns
 * instead of being concatenated into a string, and "Other (please specify)"
 * keeps both the choice it belongs to and the text the respondent typed.
 */

/** Question subtypes whose free-text answers are genuinely numbers. */
const NUMERIC_SUBTYPES = new Set(['numerical']);

/**
 * Builds every table for one survey.
 *
 * @param {object} surveyDetails - payload from GET /surveys/{id}/details
 * @param {object[]} responses - payloads from GET /surveys/{id}/responses/bulk
 * @param {object} [opts]
 * @param {string} [opts.snapshotDate] - YYYY-MM-DD stamped onto every row
 * @returns {{surveys: object[], questions: object[], choices: object[],
 *            responses: object[], answers: object[]}}
 */
function buildTables(surveyDetails, responses = [], opts = {}) {
  const snapshotDate = opts.snapshotDate || new Date().toISOString().slice(0, 10);
  const surveyId = surveyDetails.id;

  const questions = [];
  const choices = [];
  const questionIndex = {}; // question_id -> question row (for answer typing)
  const labelIndex = {}; // choice/row/col/other id -> { text, weight }

  let pagePosition = 0;
  for (const page of surveyDetails.pages || []) {
    pagePosition += 1;
    let position = 0;

    for (const q of page.questions || []) {
      position += 1;

      const questionRow = {
        survey_id: surveyId,
        question_id: q.id,
        page_id: page.id || null,
        page_position: pagePosition,
        position,
        heading: stripHtml(firstHeading(q)),
        family: q.family || 'unknown',
        subtype: q.subtype || null,
        is_required: Boolean(q.required),
        snapshot_date: snapshotDate,
      };

      questions.push(questionRow);
      questionIndex[q.id] = questionRow;
      collectChoices(q, surveyId, snapshotDate, choices, labelIndex);
    }
  }

  const responseRows = [];
  const answerRows = [];

  for (const response of responses) {
    responseRows.push(buildResponseRow(response, surveyId, snapshotDate));
    appendAnswerRows(response, surveyId, snapshotDate, questionIndex, labelIndex, answerRows);
  }

  const surveyRow = {
    survey_id: surveyId,
    title: surveyDetails.title || null,
    language: surveyDetails.language || null,
    question_count: questions.length,
    page_count: pagePosition,
    response_count:
      surveyDetails.response_count !== undefined ? surveyDetails.response_count : responseRows.length,
    date_created: surveyDetails.date_created || null,
    date_modified: surveyDetails.date_modified || null,
    snapshot_date: snapshotDate,
  };

  return {
    surveys: [surveyRow],
    questions,
    choices,
    responses: responseRows,
    answers: answerRows,
  };
}

/**
 * Extracts every selectable label a question defines into the choices table.
 *
 * SurveyMonkey splits these across several keys with different meanings, so
 * `kind` records which one a row came from:
 *   choice - a selectable option
 *   row    - a matrix row / textbox label (the statement being rated)
 *   col    - a column group in an advanced matrix
 *   other  - the "Other (please specify)" option
 */
function collectChoices(q, surveyId, snapshotDate, choices, labelIndex) {
  const push = (item, kind, parentColId = null) => {
    if (!item || item.id === undefined) return;

    const weight = toNumber(item.weight);
    choices.push({
      survey_id: surveyId,
      question_id: q.id,
      choice_id: item.id,
      col_id: parentColId,
      text: stripHtml(item.text || ''),
      kind,
      position: item.position !== undefined ? item.position : null,
      weight,
      is_na: Boolean(item.is_na),
      snapshot_date: snapshotDate,
    });
    labelIndex[item.id] = { text: stripHtml(item.text || ''), weight };
  };

  const answers = q.answers || {};

  for (const choice of answers.choices || []) push(choice, 'choice');
  for (const row of answers.rows || []) push(row, 'row');

  for (const col of answers.cols || []) {
    push(col, 'col');
    for (const choice of col.choices || []) push(choice, 'choice', col.id);
  }

  // `other` is an object rather than an array, and may be absent.
  if (answers.other) push(answers.other, 'other');
}

function buildResponseRow(response, surveyId, snapshotDate) {
  const contact = (response.metadata && response.metadata.contact) || {};

  return {
    survey_id: surveyId,
    response_id: response.id,
    response_status: response.response_status || 'unknown',
    collector_id: response.collector_id || null,
    date_created: response.date_created || null,
    date_modified: response.date_modified || null,
    total_time_seconds: toNumber(response.total_time),
    language: contact.language || null,
    // Deliberately excluded: ip_address, email, first_name, last_name and
    // other respondent contact fields. This connector serves analytics, and
    // shipping identifiers into a BI model by default is the wrong default.
    snapshot_date: snapshotDate,
  };
}

/**
 * Appends one row per answer for a response.
 *
 * The three-state handling matches flatten.js, because it is a
 * data-integrity rule rather than an implementation detail:
 *   answers: [...]  -> one row each
 *   answers: []     -> ONE row with null values, so a deliberate skip stays
 *                      countable and completion rates stay honest
 *   question absent -> nothing, because the question did not exist when this
 *                      response was collected
 */
function appendAnswerRows(response, surveyId, snapshotDate, questionIndex, labelIndex, out) {
  for (const page of response.pages || []) {
    for (const question of page.questions || []) {
      const meta = questionIndex[question.id];
      const answers = question.answers;

      const base = {
        survey_id: surveyId,
        response_id: response.id,
        question_id: question.id,
        snapshot_date: snapshotDate,
      };

      if (!answers || answers.length === 0) {
        out.push({
          ...base,
          choice_id: null,
          row_id: null,
          col_id: null,
          row_text: null,
          value_text: null,
          value_numeric: null,
          other_text: null,
          is_skipped: true,
        });
        continue;
      }

      for (const answer of answers) {
        out.push({ ...base, ...resolveAnswer(answer, meta, labelIndex), is_skipped: false });
      }
    }
  }
}

/**
 * Resolves one raw answer into typed columns.
 *
 * Ordering matters here. `other_id` is checked before `text`, because an
 * "Other (please specify)" answer carries both and the older flat transform
 * let the text win — which silently dropped the choice from distribution
 * counts. Here the choice and the typed text occupy separate columns.
 *
 * @returns {{choice_id, row_id, col_id, row_text, value_text, value_numeric, other_text}}
 */
function resolveAnswer(answer, questionMeta, labelIndex) {
  const rowId = answer.row_id || null;
  const colId = answer.col_id || null;
  const rowText = rowId ? labelOf(rowId, labelIndex) : null;

  const result = {
    choice_id: null,
    row_id: rowId,
    col_id: colId,
    row_text: rowText,
    value_text: null,
    value_numeric: null,
    other_text: null,
  };

  // "Other (please specify)": keep the option AND the free text.
  if (answer.other_id !== undefined && answer.other_id !== null) {
    result.choice_id = answer.other_id;
    result.value_text = labelOf(answer.other_id, labelIndex) || 'Other';
    result.other_text = answer.text !== undefined ? answer.text : null;
    return result;
  }

  if (answer.choice_id) {
    const entry = labelIndex[answer.choice_id];
    result.choice_id = answer.choice_id;
    result.value_text = entry ? entry.text : answer.choice_id;
    result.value_numeric = entry && entry.weight !== null ? entry.weight : null;

    // Ranking questions express the rank as a numeric position rather than a
    // weighted choice.
    if (result.value_numeric === null) {
      result.value_numeric = toNumber(answer.rank);
    }
    return result;
  }

  if (answer.text !== undefined) {
    result.value_text = answer.text;
    if (questionMeta && NUMERIC_SUBTYPES.has(questionMeta.subtype)) {
      result.value_numeric = toNumber(answer.text);
    }
    return result;
  }

  if (answer.date_time !== undefined) {
    result.value_text = answer.date_time;
    return result;
  }

  if (answer.rank !== undefined) {
    result.value_numeric = toNumber(answer.rank);
    result.value_text = rowText;
    return result;
  }

  // Unrecognized shape. Preserve it verbatim rather than dropping it, so a
  // new SurveyMonkey question type surfaces as an odd-looking cell someone
  // reports, not as data that quietly vanished.
  result.value_text = JSON.stringify(answer);
  return result;
}

/**
 * Derives the single-table "simple mode" view from the star tables, so both
 * outputs are guaranteed to agree. Unlike flatten.js this keeps the typed
 * columns, meaning numeric answers stay aggregatable even in flat mode.
 */
function buildFlatTable(tables) {
  const survey = tables.surveys[0] || {};
  const questionById = indexBy(tables.questions, 'question_id');
  const responseById = indexBy(tables.responses, 'response_id');

  return tables.answers.map((answer) => {
    const question = questionById[answer.question_id] || {};
    const response = responseById[answer.response_id] || {};

    return {
      snapshot_date: answer.snapshot_date,
      survey_id: answer.survey_id,
      survey_title: survey.title || null,
      response_id: answer.response_id,
      response_status: response.response_status || null,
      date_created: response.date_created || null,
      date_modified: response.date_modified || null,
      collector_id: response.collector_id || null,
      language: response.language || null,
      question_id: answer.question_id,
      question_text: question.heading || null,
      question_family: question.family || null,
      question_subtype: question.subtype || null,
      row_id: answer.row_id,
      row_text: answer.row_text,
      choice_id: answer.choice_id,
      value_text: answer.value_text,
      value_numeric: answer.value_numeric,
      other_text: answer.other_text,
      is_skipped: answer.is_skipped,
    };
  });
}

/** Column order for each table, so CSV headers stay stable across syncs. */
const TABLE_COLUMNS = {
  surveys: [
    'survey_id', 'title', 'language', 'question_count', 'page_count',
    'response_count', 'date_created', 'date_modified', 'snapshot_date',
  ],
  questions: [
    'survey_id', 'question_id', 'page_id', 'page_position', 'position',
    'heading', 'family', 'subtype', 'is_required', 'snapshot_date',
  ],
  choices: [
    'survey_id', 'question_id', 'choice_id', 'col_id', 'text', 'kind',
    'position', 'weight', 'is_na', 'snapshot_date',
  ],
  responses: [
    'survey_id', 'response_id', 'response_status', 'collector_id',
    'date_created', 'date_modified', 'total_time_seconds', 'language',
    'snapshot_date',
  ],
  answers: [
    'survey_id', 'response_id', 'question_id', 'choice_id', 'row_id', 'col_id',
    'row_text', 'value_text', 'value_numeric', 'other_text', 'is_skipped',
    'snapshot_date',
  ],
  flat: [
    'snapshot_date', 'survey_id', 'survey_title', 'response_id',
    'response_status', 'date_created', 'date_modified', 'collector_id',
    'language', 'question_id', 'question_text', 'question_family',
    'question_subtype', 'row_id', 'row_text', 'choice_id', 'value_text',
    'value_numeric', 'other_text', 'is_skipped',
  ],
};

const TABLE_NAMES = Object.keys(TABLE_COLUMNS);

// --- helpers ---------------------------------------------------------------

function firstHeading(q) {
  return (q.headings && q.headings[0] && q.headings[0].heading) || '';
}

function labelOf(id, labelIndex) {
  const entry = labelIndex[id];
  return entry ? entry.text : id;
}

/**
 * SurveyMonkey commonly returns question headings containing HTML markup.
 * Left alone it shows up literally in Power BI column values, so tags are
 * removed and the handful of entities that survive that are decoded.
 */
function stripHtml(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Returns a finite number, or null. Empty strings are not zero. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function indexBy(rows, key) {
  const index = {};
  for (const row of rows) index[row[key]] = row;
  return index;
}

module.exports = {
  buildTables,
  buildFlatTable,
  resolveAnswer,
  stripHtml,
  toNumber,
  TABLE_COLUMNS,
  TABLE_NAMES,
};
