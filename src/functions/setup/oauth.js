const { app } = require('@azure/functions');
const crypto = require('node:crypto');
const { setSecret, getSecret } = require('../../lib/secretsClient');
const {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  validateToken,
} = require('../../lib/surveyMonkeyClient');
const { saveOAuthState, consumeOAuthState } = require('../../lib/setupConfig');
const { makeLogger } = require('../../lib/logger');

const CLIENT_ID_SECRET = () => process.env.SM_CLIENT_ID_SECRET_NAME || 'surveymonkey-client-id';
const CLIENT_SECRET_SECRET = () =>
  process.env.SM_CLIENT_SECRET_SECRET_NAME || 'surveymonkey-client-secret';
const TOKEN_SECRET = () => process.env.SM_ACCESS_TOKEN_SECRET_NAME || 'surveymonkey-access-token';

/**
 * POST /api/setup/oauth/start
 * Body: { "clientId": "...", "clientSecret": "...", "redirectUri": "..." }
 *
 * Begins the guided OAuth flow. Stores the app credentials in the secret
 * store, mints a one-time `state`, and returns the SurveyMonkey URL for the
 * user to visit.
 *
 * The client secret goes straight to the secret store and is never returned
 * to the browser again — the callback reads it back out when it needs to
 * exchange the code.
 */
app.http('setupOAuthStart', {
  methods: ['POST'],
  authLevel: 'admin',
  route: 'setup/oauth/start',
  handler: async (request, context) => {
    const log = makeLogger(context);

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: 'invalid_body', message: 'Expected a JSON body.' } };
    }

    const clientId = str(body.clientId);
    const clientSecret = str(body.clientSecret);
    const redirectUri = str(body.redirectUri);

    const missing = [];
    if (!clientId) missing.push('clientId');
    if (!clientSecret) missing.push('clientSecret');
    if (!redirectUri) missing.push('redirectUri');

    if (missing.length > 0) {
      return {
        status: 400,
        jsonBody: {
          error: 'missing_fields',
          message: `Required: ${missing.join(', ')}. Take these from your SurveyMonkey Developer App settings.`,
        },
      };
    }

    if (!/^https:\/\//i.test(redirectUri) && !/^http:\/\/localhost[:/]/i.test(redirectUri)) {
      return {
        status: 400,
        jsonBody: {
          error: 'invalid_redirect_uri',
          message:
            'redirectUri must be https, or http://localhost for local development, and must ' +
            'match the redirect URI registered in your SurveyMonkey Developer App exactly.',
        },
      };
    }

    try {
      await setSecret(CLIENT_ID_SECRET(), clientId);
      await setSecret(CLIENT_SECRET_SECRET(), clientSecret);
    } catch (err) {
      log.error('Failed to store OAuth client credentials', { errorName: err.name });
      return {
        status: 502,
        jsonBody: {
          error: 'store_failed',
          message: 'Could not save the app credentials to the secret store.',
        },
      };
    }

    const state = crypto.randomBytes(32).toString('hex');

    try {
      await saveOAuthState(state, { redirectUri });
    } catch (err) {
      log.error('Failed to store OAuth state', { errorName: err.name });
      return {
        status: 502,
        jsonBody: { error: 'store_failed', message: 'Could not start the authorization flow.' },
      };
    }

    log.info('Started OAuth flow', { statusCode: 200 });

    return {
      status: 200,
      jsonBody: {
        authorize_url: buildAuthorizeUrl({ clientId, redirectUri, state }),
        expires_in_seconds: 600,
        message:
          'Open authorize_url in a browser and approve access. SurveyMonkey will redirect ' +
          'back to your redirect URI to finish setup.',
      },
    };
  },
});

/**
 * GET /api/setup/oauth/callback?code=...&state=...
 *
 * Where SurveyMonkey sends the browser after the user approves.
 *
 * This endpoint is anonymous by necessity: SurveyMonkey performs the redirect
 * and cannot attach a function key, and Azure's own key parameter is `code`,
 * which collides with OAuth's authorization code. The `state` parameter is
 * what secures it — unguessable, single-use, expiring after ten minutes, and
 * verified with a timing-safe comparison. A request without valid state does
 * nothing at all.
 *
 * Responds with HTML rather than JSON because a human is looking at it.
 */
app.http('setupOAuthCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'setup/oauth/callback',
  handler: async (request, context) => {
    const log = makeLogger(context);

    const code = request.query.get('code');
    const state = request.query.get('state');
    const error = request.query.get('error');

    if (error) {
      log.warn('OAuth callback reported an error from SurveyMonkey', { statusCode: 400 });
      return htmlPage(400, 'Authorization was declined', [
        'SurveyMonkey reported: ' + escapeHtml(error) + '.',
        'You can close this tab and start the connection again.',
      ]);
    }

    let stored;
    try {
      // Consumes the state, so a replayed callback URL cannot work twice.
      stored = await consumeOAuthState(state);
    } catch {
      log.warn('OAuth callback rejected for invalid state', { statusCode: 400 });
      return htmlPage(400, 'This link is no longer valid', [
        'The authorization link has already been used, has expired, or did not come from a ' +
          'flow started on this deployment.',
        'Start the connection again from the setup wizard.',
      ]);
    }

    if (!code) {
      return htmlPage(400, 'Missing authorization code', [
        'SurveyMonkey did not include an authorization code in the redirect.',
        'Start the connection again from the setup wizard.',
      ]);
    }

    let token;
    try {
      const clientId = await getSecret(CLIENT_ID_SECRET());
      const clientSecret = await getSecret(CLIENT_SECRET_SECRET());

      token = await exchangeCodeForToken({
        clientId,
        clientSecret,
        redirectUri: stored.redirectUri,
        code,
      });
    } catch (err) {
      log.error('OAuth code exchange failed', { errorName: err.name });
      return htmlPage(502, 'Could not complete authorization', [
        'SurveyMonkey would not exchange the authorization code for a token.',
        'Authorization codes expire within a few minutes, so this usually means too much ' +
          'time passed. Start the connection again.',
      ]);
    }

    const check = await validateToken(token);
    if (!check.valid) {
      log.error('OAuth produced a token that does not work', { statusCode: 502 });
      return htmlPage(502, 'The new token does not work', [
        escapeHtml(check.message || 'SurveyMonkey rejected the token that was just issued.'),
      ]);
    }

    try {
      await setSecret(TOKEN_SECRET(), token);
    } catch (err) {
      log.error('Failed to store OAuth token', { errorName: err.name });
      return htmlPage(502, 'Could not save the token', [
        'Authorization succeeded, but the token could not be written to the secret store.',
        'Check the Function App identity has permission to set secrets.',
      ]);
    }

    log.info('Completed OAuth flow and stored token', { statusCode: 200 });

    return htmlPage(200, 'Connected to SurveyMonkey', [
      check.account && check.account.username
        ? `Connected as ${escapeHtml(check.account.username)}.`
        : 'Your SurveyMonkey account is connected.',
      'You can close this tab and return to the setup wizard.',
    ]);
  },
});

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal self-contained page — the wizard's assets may not be reachable here. */
function htmlPage(status, heading, paragraphs) {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('\n    ');

  return {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(heading)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6;
           max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; }
    p { margin: 0 0 1rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #161616; color: #ededed; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(heading)}</h1>
    ${body}
</body>
</html>`,
  };
}
