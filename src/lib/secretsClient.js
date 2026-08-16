/**
 * secretsClient.js
 *
 * Abstraction over secret storage. Every other module calls getSecret(name)
 * and never knows which backend is behind it, so an organization that
 * mandates a different secrets manager only has to change this file.
 *
 * Current backend: Azure Key Vault, authenticated via DefaultAzureCredential.
 *   - In Azure: resolves to the Function App's System-Assigned Managed
 *     Identity. No client secret, no credential to rotate.
 *   - In local dev: resolves to your `az login` session, so developers can
 *     hit the real (or a dev) Key Vault without checking in any credential.
 */

const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');

let cachedClient = null;

function getKeyVaultClient() {
  if (cachedClient) return cachedClient;

  const vaultUri = process.env.KEY_VAULT_URI;
  if (!vaultUri) {
    throw new Error(
      'KEY_VAULT_URI is not set. Add it to local.settings.json (local) or ' +
        'Function App Application Settings (deployed).'
    );
  }

  const credential = new DefaultAzureCredential();
  cachedClient = new SecretClient(vaultUri, credential);
  return cachedClient;
}

/**
 * In-memory cache for secret values within a single warm Function instance.
 * Avoids hitting Key Vault on every invocation. Cold starts naturally reset
 * this. TTL is intentionally short relative to survey-detail caching, since
 * secrets can be rotated and we want rotation to take effect reasonably fast.
 */
const secretCache = new Map(); // name -> { value, fetchedAt }
const SECRET_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Retrieve a secret by logical name.
 * @param {string} secretName - the name of the secret as stored in the backend
 * @returns {Promise<string>}
 */
async function getSecret(secretName) {
  const backend = process.env.SECRETS_BACKEND || 'keyvault';

  if (backend === 'local-override') {
    // Explicit local-dev escape hatch. Logged loudly so it's never mistaken
    // for a production path. See local.settings.json.example.
    const overrideValue = process.env.SM_ACCESS_TOKEN_LOCAL_OVERRIDE;
    if (secretName === process.env.SM_ACCESS_TOKEN_SECRET_NAME && overrideValue) {
      console.warn(
        '[secretsClient] Using SM_ACCESS_TOKEN_LOCAL_OVERRIDE — local dev only. ' +
          'This path must never run in a deployed Function.'
      );
      return overrideValue;
    }
  }

  const cached = secretCache.get(secretName);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < SECRET_CACHE_TTL_MS) {
    return cached.value;
  }

  if (backend !== 'keyvault') {
    throw new Error(
      `Unsupported SECRETS_BACKEND "${backend}". Supported: "keyvault" ` +
        `(production), "local-override" (local dev only).`
    );
  }

  const client = getKeyVaultClient();
  const secret = await client.getSecret(secretName);
  secretCache.set(secretName, { value: secret.value, fetchedAt: now });
  return secret.value;
}

/**
 * Write/update a secret. Used only by the one-time setup script
 * (scripts/setupOAuth.js) to store the access token obtained via the OAuth
 * flow. The deployed HTTP function never calls this — it only reads.
 */
async function setSecret(secretName, value) {
  const client = getKeyVaultClient();
  await client.setSecret(secretName, value);
  secretCache.delete(secretName); // force re-read next time
}

module.exports = { getSecret, setSecret };
