# SurveyMonkey → Power BI Connector

Connect your SurveyMonkey surveys to Power BI without writing code.

This is a self-hosted Azure Function that authenticates to SurveyMonkey,
pulls your survey responses, reshapes the nested JSON into analytics-ready
tables, and serves them over HTTPS for Power BI to consume on scheduled
refresh. You deploy it into your own Azure subscription, so your survey data
and credentials never leave your infrastructure.

> **Status: early development.** Direct-mode endpoints and the scheduled sync
> into Blob Storage work today. The endpoints that *serve* the synced tables
> to Power BI are next, followed by the setup wizard and one-click deploy —
> see [`docs/ROADMAP.md`](docs/ROADMAP.md). Contributions welcome.

## Why this exists

Power BI has no native SurveyMonkey connector. The usual workarounds are
manual CSV exports (which don't refresh) or bespoke scripts (which every team
rebuilds from scratch). This project aims to be the reusable piece in the
middle: point it at your SurveyMonkey account, point Power BI at it, and let
scheduled refresh handle the rest.

## What you get

- **A model, not a blob of JSON.** Five related tables (`surveys`,
  `questions`, `choices`, `responses`, `answers`) that Power BI can build
  relationships across. A single flat table is also produced if you'd rather
  not model anything.
- **Numbers that behave like numbers.** Rating scales and weighted choices
  carry their numeric value, so you can average a satisfaction score without
  building a lookup table by hand in Power Query.
- **Matrix and "Other" questions handled properly.** Matrix rows get their own
  columns instead of being mashed into one string, and "Other (please
  specify)" keeps both the choice and the text the respondent typed.
- **Scheduled sync, so refreshes are fast and safe.** Data is pulled from
  SurveyMonkey on your schedule and written to your own Blob Storage. Power BI
  reads the stored files, which means refresh frequency in Power BI has no
  effect on SurveyMonkey API usage — and a SurveyMonkey outage doesn't empty
  your report.
- **Optional history.** Turn on snapshots and each sync freezes a dated copy,
  which is what makes quarter-over-quarter analysis possible — SurveyMonkey
  itself only ever tells you the current state.
- **Skipped questions stay visible.** A skipped question emits a flagged row
  rather than vanishing, so completion rates stay honest. A question added to
  the survey after a response was collected emits nothing for it.
- **Credentials in Key Vault.** The Function reads its SurveyMonkey token via
  Managed Identity — no secrets in code, config files, or environment
  variables. Respondent identifiers are stripped before anything is stored.
- **Logging that can't leak survey content.** The logger uses a strict
  allowlist: IDs, counts, timings, and status codes only. Question text and
  answer values are never written to logs.

## How it works

```
        timer (default: every 6 hours)
                 |
                 v
        Azure Function
          - reads the SurveyMonkey token from Key Vault
          - pulls survey structure + responses (incrementally)
          - builds the tables, writes CSV
                 |
                 v
        Blob Storage (your storage account)
                 |
                 v  HTTPS, function key
        Power BI scheduled refresh
```

See [`docs/architecture.md`](docs/architecture.md) for the detailed design and
the reasoning behind it.

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

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | function key | Liveness check; confirms Key Vault is reachable. Does not call SurveyMonkey. |
| `GET /api/surveys` | function key | Lists surveys visible to your token. Use it to find survey IDs. |
| `POST /api/sync` | admin key | Syncs every configured survey now. `?full=true` re-pulls everything. |
| `POST /api/sync/{surveyId}` | admin key | Syncs one survey now. |
| `GET /api/surveys/{surveyId}/flattened-responses` | function key | Direct mode: pulls and flattens live, storing nothing. |

Sync also runs automatically on the `SYNC_SCHEDULE` timer (default: every six
hours).

The sync writes to Blob Storage. **The endpoints that serve those files to
Power BI are the next milestone** — until then, Power BI connects through
direct mode, and you can inspect synced output directly in your storage
account.

### Output schema

Each sync writes six CSV files per survey:

| File | Grain | Notable columns |
|---|---|---|
| `surveys.csv` | 1 row per survey | title, language, question_count, response_count |
| `questions.csv` | 1 row per question | heading, family, subtype, page/position |
| `choices.csv` | 1 row per choice, matrix row, or "other" option | text, kind, **weight**, is_na |
| `responses.csv` | 1 row per response | status, collector, dates, time spent, language |
| `answers.csv` | 1 row per answer | choice_id, row_id, row_text, **value_text**, **value_numeric**, other_text, is_skipped |
| `flat.csv` | 1 row per answer | everything above joined into one table, for simple use |

`value_numeric` is what makes rating scales aggregatable — a 1–5 satisfaction
question gives you the number, not just the label.

### Storage layout

```
{surveyId}/latest/{table}.csv        current data
{surveyId}/snapshots/{date}/...      frozen copies (when history is enabled)
{surveyId}/state.json                last sync time, watermark, row counts
```

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
3. Grant that same identity the **Storage Blob Data Contributor** role on the
   storage account the sync writes to.
4. Set the application settings — `KEY_VAULT_URI`, `SM_API_BASE_URL`,
   `SM_ACCESS_TOKEN_SECRET_NAME`, `SECRETS_BACKEND=keyvault`,
   `STORAGE_ACCOUNT_URL`, `STORAGE_CONTAINER`, and `SYNC_SCHEDULE`.
   `local.settings.json.example` documents every setting and its default.
5. Deploy: `func azure functionapp publish <app-name>`.
6. Trigger a first sync with `POST /api/sync` (admin key) rather than waiting
   for the timer.
7. Get the function key from the portal (Function App → App keys) and use it
   as the Power BI credential.

`SYNC_SCHEDULE` must be set — the timer trigger reads it by name, so the
Function App won't start without it.

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

- **Synced files aren't served over HTTP yet.** The sync writes them; the
  endpoints Power BI would read them from are the next milestone.
- **First sync of a very large survey can hit the Function timeout.** It's a
  full pull, and Consumption plans cap at 10 minutes. Later syncs are
  incremental and much faster. Narrowing `SYNC_SURVEY_IDS` works around it.
- **Data is as fresh as the last sync.** A six-hour schedule means data up to
  six hours old. Tighten `SYNC_SCHEDULE` or call `POST /api/sync`.
- **One survey per request.** Cross-survey dashboards need one query per
  survey, unioned in Power Query.
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
