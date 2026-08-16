#!/usr/bin/env node
/**
 * scripts/setupOAuth.js
 *
 * Run LOCALLY ONLY. Never deployed (.funcignore excludes scripts/).
 * Requires `az login` to have been run already, since it uses the same
 * DefaultAzureCredential as the deployed Function — just resolving to your
 * developer identity instead of the Function's Managed Identity. Your
 * Azure AD account needs "Key Vault Secrets Officer" (or equivalent set
 * permission) on the target vault.
 *
 * Two modes:
 *
 *   node scripts/setupOAuth.js --store-token
 *     You already have a working access token from your SurveyMonkey
 *     Developer App — this just writes it into Key Vault so the deployed
 *     Function can use it. Nothing about the OAuth flow is re-run.
 *
 *   node scripts/setupOAuth.js --full-flow
 *     Walks through SurveyMonkey's three-step OAuth flow from scratch and
 *     stores the resulting token. Use it for a first-time setup without a
 *     token in hand, or to recover from a revoked one (a 401 from the
 *     deployed Function means this). SurveyMonkey does not issue refresh
 *     tokens, so this manual re-authorization is the only recovery path.
 */

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { setSecret, getSecret } = require('../src/lib/secretsClient');

const SM_AUTH_BASE = 'https://api.surveymonkey.com';

async function prompt(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function storeExistingToken() {
  console.log('\n--- Store an existing SurveyMonkey access token ---\n');
  const token = await prompt('Paste the access token from your SurveyMonkey Developer App: ');
  if (!token) {
    console.error('No token entered. Aborting.');
    process.exit(1);
  }

  const secretName = process.env.SM_ACCESS_TOKEN_SECRET_NAME || 'surveymonkey-access-token';
  await setSecret(secretName, token);
  console.log(`\nStored token in Key Vault under secret name "${secretName}".`);
  console.log('Sanity check: calling /api/health on your local func host (if running)');
  console.log('or the deployed Function App should now report keyVaultReachable: true.\n');
}

async function runFullOAuthFlow() {
  console.log('\n--- Full SurveyMonkey OAuth 2.0 authorization-code flow ---\n');
  console.log(
    'Use this only if the previously stored token has been revoked.\n' +
      'You will need the Client ID, Client Secret, and Redirect URI exactly\n' +
      'as configured in your SurveyMonkey Developer App.\n'
  );

  const clientId = await prompt('Client ID: ');
  const clientSecret = await prompt('Client Secret: ');
  const redirectUri = await prompt('Redirect URI (as registered in the Developer App): ');

  const authorizeUrl =
    `${SM_AUTH_BASE}/oauth/authorize?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code`;

  console.log('\n1. Open this URL in a browser and log in / authorize the app:\n');
  console.log(`   ${authorizeUrl}\n`);
  console.log('2. After authorizing, you will be redirected to your redirect URI with a');
  console.log('   ?code=... query parameter. The code is valid for 5 minutes only.\n');

  const code = await prompt('Paste the code value here: ');
  if (!code) {
    console.error('No code entered. Aborting.');
    process.exit(1);
  }

  console.log('\nExchanging code for an access token...');

  const response = await fetch(`${SM_AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error(`\nToken exchange failed (${response.status}): ${bodyText}`);
    process.exit(1);
  }

  const body = await response.json();
  if (!body.access_token) {
    console.error('\nNo access_token in response body. Raw response:', JSON.stringify(body));
    process.exit(1);
  }

  const secretName = process.env.SM_ACCESS_TOKEN_SECRET_NAME || 'surveymonkey-access-token';
  await setSecret(secretName, body.access_token);

  console.log(`\nSuccess. New access token stored in Key Vault under "${secretName}".`);
  console.log(
    "Note: this token does not expire on a fixed schedule per SurveyMonkey's docs, " +
      'but can be revoked by the user at any time. There is no silent refresh — ' +
      're-run this script with --full-flow if that happens.\n'
  );
}

async function main() {
  const mode = process.argv[2];

  if (mode === '--store-token') {
    await storeExistingToken();
  } else if (mode === '--full-flow') {
    await runFullOAuthFlow();
  } else {
    console.log('Usage:');
    console.log('  node scripts/setupOAuth.js --store-token   (you already have a token)');
    console.log('  node scripts/setupOAuth.js --full-flow     (re-authorize from scratch)');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
