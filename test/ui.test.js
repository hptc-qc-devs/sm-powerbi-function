/**
 * Tests the wizard's asset server.
 *
 * The path handling carries the weight here. This function turns a URL
 * segment into a filesystem read, which is the classic shape of a directory
 * traversal bug, so the resolver is tested against encoded, nested and
 * absolute-path attempts rather than only the obvious "../" case.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const azureFunctions = require('@azure/functions');
const handlers = {};
azureFunctions.app.http = (name, config) => {
  handlers[name] = config.handler;
};
azureFunctions.app.timer = () => {};

const { resolveWithinPublic, PUBLIC_DIR } = require('../src/functions/ui');

const context = { log() {}, warn() {}, error() {} };
const serve = (p) => handlers.ui({ params: { path: p } }, context);

// --- serving real assets ---------------------------------------------------

test('the wizard page is served at the route root', async () => {
  const res = await serve(undefined);

  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.match(res.body.toString('utf8'), /SurveyMonkey/);
});

test('each asset comes back with its correct content type', async () => {
  const cases = [
    ['index.html', /text\/html/],
    ['styles.css', /text\/css/],
    ['app.js', /text\/javascript/],
  ];

  for (const [file, expected] of cases) {
    const res = await serve(file);
    assert.equal(res.status, 200, `${file} should be served`);
    assert.match(res.headers['Content-Type'], expected);
  }
});

test('assets are sent with headers appropriate to a credential-handling page', async () => {
  const res = await serve('index.html');

  // The wizard handles tokens, so a shared cache must never keep a copy.
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('a missing file is a plain 404', async () => {
  const res = await serve('nope.html');
  assert.equal(res.status, 404);
});

// --- traversal -------------------------------------------------------------

test('traversal attempts are refused', async () => {
  const attempts = [
    '../package.json',
    '../../package.json',
    '../src/lib/secretsClient.js',
    'nested/../../package.json',
    '..%2Fpackage.json',
    '%2e%2e%2fpackage.json',
    '....//package.json',
    '/etc/passwd',
  ];

  for (const attempt of attempts) {
    const res = await serve(attempt);
    assert.equal(res.status, 404, `"${attempt}" must not be served`);
    assert.ok(
      !String(res.body).includes('sm-powerbi-function'),
      `"${attempt}" must not leak file contents`
    );
  }
});

test('the resolver keeps every result inside the public directory', () => {
  const escapes = ['../package.json', '../../etc/passwd', '/etc/passwd', 'a/../../b'];

  for (const attempt of escapes) {
    assert.equal(resolveWithinPublic(attempt), null, `"${attempt}" should not resolve`);
  }
});

test('a null byte in the path is refused', () => {
  assert.equal(resolveWithinPublic('index.html\0.png'), null);
});

test('malformed percent-encoding is refused rather than throwing', () => {
  assert.equal(resolveWithinPublic('%E0%A4%A'), null);
  assert.equal(resolveWithinPublic('%'), null);
});

test('ordinary paths resolve inside the public directory', () => {
  assert.equal(resolveWithinPublic('index.html'), path.join(PUBLIC_DIR, 'index.html'));
  assert.equal(resolveWithinPublic('styles.css'), path.join(PUBLIC_DIR, 'styles.css'));
  assert.equal(resolveWithinPublic(''), path.join(PUBLIC_DIR, 'index.html'));
});

test('percent-encoded ordinary characters still resolve', () => {
  assert.equal(resolveWithinPublic('index%2Ehtml'), path.join(PUBLIC_DIR, 'index.html'));
});

// --- the shipped wizard ----------------------------------------------------

test('the wizard markup has all four steps and no external dependencies', async () => {
  const html = (await serve('index.html')).body.toString('utf8');

  for (const step of ['1', '2', '3', '4']) {
    assert.ok(html.includes(`data-step="${step}"`), `step ${step} should be present`);
  }

  // A strict CSP or an offline network must not break the wizard, and a
  // credential-handling page should not be fetching third-party code.
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'no remote scripts');
  assert.ok(!/<link[^>]+href=["']https?:/i.test(html), 'no remote stylesheets');
});

test('the wizard script never persists the admin key', async () => {
  const js = (await serve('app.js')).body.toString('utf8');

  // The key should live only as long as the tab; storing it would leave an
  // admin credential on disk in the browser profile.
  //
  // Matches property access rather than the bare word, so a comment
  // explaining that the wizard avoids these does not fail the check.
  assert.ok(!/\blocalStorage\s*[.[]/.test(js), 'must not use localStorage');
  assert.ok(!/\bsessionStorage\s*[.[]/.test(js), 'must not use sessionStorage');
  assert.ok(!/document\.cookie\s*=/.test(js), 'must not write cookies');
});

test('the wizard sends the key as a header, not in the query string', async () => {
  const js = (await serve('app.js')).body.toString('utf8');
  assert.ok(js.includes('x-functions-key'), 'the key belongs in a header');
});
