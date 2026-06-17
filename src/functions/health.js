const { app } = require('@azure/functions');
const { getSecret } = require('../lib/secretsClient');
const { makeLogger } = require('../lib/logger');

/**
 * GET /api/health
 *
 * Lightweight liveness/readiness probe. Confirms:
 *   - the Function App is running
 *   - it can reach Key Vault via its Managed Identity
 *   - the expected secrets exist (without revealing their values)
 *
 * Deliberately does NOT call the SurveyMonkey API — this should stay cheap
 * and fast enough to use as an Azure Monitor availability check.
 */
app.http('health', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'health',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const start = Date.now();

    const checks = { keyVaultReachable: false };

    try {
      const secretName = process.env.SM_ACCESS_TOKEN_SECRET_NAME || 'surveymonkey-access-token';
      const token = await getSecret(secretName);
      checks.keyVaultReachable = Boolean(token);
    } catch (err) {
      log.error('Health check failed to reach Key Vault', { errorName: err.name });
      return {
        status: 503,
        jsonBody: { status: 'unhealthy', checks, error: 'key_vault_unreachable' },
      };
    }

    log.info('Health check passed', { durationMs: Date.now() - start });
    return {
      status: 200,
      jsonBody: { status: 'healthy', checks, timestamp: new Date().toISOString() },
    };
  },
});
