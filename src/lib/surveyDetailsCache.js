/**
 * surveyDetailsCache.js
 *
 * Caches the question/choice lookup tree per survey at module scope, so a
 * single warm Function instance fetches /surveys/{id}/details once and
 * reuses it across every response page for that survey, and across
 * invocations until the TTL expires.
 *
 * Cold starts reset this naturally — that's fine. The cache exists to avoid
 * redundant calls within and across nearby invocations, not to be a
 * durable store.
 */

const { getSurveyDetails } = require('./surveyMonkeyClient');

const CACHE_TTL_MS = Number(process.env.SURVEY_DETAILS_CACHE_TTL_MS) || 4 * 60 * 60 * 1000; // 4h default

const cache = new Map(); // surveyId -> { lookups, fetchedAt }

/**
 * Build { questionMap, choiceMap } from a raw survey details payload.
 * questionMap: question_id -> { text, type }
 * choiceMap:   choice_id or row_id -> label text
 */
function buildLookups(surveyDetails) {
  const questionMap = {};
  const choiceMap = {};

  for (const page of surveyDetails.pages || []) {
    for (const q of page.questions || []) {
      questionMap[q.id] = {
        text: q.headings && q.headings[0] ? q.headings[0].heading : '',
        type: q.family || 'unknown',
      };

      for (const choice of (q.answers && q.answers.choices) || []) {
        choiceMap[choice.id] = choice.text || '';
      }
      for (const row of (q.answers && q.answers.rows) || []) {
        choiceMap[row.id] = row.text || '';
      }
    }
  }

  return { questionMap, choiceMap, surveyMeta: { id: surveyDetails.id, title: surveyDetails.title } };
}

/**
 * Returns cached lookups for a survey, fetching + building them if absent
 * or stale.
 * @returns {Promise<{questionMap, choiceMap, surveyMeta, cacheHit: boolean}>}
 */
async function getLookupsForSurvey(surveyId) {
  const cached = cache.get(surveyId);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.lookups, cacheHit: true };
  }

  const details = await getSurveyDetails(surveyId);
  const lookups = buildLookups(details);
  cache.set(surveyId, { lookups, fetchedAt: now });

  return { ...lookups, cacheHit: false };
}

/** Exposed for tests — clears the module-level cache between test cases. */
function _clearCacheForTests() {
  cache.clear();
}

module.exports = { getLookupsForSurvey, buildLookups, _clearCacheForTests };
