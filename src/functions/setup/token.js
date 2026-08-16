const { app } = require('@azure/functions');
const { setSecret } = require('../../lib/secretsClient');
const { validateToken } = require('../../lib/surveyMonkeyClient');
const { makeLogger } = require('../../lib/logger');

/**
 * POST /api/setup/token
 * Body: { "token": "..." }
 *
 * Stores a SurveyMonkey access token the user pasted in.
 *
 * The token is checked against SurveyMonkey *before* being written, so a typo
 * or an expired token is reported immediately instead of surfacing hours
 * later as a failed sync. The check also tells us which account it belongs
 * to, which the wizard shows back as confirmation.
 *
 * The token is never returned, echoed, or logged. It goes to the secret store
 * and nothing else.
 */
app.http('setupToken', {
  methods: ['POST'],
  authLevel: 'admin',
  route: 'setup/token',
  handler: async (request, context) => {
    const log = makeLogger(context);

    let body;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        jsonBody: { error: 'invalid_body', message: 'Expected a JSON body with a "token" field.' },
      };
    }

    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) {
      return {
        status: 400,
        jsonBody: { error: 'missing_token', message: 'A "token" field is required.' },
      };
    }

    const result = await validateToken(token);

    if (!result.valid) {
      // Deliberately not stored. Writing a token we already know is rejected
      // would turn a clear error here into a confusing failure later.
      log.warn('Rejected an invalid token during setup', { statusCode: result.status });
      return {
        status: result.status === 502 ? 502 : 400,
        jsonBody: {
          error: 'token_rejected',
          message: result.message,
          stored: false,
        },
      };
    }

    try {
      await setSecret(
        process.env.SM_ACCESS_TOKEN_SECRET_NAME || 'surveymonkey-access-token',
        token
      );
    } catch (err) {
      log.error('Failed to store token', { errorName: err.name });
      return {
        status: 502,
        jsonBody: {
          error: 'store_failed',
          message:
            'The token is valid but could not be saved. Check the Function App identity has ' +
            'permission to set secrets in Key Vault.',
          stored: false,
        },
      };
    }

    log.info('Stored a validated SurveyMonkey token', { statusCode: 200 });

    return {
      status: 200,
      jsonBody: {
        stored: true,
        account: result.account,
        message: 'Token validated and stored.',
        next_step: 'choose_surveys',
      },
    };
  },
});
