/*
  Provisions everything the connector needs, wired together.

  Function App (Consumption, Node 22, system-assigned identity)
  Storage account  - synced survey tables, plus the Functions runtime's own state
  Key Vault        - the SurveyMonkey token
  Application Insights - logs and failure alerts

  The point of doing this as a template rather than a list of portal steps is
  the wiring. Three things have to line up for the connector to work at all,
  and each is easy to miss by hand:

    1. The Function App's managed identity needs Blob Data Contributor on the
       storage account, or every sync fails on write.
    2. The same identity needs to read and write Key Vault secrets, or the
       setup wizard cannot store a token.
    3. STORAGE_ACCOUNT_URL, KEY_VAULT_URI and SYNC_SCHEDULE must be set as
       application settings. SYNC_SCHEDULE especially - the timer trigger
       resolves it by name at startup, so the app will not start without it.

  Deploying this template leaves you with a running app that has no credentials
  yet. Finish in the browser at:  https://<app>.azurewebsites.net/api/ui?code=<master-key>
*/

@description('Base name for all resources. Lower-case letters and numbers, 3-17 characters. A unique suffix is appended so names stay globally unique.')
@minLength(3)
@maxLength(17)
param baseName string

@description('Region for all resources. Defaults to the resource group\'s region.')
param location string = resourceGroup().location

@description('How often to pull from SurveyMonkey, as an NCRONTAB expression in UTC (six fields, seconds first). The default is every six hours.')
param syncSchedule string = '0 0 */6 * * *'

@description('Keep a dated snapshot on every sync. Required for quarter-over-quarter and year-over-year reporting, since SurveyMonkey itself only exposes current state.')
param enableHistory bool = false

@description('Delete snapshots older than this many days. 0 keeps them indefinitely. Ignored when history is off.')
@minValue(0)
param snapshotRetentionDays int = 90

@description('Which surveys to sync, comma-separated. Leave empty to sync every survey the token can see; narrow this on a large account to stay inside SurveyMonkey\'s daily API limit.')
param syncSurveyIds string = ''

@description('Zip package to deploy. Leave as the default to install the latest release; set to an empty string to deploy code yourself with func azure functionapp publish.')
param packageUri string = 'https://github.com/Harsha99-99/surveymonkey-powerbi-connector/releases/latest/download/surveymonkey-powerbi-connector.zip'

// A deterministic suffix keeps globally-unique names stable across repeat
// deployments to the same resource group, so redeploying updates in place
// rather than creating a second set of resources.
var suffix = substring(uniqueString(resourceGroup().id), 0, 5)
var storageName = toLower('${replace(baseName, '-', '')}${suffix}')
var functionAppName = '${baseName}-${suffix}'
var keyVaultName = take('${baseName}-kv-${suffix}', 24)
var dataContainerName = 'survey-data'

// Built-in role definition IDs. Referenced by GUID because the names are not
// resolvable from a template.
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

// --- storage ---------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    accessTier: 'Hot'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// Created up front so the first sync does not have to, and so the container
// exists for anyone who wants to inspect synced CSVs before running one.
resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: dataContainerName
  properties: {
    publicAccess: 'None'
  }
}

// --- observability ---------------------------------------------------------

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${functionAppName}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${functionAppName}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// --- key vault -------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    // RBAC rather than access policies: it is the current default, and it
    // lets the role assignments below grant access declaratively.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// --- function app ----------------------------------------------------------

resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${functionAppName}-plan'
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {}
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    reserved: true
    siteConfig: {
      linuxFxVersion: 'Node|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: concat([
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22'
        }
        {
          // The Functions runtime keeps its own state (timer schedule
          // bookkeeping, lease locks) here. It is the same account the synced
          // data goes to, but a different set of containers.
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVault.properties.vaultUri
        }
        {
          name: 'SECRETS_BACKEND'
          value: 'keyvault'
        }
        {
          name: 'SM_API_BASE_URL'
          value: 'https://api.surveymonkey.com/v3'
        }
        {
          name: 'SM_ACCESS_TOKEN_SECRET_NAME'
          value: 'surveymonkey-access-token'
        }
        {
          name: 'SM_CLIENT_ID_SECRET_NAME'
          value: 'surveymonkey-client-id'
        }
        {
          name: 'SM_CLIENT_SECRET_SECRET_NAME'
          value: 'surveymonkey-client-secret'
        }
        {
          // Blob endpoint rather than a connection string: the app
          // authenticates with its managed identity, so there is no key here
          // to leak or rotate.
          name: 'STORAGE_ACCOUNT_URL'
          value: storage.properties.primaryEndpoints.blob
        }
        {
          name: 'STORAGE_CONTAINER'
          value: dataContainerName
        }
        {
          // Read by name when the timer trigger binds at startup. The app
          // will not start without it.
          name: 'SYNC_SCHEDULE'
          value: syncSchedule
        }
        {
          name: 'SYNC_SURVEY_IDS'
          value: syncSurveyIds
        }
        {
          name: 'SYNC_HISTORY_ENABLED'
          value: string(enableHistory)
        }
        {
          name: 'SYNC_SNAPSHOT_RETENTION_DAYS'
          value: string(snapshotRetentionDays)
        }
        {
          // Longer than the host's functionTimeout, so a slow but living sync
          // is never elbowed aside by the next scheduled run.
          name: 'SYNC_LOCK_TTL_MS'
          value: '1200000'
        }
        {
          // Keeping the previous published version lets a Power BI refresh
          // already in flight finish reading it.
          name: 'SYNC_VERSIONS_KEPT'
          value: '2'
        }
        {
          // Consumption plans cap around 1.5 GB and the whole survey is held
          // in memory; failing with a clear message beats being killed.
          name: 'SYNC_MAX_RESPONSES'
          value: '200000'
        }
      ], empty(packageUri) ? [] : [
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: packageUri
        }
      ])
    }
  }
}

// --- access ----------------------------------------------------------------

// Without this the app deploys cleanly and then fails on the first sync write,
// which is a confusing way to discover a missing role assignment.
resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      blobDataContributorRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Secrets Officer, not Secrets User: the setup wizard writes the token, it
// does not only read it.
resource keyVaultRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, functionApp.id, keyVaultSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsOfficerRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// --- outputs ---------------------------------------------------------------

@description('Open this to finish setup in the browser. Append ?code=<master-key>, which you can copy from the portal under Function App > App keys.')
output setupWizardUrl string = 'https://${functionApp.properties.defaultHostName}/api/ui'

@description('Base URL for Power BI connections.')
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'

@description('Name of the deployed Function App, for use with the az CLI.')
output functionAppName string = functionApp.name

@description('Storage account holding the synced survey tables.')
output storageAccountName string = storage.name

@description('Key Vault holding the SurveyMonkey credentials.')
output keyVaultName string = keyVault.name
