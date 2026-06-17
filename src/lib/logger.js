/**
 * logger.js
 *
 * Thin wrapper so every log line goes through one place. The rule this file
 * exists to enforce: never log question text, answer values, or any raw
 * SurveyMonkey payload. Only IDs, counts, timings, and status codes.
 *
 * Azure Functions' `context.log` already ships to Application Insights, so
 * this wraps that rather than introducing a new transport.
 */

function makeLogger(context) {
  return {
    info(message, meta = {}) {
      context.log(JSON.stringify({ level: 'info', message, ...safeMeta(meta) }));
    },
    warn(message, meta = {}) {
      context.warn(JSON.stringify({ level: 'warn', message, ...safeMeta(meta) }));
    },
    error(message, meta = {}) {
      context.error(JSON.stringify({ level: 'error', message, ...safeMeta(meta) }));
    },
  };
}

/**
 * Strips anything that looks like it could be free-text survey content.
 * Allowlist approach: only pass through known-safe keys. Anything else is
 * dropped rather than risk a PHI leak through an unexpected field name.
 */
const ALLOWED_META_KEYS = new Set([
  'surveyId',
  'responseId',
  'questionId',
  'collectorId',
  'statusCode',
  'durationMs',
  'cacheHit',
  'rowCount',
  'responseCount',
  'surveyCount',
  'errorName',
]);

function safeMeta(meta) {
  const safe = {};
  for (const key of Object.keys(meta)) {
    if (ALLOWED_META_KEYS.has(key)) {
      safe[key] = meta[key];
    } else {
      safe[`_dropped_${key}`] = '[redacted: not on log allowlist]';
    }
  }
  return safe;
}

module.exports = { makeLogger };
