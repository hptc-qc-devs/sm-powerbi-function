# Deploying

Two routes. The button provisions everything for you; the CLI route does the
same thing with each step visible.

Either way you end up with a running Function App that has **no credentials
yet** — you finish in the browser with the setup wizard.

## What gets created

| Resource | Why |
|---|---|
| Function App (Consumption, Linux, Node 22) | Runs the connector. Costs nothing at rest; Consumption bills per execution. |
| App Service plan (Y1 Dynamic) | The Consumption plan the Function App runs on. |
| Storage account | Holds the synced survey tables, and the Functions runtime's own state. |
| Blob container `survey-data` | Where synced CSVs go. Private. |
| Key Vault | Holds the SurveyMonkey token and OAuth client secret. |
| Application Insights + Log Analytics | Logs, failures, and sync timings. |
| Two role assignments | The Function App's identity gets Blob Data Contributor on storage and Secrets Officer on Key Vault. |

For a few surveys on a six-hour schedule this sits at the bottom of the
Consumption free grant; the meaningful cost is storage, which is pennies at
survey scale unless you keep years of snapshots.

## Option 1 — Deploy to Azure button

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fhptc-qc-devs%2Fsm-powerbi-function%2Fmaster%2Fazuredeploy.json)

> **Before the first tagged release**, the default `packageUri` points at a
> release that does not exist yet, so the button provisions the
> infrastructure but installs no code. Until `v1.0.0` is published, set
> `packageUri` to empty in the portal and deploy the code yourself with
> `func azure functionapp publish`, or use the CLI route below.

The portal asks for a resource group and a **base name** — 3 to 17 lower-case
letters and numbers. Everything else has a working default.

| Parameter | Default | Notes |
|---|---|---|
| `baseName` | — | The only required value. A short unique suffix is appended so names stay globally unique. |
| `location` | resource group's region | |
| `syncSchedule` | `0 0 */6 * * *` | NCRONTAB in UTC — **six** fields, seconds first. |
| `enableHistory` | `false` | Turn on for quarter-over-quarter reporting. |
| `snapshotRetentionDays` | `90` | `0` keeps snapshots indefinitely. |
| `syncSurveyIds` | empty | Empty syncs every survey the token can see. |
| `packageUri` | latest release zip | Set empty to deploy code yourself. |

When it finishes, open **Outputs** on the deployment. `setupWizardUrl` is
where you go next.

## Option 2 — Azure CLI

```bash
az login
az group create --name sm-powerbi-rg --location eastus

az deployment group create \
  --resource-group sm-powerbi-rg \
  --template-file infra/main.bicep \
  --parameters baseName=mysurveys enableHistory=true
```

Read the outputs back with:

```bash
az deployment group show \
  --resource-group sm-powerbi-rg \
  --name main \
  --query properties.outputs
```

### Deploying your own code

The template installs the latest published release by default. To deploy from
your working copy instead, pass an empty `packageUri` and publish afterwards:

```bash
az deployment group create \
  --resource-group sm-powerbi-rg \
  --template-file infra/main.bicep \
  --parameters baseName=mysurveys packageUri=''

func azure functionapp publish <functionAppName-from-outputs>
```

## Finish in the browser

Deployment leaves the app running with no SurveyMonkey credentials. Get the
master key:

```bash
az functionapp keys list \
  --resource-group sm-powerbi-rg \
  --name <functionAppName> \
  --query masterKey -o tsv
```

Then open the wizard:

```
https://<functionAppName>.azurewebsites.net/api/ui?code=<master-key>
```

It walks through creating a SurveyMonkey app, connecting it, choosing surveys,
running the first sync, and generating your Power BI connection details. If
you'd rather script it, every step is a plain HTTP call — see
[`setup-api.md`](setup-api.md).

## Changing settings later

Sync settings — which surveys, history, retention, response status — are
changed in the wizard, or via `POST /api/setup/sync-config`, and take effect
immediately.

**The schedule is the exception.** The Functions host binds the timer trigger
at startup, so `SYNC_SCHEDULE` has to be an application setting and the app
has to restart:

```bash
az functionapp config appsettings set \
  --resource-group sm-powerbi-rg \
  --name <functionAppName> \
  --settings SYNC_SCHEDULE="0 0 */2 * * *"

az functionapp restart --resource-group sm-powerbi-rg --name <functionAppName>
```

Saving a schedule in the wizard returns it under `pending_app_settings` for
exactly this reason.

## Upgrading

Redeploying the template to the same resource group updates in place — the
name suffix is derived from the resource group ID, so it stays stable rather
than creating a second set of resources.

With the default `packageUri`, redeploying picks up the latest release. If
you're publishing your own code, `func azure functionapp publish` is enough on
its own; you only need the template again when the infrastructure changes.

## Editing the infrastructure

[`../infra/main.bicep`](../infra/main.bicep) is the source of truth.
`azuredeploy.json` at the repository root is its compiled output and is what
the button deploys, so recompile after any change:

```bash
az bicep build --file infra/main.bicep --outfile azuredeploy.json
```

CI recompiles and fails if the committed template has drifted, because a stale
`azuredeploy.json` means the button quietly installs the previous
infrastructure.

## Removing everything

```bash
az group delete --name sm-powerbi-rg --yes
```

Key Vault has soft-delete enabled with a seven-day retention, so the vault
name is reserved for a week afterwards. Deploying again with the same base
name inside that window either needs the vault purged
(`az keyvault purge --name <vaultName>`) or a different base name.

## Troubleshooting

**The app won't start / no functions appear.** Almost always a missing
`SYNC_SCHEDULE` — the timer trigger resolves it by name at startup and the host
fails to bind without it. The template always sets it; a hand-built deployment
may not have.

**Syncs fail on write.** The Function App identity is missing **Storage Blob
Data Contributor** on the storage account. The template assigns it; check
under Storage account → Access control (IAM).

**The wizard can't save a token.** The identity needs **Key Vault Secrets
Officer**, not just Secrets User — the wizard writes secrets, it doesn't only
read them.

**`/api/ui` returns 401.** Append `?code=<master-key>`. It's under Function
App → App keys → `_master`, not the default function key.
