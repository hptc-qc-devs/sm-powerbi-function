# SurveyMonkey → Power BI Integration (Phase 1)

Node.js Azure Function that authenticates to SurveyMonkey via OAuth 2.0,
fetches survey responses, flattens the nested JSON into a tabular shape, and
serves it over HTTPS for Power BI to consume on scheduled refresh.

This is the Phase 1 build per the Scope of Work: stateless, HTTP-triggered,
no database, no Blob Storage (that's Phase 2 / optional). Every request
re-fetches from SurveyMonkey directly.

## Architecture

```
Power BI (Desktop / Service, scheduled refresh)
        |
        v  HTTPS, function key
Azure Function (Node.js, Consumption plan)
   - reads access token from Key Vault (Managed Identity, no stored creds)
   - calls SurveyMonkey API (survey details, then responses/bulk)
   - flattens nested JSON -> tabular rows
        |
        v
Returns JSON directly to the caller (no persistent storage in Phase 1)
```

## Project layout

```
src/
  functions/
    health.js                  GET /api/health
    listSurveys.js             GET /api/surveys
    getFlattenedResponses.js   GET /api/surveys/{surveyId}/flattened-responses
  lib/
    secretsClient.js           Key Vault abstraction (swappable backend)
    surveyMonkeyClient.js      SurveyMonkey API wrapper, 401/403 handling
    surveyDetailsCache.js      Module-level cache for question/choice lookups
    flatten.js                 Pure flattening logic (the core transform)
    logger.js                  PHI-safe structured logging
scripts/
  setupOAuth.js                One-time, LOCAL ONLY: stores token in Key Vault
test/
  flatten.test.js              Unit tests for the flattening logic
  fixtures/                    Sample survey details + responses
```

## Prerequisites

- Node.js LTS 18 or 20 (matches SOW 2.3 — this repo currently runs fine on
  Node 22 too, but `package.json` pins `engines` to 18–20 to match the
  agreed local dev environment)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- An Azure subscription with a Key Vault created
- Azure CLI, logged in (`az login`) — used by `DefaultAzureCredential` for
  local development
- A SurveyMonkey Developer App with an access token already obtained (per
  the SOW, OAuth testing in Postman is assumed complete)

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the settings template and fill in your Key Vault URI:
   ```bash
   cp local.settings.json.example local.settings.json
   ```
   Edit `KEY_VAULT_URI` to point at your vault. **This file is gitignored —
   never commit it.**

3. Grant yourself Key Vault access for local development (one-time, run by
   whoever has Key Vault admin rights):
   ```bash
   az keyvault set-policy --name <your-vault-name> \
     --upn <your-email> \
     --secret-permissions get list set
   ```

4. Store your already-obtained SurveyMonkey access token in Key Vault:
   ```bash
   npm run setup-oauth -- --store-token
   ```
   This is the path you'll use right now. The `--full-flow` mode exists for
   later, only if the token is ever revoked — see `scripts/setupOAuth.js`
   for details on why SurveyMonkey doesn't support silent token refresh.

5. Run the function locally:
   ```bash
   npm start
   ```

6. Validate:
   ```bash
   curl http://localhost:7071/api/health
   curl http://localhost:7071/api/surveys
   curl http://localhost:7071/api/surveys/<a-real-survey-id>/flattened-responses
   ```

## Running tests

```bash
npm test
```

Tests cover the flattening logic only (`flatten.js`, `surveyDetailsCache.js`)
using fixture JSON — no network calls, no Azure dependency. This is
deliberate: the transformation logic is the part most likely to need
adjustment as real survey data reveals edge cases, so it's the part with the
tightest test coverage.

## Deploying to Azure

This README covers the function code itself. Infrastructure provisioning
(Function App, Key Vault, Managed Identity role assignment) is covered in
`docs/architecture.md` — happy to generate the exact `az` CLI commands or a
Bicep/ARM template next if that's useful.

High-level deployment steps:

1. Create the Function App with a System-Assigned Managed Identity enabled.
2. Grant that identity `get` and `list` permissions on Key Vault secrets.
3. Set Application Settings (`KEY_VAULT_URI`, `SM_API_BASE_URL`,
   `SM_ACCESS_TOKEN_SECRET_NAME`, `SECRETS_BACKEND=keyvault`) — these mirror
   `local.settings.json` but are configured in the Azure portal / via `az
   functionapp config appsettings set`, not committed anywhere.
4. Deploy with `func azure functionapp publish <app-name>`.
5. Retrieve the function key from the portal (Function App → App keys) and
   give it to whoever configures the Power BI data source — this is the
   credential Power BI's Web connector uses, not a SurveyMonkey credential.

## What Power BI connects to

Power BI Desktop/Service uses the **Web** data source connector pointed at:

```
https://<your-function-app>.azurewebsites.net/api/surveys/<surveyId>/flattened-responses?code=<function-key>
```

The function key goes in as a credential, not hardcoded in the URL, when
configuring the data source in Power BI Desktop (Web.Contents with a
headers parameter, or the key as part of the URL with "Anonymous" auth
disabled — exact mechanics will go in `docs/architecture.md`).

## Known limitations of this Phase 1 build

- No persistent storage: every refresh re-pulls and re-flattens from
  SurveyMonkey. Fine for current-state KPI reporting; not yet suitable for
  historical/trend analysis (e.g. FY25 vs FY26) — that requires the Phase 2
  Blob Storage snapshot layer.
- One survey per request: `getFlattenedResponses` takes a single
  `surveyId`. A master cross-survey dashboard will need either multiple
  Power BI queries (one per survey, unioned in Power Query) or a follow-up
  endpoint that accepts multiple survey IDs — worth deciding once real KPI
  requirements are finalized per SOW 2.7.
- No automated token refresh, because SurveyMonkey doesn't support it. A
  revoked token surfaces as a 502 from this Function with a clear message;
  recovery is the manual `--full-flow` script.
