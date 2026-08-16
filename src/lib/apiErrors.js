/**
 * apiErrors.js
 *
 * Maps errors thrown by the SurveyMonkey client onto HTTP responses, so
 * every endpoint tells the same story about the same failure. Lives in lib/
 * rather than alongside one endpoint because all data endpoints share it.
 *
 * The distinction that matters to users:
 *   401 -> the stored token was revoked. A human must re-authorize; there is
 *          no automated recovery, because SurveyMonkey does not issue
 *          refresh tokens.
 *   403 -> the token is fine but the SurveyMonkey app lacks a scope. A
 *          configuration fix, not a credential fix.
 * Both surface as 502 to the caller (this service is a healthy proxy in
 * front of an unhappy upstream), distinguished by the `error` code so
 * Power BI users and the setup wizard can act on them differently.
 */

const { SurveyMonkeyAuthError, SurveyMonkeyScopeError } = require('./surveyMonkeyClient');

function handleSurveyMonkeyError(err, log) {
  if (err instanceof SurveyMonkeyAuthError) {
    log.error('SurveyMonkey auth error', { statusCode: 401, errorName: err.name });
    return {
      status: 502,
      jsonBody: {
        error: 'surveymonkey_token_invalid',
        message:
          'The stored SurveyMonkey access token was rejected (401). It has likely been ' +
          'revoked. Re-authorize to store a new token; this requires a human because ' +
          'SurveyMonkey does not issue refresh tokens.',
      },
    };
  }

  if (err instanceof SurveyMonkeyScopeError) {
    log.error('SurveyMonkey scope error', { statusCode: 403, errorName: err.name });
    return {
      status: 502,
      jsonBody: {
        error: 'surveymonkey_insufficient_scope',
        message: 'The access token is valid but lacks permission for this resource (403).',
      },
    };
  }

  log.error('Unhandled SurveyMonkey API error', { errorName: err.name });
  return {
    status: 502,
    jsonBody: { error: 'surveymonkey_api_error', message: 'Upstream SurveyMonkey API call failed.' },
  };
}

module.exports = { handleSurveyMonkeyError };
