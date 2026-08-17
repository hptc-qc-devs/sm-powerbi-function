/**
 * Checks the compiled ARM template.
 *
 * Infrastructure mistakes are expensive to find the normal way: the template
 * deploys cleanly, and the problem only shows up as a failed sync or a
 * Function App that will not start. These assertions pin the handful of
 * things that are both easy to drop while editing and painful to diagnose
 * afterwards.
 *
 * They read azuredeploy.json rather than the Bicep source, because that
 * compiled file is what the Deploy to Azure button actually deploys.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'azuredeploy.json'), 'utf8'));
const bicepSource = fs.readFileSync(path.join(ROOT, 'infra', 'main.bicep'), 'utf8');

const resourcesOfType = (type) => template.resources.filter((r) => r.type === type);
const functionApp = () => resourcesOfType('Microsoft.Web/sites')[0];

// appSettings compiles to a single ARM expression string, so presence is
// checked by looking inside it rather than by enumerating an array.
const appSettingsExpression = () => JSON.stringify(functionApp().properties.siteConfig.appSettings);

// --- template shape --------------------------------------------------------

test('the template is a valid ARM deployment template', () => {
  assert.match(template.$schema, /deploymentTemplate\.json/);
  assert.ok(template.contentVersion);
  assert.ok(Array.isArray(template.resources));
});

test('every resource the connector needs is provisioned', () => {
  const required = [
    'Microsoft.Storage/storageAccounts',
    'Microsoft.Storage/storageAccounts/blobServices/containers',
    'Microsoft.KeyVault/vaults',
    'Microsoft.Insights/components',
    'Microsoft.Web/serverfarms',
    'Microsoft.Web/sites',
  ];

  for (const type of required) {
    assert.equal(resourcesOfType(type).length >= 1, true, `${type} should be provisioned`);
  }
});

test('parameters cover the choices a deployer needs to make', () => {
  for (const name of [
    'baseName',
    'location',
    'syncSchedule',
    'enableHistory',
    'snapshotRetentionDays',
    'syncSurveyIds',
    'packageUri',
  ]) {
    assert.ok(template.parameters[name], `${name} should be a parameter`);
  }
});

test('only baseName is required; everything else has a usable default', () => {
  for (const [name, spec] of Object.entries(template.parameters)) {
    if (name === 'baseName') {
      assert.equal(spec.defaultValue, undefined, 'baseName must be supplied');
    } else {
      assert.notEqual(spec.defaultValue, undefined, `${name} should default`);
    }
  }
});

// --- the wiring that breaks things silently --------------------------------

test('the Function App has a system-assigned identity', () => {
  // Without this there is no principal to grant storage or Key Vault access
  // to, and both role assignments below have nothing to bind.
  assert.equal(functionApp().identity.type, 'SystemAssigned');
});

test('SYNC_SCHEDULE is set, because the host binds the timer by name', () => {
  // The timer trigger resolves %SYNC_SCHEDULE% at startup. If the setting is
  // absent the app does not merely skip syncing - it fails to start.
  assert.match(appSettingsExpression(), /SYNC_SCHEDULE/);
});

test('every application setting the code reads is provided', () => {
  const settings = appSettingsExpression();

  for (const name of [
    'FUNCTIONS_EXTENSION_VERSION',
    'FUNCTIONS_WORKER_RUNTIME',
    'AzureWebJobsStorage',
    'KEY_VAULT_URI',
    'SECRETS_BACKEND',
    'SM_API_BASE_URL',
    'SM_ACCESS_TOKEN_SECRET_NAME',
    'SM_CLIENT_ID_SECRET_NAME',
    'SM_CLIENT_SECRET_SECRET_NAME',
    'STORAGE_ACCOUNT_URL',
    'STORAGE_CONTAINER',
    'SYNC_SURVEY_IDS',
    'SYNC_HISTORY_ENABLED',
    'SYNC_SNAPSHOT_RETENTION_DAYS',
  ]) {
    assert.match(settings, new RegExp(name), `${name} should be an app setting`);
  }
});

test('storage access uses the blob endpoint, not a connection string', () => {
  // STORAGE_ACCOUNT_URL takes precedence in blobStore.js and makes the app
  // authenticate with its managed identity, so no storage key is involved in
  // the connector's own data access.
  assert.match(appSettingsExpression(), /primaryEndpoints/);
});

test('both role assignments are created', () => {
  const assignments = resourcesOfType('Microsoft.Authorization/roleAssignments');
  assert.equal(assignments.length, 2);

  // The role IDs compile into template variables, so check the values there
  // and that the assignments reference them.
  // Storage Blob Data Contributor: without it every sync fails on write.
  assert.equal(template.variables.blobDataContributorRoleId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe');
  // Key Vault Secrets Officer: the wizard writes the token, not just reads it,
  // so Secrets User would be insufficient.
  assert.equal(
    template.variables.keyVaultSecretsOfficerRoleId,
    'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  );

  const roles = JSON.stringify(assignments);
  assert.match(roles, /blobDataContributorRoleId/);
  assert.match(roles, /keyVaultSecretsOfficerRoleId/);

  // Both must bind to the Function App's own identity, not a hardcoded
  // principal.
  for (const assignment of assignments) {
    assert.equal(assignment.properties.principalType, 'ServicePrincipal');
    assert.match(assignment.properties.principalId, /identity\.principalId/);
  }
});

// --- security defaults -----------------------------------------------------

test('storage refuses plaintext and public blob access', () => {
  const storage = resourcesOfType('Microsoft.Storage/storageAccounts')[0];

  assert.equal(storage.properties.supportsHttpsTrafficOnly, true);
  assert.equal(storage.properties.allowBlobPublicAccess, false);
  assert.equal(storage.properties.minimumTlsVersion, 'TLS1_2');
});

test('the blob container is private', () => {
  const container = resourcesOfType(
    'Microsoft.Storage/storageAccounts/blobServices/containers'
  )[0];
  assert.equal(container.properties.publicAccess, 'None');
});

test('Key Vault uses RBAC and keeps soft-delete on', () => {
  const vault = resourcesOfType('Microsoft.KeyVault/vaults')[0];

  assert.equal(vault.properties.enableRbacAuthorization, true);
  assert.equal(vault.properties.enableSoftDelete, true);
});

test('the Function App is HTTPS-only with FTP disabled', () => {
  const app = functionApp();

  assert.equal(app.properties.httpsOnly, true);
  assert.equal(app.properties.siteConfig.ftpsState, 'Disabled');
  assert.equal(app.properties.siteConfig.minTlsVersion, '1.2');
});

test('the runtime matches the Node versions the project supports', () => {
  const app = functionApp();
  assert.match(app.properties.siteConfig.linuxFxVersion, /^Node\|(20|22)$/);
});

// --- outputs ---------------------------------------------------------------

test('outputs point the deployer at the setup wizard', () => {
  assert.ok(template.outputs.setupWizardUrl, 'the next step after deploying is the wizard');
  assert.match(JSON.stringify(template.outputs.setupWizardUrl), /api\/ui/);
  assert.ok(template.outputs.functionAppUrl);
  assert.ok(template.outputs.functionAppName);
});

// --- source and compiled output agree --------------------------------------

test('the compiled template was generated from this Bicep source', () => {
  // A stale azuredeploy.json is the failure mode here: someone edits the
  // Bicep, forgets to recompile, and the button deploys the old template. CI
  // recompiles and diffs; this catches the obvious drift locally.
  const paramNames = Object.keys(template.parameters);

  for (const name of paramNames) {
    assert.match(
      bicepSource,
      new RegExp(`param ${name}\\b`),
      `${name} is in the compiled template but not in main.bicep`
    );
  }

  const bicepParams = [...bicepSource.matchAll(/^param (\w+)/gm)].map((m) => m[1]);
  for (const name of bicepParams) {
    assert.ok(
      paramNames.includes(name),
      `${name} is in main.bicep but not the compiled template - recompile it`
    );
  }
});
