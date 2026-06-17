/**
 * flatten.js
 *
 * Converts SurveyMonkey's nested response JSON into the flat schema locked
 * in for Phase 1: one row per response x question x answer.
 *
 *   snapshot_date, survey_id, survey_title, response_id, response_status,
 *   date_created, date_modified, question_id, question_text, question_type,
 *   answer_value, choice_id, collector_id, language
 *
 * Pure functions only — no network calls, no Key Vault, no logging side
 * effects. This is what makes them cheaply unit-testable with fixture JSON.
 *
 * Three-state handling for questions, by design:
 *   1. answers: [ {...}, {...} ]  -> answered. Emit one row per answer.
 *   2. answers: []                -> skipped via logic, or partial response.
 *                                    Emit ONE row with answer_value: null so
 *                                    the skip is visible and the response
 *                                    still counts toward completion totals.
 *   3. question absent from this response entirely -> the question didn't
 *      exist yet when this response was collected (added to the survey
 *      later). Emit nothing — there is nothing true to say about it.
 */

function flattenResponse(response, surveyMeta, lookups, snapshotDate) {
  const { questionMap, choiceMap } = lookups;
  const rows = [];

  const base = {
    snapshot_date: snapshotDate,
    survey_id: surveyMeta.id,
    survey_title: surveyMeta.title,
    response_id: response.id,
    response_status: response.response_status || 'unknown',
    date_created: response.date_created || null,
    date_modified: response.date_modified || null,
    collector_id: response.collector_id || null,
    language: (response.metadata && response.metadata.contact && response.metadata.contact.language) || null,
  };

  for (const page of response.pages || []) {
    for (const question of page.questions || []) {
      const qInfo = questionMap[question.id] || { text: null, type: null };
      const answers = question.answers;

      if (!answers || answers.length === 0) {
        rows.push({
          ...base,
          question_id: question.id,
          question_text: qInfo.text,
          question_type: qInfo.type,
          answer_value: null,
          choice_id: null,
        });
        continue;
      }

      for (const answer of answers) {
        rows.push({
          ...base,
          question_id: question.id,
          question_text: qInfo.text,
          question_type: qInfo.type,
          ...resolveAnswerValue(answer, choiceMap),
        });
      }
    }
  }

  return rows;
}

/**
 * Resolves a single raw answer object to { answer_value, choice_id }.
 * Handles: simple choice, open text, matrix (row_id + choice_id), and an
 * explicit fallback for any answer shape not otherwise recognized so new
 * SurveyMonkey question types degrade to a visible raw value instead of
 * silently dropping data.
 */
function resolveAnswerValue(answer, choiceMap) {
  const choiceId = answer.choice_id || null;

  if (answer.row_id) {
    // Matrix-type question: row_id identifies the statement/row,
    // choice_id identifies the selected column/option.
    const rowText = choiceMap[answer.row_id] || answer.row_id;
    const choiceText = choiceId ? choiceMap[choiceId] || choiceId : '';
    return {
      answer_value: choiceText ? `${rowText}: ${choiceText}` : rowText,
      choice_id: choiceId,
    };
  }

  if (choiceId) {
    return {
      answer_value: choiceMap[choiceId] !== undefined ? choiceMap[choiceId] : choiceId,
      choice_id: choiceId,
    };
  }

  if (answer.text !== undefined) {
    return { answer_value: answer.text, choice_id: null };
  }

  if (answer.other_id !== undefined) {
    // "Other (please specify)" free-text on a choice question
    return { answer_value: answer.text || '[other, no text]', choice_id: null };
  }

  // Fallback for rating/ranking/unrecognized shapes — preserve raw JSON
  // rather than silently losing the answer.
  return { answer_value: JSON.stringify(answer), choice_id: null };
}

/**
 * Flattens every response for a single survey into the flat row array.
 */
function flattenSurveyResponses(surveyMeta, lookups, responses, snapshotDate) {
  const rows = [];
  for (const response of responses) {
    rows.push(...flattenResponse(response, surveyMeta, lookups, snapshotDate));
  }
  return rows;
}

module.exports = { flattenResponse, flattenSurveyResponses, resolveAnswerValue };
