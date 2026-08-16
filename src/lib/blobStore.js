/**
 * blobStore.js
 *
 * Thin wrapper over Azure Blob Storage, and the only module that knows the
 * storage layout. Everything else refers to surveys and table names.
 *
 * Layout inside the container:
 *
 *   {surveyId}/latest/{table}.csv       what the data endpoints serve
 *   {surveyId}/raw/responses.json       merged raw responses (incremental base)
 *   {surveyId}/snapshots/{date}/...     frozen copies, when history is enabled
 *   {surveyId}/state.json               sync watermark, counts, last result
 *
 * Authentication mirrors secretsClient.js: DefaultAzureCredential, which
 * resolves to the Function App's managed identity in Azure and to the
 * developer's `az login` session locally. A connection string is accepted as
 * a fallback so the sync can be exercised against Azurite without an Azure
 * account — that path is for local development only.
 */

const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const DEFAULT_CONTAINER = 'survey-data';

let cachedContainer = null;

function getContainerClient() {
  if (cachedContainer) return cachedContainer;

  const containerName = process.env.STORAGE_CONTAINER || DEFAULT_CONTAINER;
  const accountUrl = process.env.STORAGE_ACCOUNT_URL;
  const connectionString = process.env.STORAGE_CONNECTION_STRING;

  let serviceClient;
  if (accountUrl) {
    serviceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  } else if (connectionString) {
    // Local development only (for example Azurite). Managed identity is the
    // supported path for a deployed Function.
    serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  } else {
    throw new Error(
      'No storage configured. Set STORAGE_ACCOUNT_URL to your blob endpoint ' +
        '(https://<account>.blob.core.windows.net) so the Function can ' +
        'authenticate with its managed identity, or STORAGE_CONNECTION_STRING ' +
        'for local development.'
    );
  }

  cachedContainer = serviceClient.getContainerClient(containerName);
  return cachedContainer;
}

/** Creates the container if it does not exist. Safe to call repeatedly. */
async function ensureContainer() {
  await getContainerClient().createIfNotExists();
}

// --- paths -----------------------------------------------------------------

const paths = {
  latest: (surveyId, table) => `${surveyId}/latest/${table}.csv`,
  snapshot: (surveyId, date, table) => `${surveyId}/snapshots/${date}/${table}.csv`,
  raw: (surveyId) => `${surveyId}/raw/responses.json`,
  state: (surveyId) => `${surveyId}/state.json`,
  snapshotPrefix: (surveyId) => `${surveyId}/snapshots/`,

  // Setup state. The leading underscore keeps these clear of survey IDs,
  // which are numeric.
  config: () => '_setup/config.json',
  oauthState: () => '_setup/oauth-state.json',
};

// --- primitives ------------------------------------------------------------

async function writeText(blobPath, content, contentType = 'text/csv; charset=utf-8') {
  const blob = getContainerClient().getBlockBlobClient(blobPath);
  const body = Buffer.from(content, 'utf8');
  await blob.upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

/** Returns the blob's contents, or null when it does not exist yet. */
async function readText(blobPath) {
  const blob = getContainerClient().getBlockBlobClient(blobPath);
  try {
    const buffer = await blob.downloadToBuffer();
    return buffer.toString('utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function writeJson(blobPath, value) {
  await writeText(blobPath, JSON.stringify(value, null, 2), 'application/json; charset=utf-8');
}

async function readJson(blobPath) {
  const text = await readText(blobPath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A truncated or hand-edited blob should not permanently wedge the sync.
    // Returning null makes the caller treat it as absent and rebuild.
    return null;
  }
}

async function exists(blobPath) {
  return getContainerClient().getBlockBlobClient(blobPath).exists();
}

/** Streams a blob to the caller, or null when absent. Used by data endpoints. */
async function openReadStream(blobPath) {
  const blob = getContainerClient().getBlockBlobClient(blobPath);
  try {
    const response = await blob.download();
    return {
      stream: response.readableStreamBody,
      contentLength: response.contentLength,
      lastModified: response.lastModified,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Lists blob names under a prefix. */
async function listNames(prefix) {
  const names = [];
  for await (const item of getContainerClient().listBlobsFlat({ prefix })) {
    names.push(item.name);
  }
  return names;
}

async function deleteBlob(blobPath) {
  await getContainerClient().getBlockBlobClient(blobPath).deleteIfExists();
}

// --- snapshot retention ----------------------------------------------------

/**
 * Lists snapshot dates for a survey, newest first.
 * Dates come from the path segment rather than blob timestamps, so a
 * re-written snapshot keeps its logical date.
 */
async function listSnapshotDates(surveyId) {
  const prefix = paths.snapshotPrefix(surveyId);
  const names = await listNames(prefix);

  const dates = new Set();
  for (const name of names) {
    const rest = name.slice(prefix.length);
    const date = rest.split('/')[0];
    if (date) dates.add(date);
  }

  return [...dates].sort().reverse();
}

/**
 * Deletes snapshots older than `retentionDays`, keeping at least `keepMin`.
 * Returns the dates removed.
 *
 * Retention is enforced here rather than by a storage lifecycle policy so it
 * works the same way regardless of how the storage account was provisioned.
 */
async function pruneSnapshots(surveyId, retentionDays, keepMin = 1) {
  if (!retentionDays || retentionDays <= 0) return [];

  const dates = await listSnapshotDates(surveyId);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const removable = dates.slice(keepMin).filter((date) => date < cutoff);

  for (const date of removable) {
    const names = await listNames(`${paths.snapshotPrefix(surveyId)}${date}/`);
    for (const name of names) await deleteBlob(name);
  }

  return removable;
}

function isNotFound(err) {
  return err && (err.statusCode === 404 || err.code === 'BlobNotFound');
}

/** Test seam: drops the cached client so env changes take effect. */
function _resetForTests() {
  cachedContainer = null;
}

module.exports = {
  paths,
  ensureContainer,
  writeText,
  readText,
  writeJson,
  readJson,
  exists,
  openReadStream,
  listNames,
  deleteBlob,
  listSnapshotDates,
  pruneSnapshots,
  _resetForTests,
  DEFAULT_CONTAINER,
};
