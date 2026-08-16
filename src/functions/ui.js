const { app } = require('@azure/functions');
const fs = require('node:fs/promises');
const path = require('node:path');
const { makeLogger } = require('../lib/logger');

/**
 * GET /api/ui            the setup wizard
 * GET /api/ui/{path}     its assets
 *
 * Serves the wizard from public/. There is no build step and no bundler —
 * the wizard is plain HTML, CSS and JavaScript, so contributors can clone the
 * repo and edit it without a toolchain, and so this function can serve files
 * straight from disk.
 *
 * Requires the admin (master) key, like the setup API it drives. Azure accepts
 * that key as a `?code=` query parameter, which is how the browser gets in:
 *
 *   https://your-app.azurewebsites.net/api/ui?code=YOUR-MASTER-KEY
 *
 * The page then reads that key back out of its own URL and sends it as an
 * x-functions-key header on API calls, so it never has to be typed twice.
 * Running locally, keys are not enforced and /api/ui is enough.
 */

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

app.http('ui', {
  methods: ['GET'],
  authLevel: 'admin',
  route: 'ui/{*path}',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const requested = request.params.path || 'index.html';

    const filePath = resolveWithinPublic(requested);
    if (!filePath) {
      // Traversal attempt. Reported as a plain 404 so it reveals nothing
      // about what does or does not exist outside the served directory.
      log.warn('Rejected an out-of-bounds asset request', { statusCode: 404 });
      return notFound();
    }

    let body;
    try {
      body = await fs.readFile(filePath);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return notFound();
      log.error('Failed to read wizard asset', { errorName: err.name });
      return { status: 500, body: 'Could not read the requested file.' };
    }

    return {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ||
          'application/octet-stream',
        // The wizard handles credentials, so it must never be cached by a
        // shared proxy, and a stale copy after an upgrade would be confusing.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
      body,
    };
  },
});

/**
 * Resolves a requested path inside PUBLIC_DIR, or returns null.
 *
 * Checked by resolving and then confirming the result is still inside the
 * directory, rather than by looking for ".." in the input — encoded and
 * mixed-separator forms defeat string matching, but cannot defeat resolution.
 */
function resolveWithinPublic(requested) {
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }

  if (decoded.includes('\0')) return null;

  const resolved = path.resolve(PUBLIC_DIR, decoded);
  const relative = path.relative(PUBLIC_DIR, resolved);

  if (relative === '') return path.join(PUBLIC_DIR, 'index.html');
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  return resolved;
}

function notFound() {
  return {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: 'Not found.',
  };
}

module.exports = { resolveWithinPublic, PUBLIC_DIR };
