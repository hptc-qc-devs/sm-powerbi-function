# SurveyMonkey → Power BI Connector

Connect your SurveyMonkey surveys to Power BI without writing code.

This is a self-hosted Azure Function that authenticates to SurveyMonkey,
pulls your survey responses, reshapes the nested JSON into analytics-ready
tables, and serves them over HTTPS for Power BI to consume on scheduled
refresh. You deploy it into your own Azure subscription, so your survey data
and credentials never leave your infrastructure.

> **Status: early development.** The core data endpoints work today. The
> setup wizard, storage-backed sync, and one-click deploy are in progress —
> see [`docs/ROADMAP.md`](docs/ROADMAP.md) for what's coming and in what
> order. Contributions welcome.

## Why this exists

Power BI has no native SurveyMonkey connector. The usual workarounds are
manual CSV exports (which don't refresh) or bespoke scripts (which every team
rebuilds from scratch). This project aims to be the reusable piece in the
middle: point it at your SurveyMonkey account, point Power BI at it, and let
scheduled refresh handle the rest.

## What you get

- **Flat, analytics-ready output.** SurveyMonkey's deeply nested response
  JSON becomes tabular rows Power BI can model directly.
- **Question and choice text resolved.** Answers come back as readable labels,
  not opaque IDs.
- **Skipped questions stay visible.** A question a respondent skipped emits a
  row with a null answer, so completion rates stay computable. A question that
  didn't exist yet when a response was collected emits nothing.
- **Credentials in Key Vault.** The Function reads its SurveyMonkey token via
  Managed Identity — no secrets in code, config files, or environment
  variables.
- **Logging that can't leak survey content.** The logger uses a strict
  allowlist: IDs, counts, timings, and status codes only. Question text and
  answer values are never written to logs.

## How it works

```
Power BI (Desktop / Service, scheduled refresh)
        |
        v  HTTPS, function key
Azure Function (Node.js, Consumption plan)
   - reads access token from Key Vault (Managed Identity)
   - calls the SurveyMonkey API (survey details, then responses)
   - reshapes nested JSON into tabular rows
        |
        v
Returns JSON to the caller
```

See [`docs/architecture.md`](docs/architecture.md) for the detailed design.

## Prerequisites

- An **Azure subscription** (the Function runs in your tenant)
- **Node.js 18 or 20**
- [**Azure Functions Core Tools v4**](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- **Azure CLI**, logged in via `az login` (local development uses your
  identity to reach Key Vault)
- A **SurveyMonkey Developer App** with an access token — create one at
  [developer.surveymonkey.com](https://developer.surveymonkey.com/apps/).
  The token needs the `surveys_read` and `responses_read` scopes.

## Quickstart (local)

```bash
git clone https://github.com/hptc-qc-devs/sm-powerbi-function.git
cd sm-powerbi-function
npm install
```

Copy the settings template and set your Key Vault URI:

```bash
cp local.settings.json.example local.settings.json
```

Edit `KEY_VAULT_URI` to point at your vault. **This file is gitignored —
never commit it.**

Grant yourself Key Vault access (one-time, needs vault admin rights):

```bash
az keyvault set-policy --name <your-vault-name> \
  --upn <your-email> \
  --secret-permissions get list set
```

Store your SurveyMonkey access token:

```bash
npm run setup-oauth -- --store-token     # you already have a token
npm run setup-oauth -- --full-flow       # or walk the OAuth flow
```

Run it:

```bash
npm start
```

Then check it works:

```bash
curl http://localhost:7071/api/health
curl http://localhost:7071/api/surveys
curl http://localhost:7071/api/surveys/<survey-id>/flattened-responses
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness check; confirms Key Vault is reachable. Does not call SurveyMonkey. |
| `GET /api/surveys` | Lists surveys visible to your token. Use it to find survey IDs. |
| `GET /api/surveys/{surveyId}/flattened-responses` | The data feed Power BI consumes. Optional `?modifiedSince=<ISO-8601>` narrows the pull. |

### Output schema

One row per response × question × answer:

`snapshot_date`, `survey_id`, `survey_title`, `response_id`,
`response_status`, `date_created`, `date_modified`, `question_id`,
`question_text`, `question_type`, `answer_value`, `choice_id`,
`collector_id`, `language`

A richer star schema with typed numeric values is planned — see the roadmap.

## Connecting Power BI

Power BI Desktop and Service use the **Web** connector pointed at:

```
https://<your-function-app>.azurewebsites.net/api/surveys/<surveyId>/flattened-responses
```

The function key is the credential. Supply it as an `x-functions-key` header
rather than embedding it in the URL, so it isn't stored in plain text in the
query string. A full walkthrough including scheduled refresh setup is coming
in `docs/powerbi.md`.

## Deploying to Azure

1. Create a Function App with a System-Assigned Managed Identity enabled.
2. Grant that identity `get` and `list` permissions on your Key Vault secrets.
3. Set the application settings: `KEY_VAULT_URI`, `SM_API_BASE_URL`,
   `SM_ACCESS_TOKEN_SECRET_NAME`, `SECRETS_BACKEND=keyvault`.
4. Deploy: `func azure functionapp publish <app-name>`.
5. Get the function key from the portal (Function App → App keys) and use it
   as the Power BI credential.

A one-click "Deploy to Azure" button with a Bicep template is on the roadmap.

## Running tests

```bash
npm test
```

Tests cover the transformation logic using fixture JSON — no network calls and
no Azure dependency, so they run anywhere. The transform is the part most
likely to need adjustment as real survey data reveals edge cases, so it has
the tightest coverage.

## Current limitations

- **No persistent storage yet.** Every refresh re-pulls from SurveyMonkey,
  which is bounded by SurveyMonkey's rate limits and can time out on large
  surveys. Storage-backed sync is the next milestone.
- **No history.** SurveyMonkey only exposes current state, so year-over-year
  and trend analysis need the snapshot layer on the roadmap.
- **One survey per request.** Cross-survey dashboards currently need one
  Power BI query per survey, unioned in Power Query.
- **No automated token refresh**, because SurveyMonkey doesn't offer it. A
  revoked token surfaces as a clear 502; recovery is re-running the setup
  script.

## Contributing

Contributions are very welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
Good first issues are labelled in the tracker, and
[`docs/ROADMAP.md`](docs/ROADMAP.md) shows where the project is heading if
you want to take on something larger.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).
Do not open a public issue for a security problem.

## License

[MIT](LICENSE)

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by, or
sponsored by SurveyMonkey or Microsoft.
