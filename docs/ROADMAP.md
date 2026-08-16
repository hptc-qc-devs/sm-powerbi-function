# Roadmap: From internal function to open-source SurveyMonkey → Power BI connector

## Vision

Anyone with a SurveyMonkey account and an Azure subscription should be able to:

1. Click a **Deploy to Azure** button.
2. Open a built-in **setup wizard** in their browser, paste their SurveyMonkey
   credentials (or walk through OAuth), and test the connection.
3. Pick surveys and a sync schedule; the tool keeps analytics-ready data
   **synced into Blob Storage** on that schedule.
4. Copy ready-made Power BI connection URLs (plus a Power Query snippet) from
   the wizard and get fast, reliable scheduled refreshes in Power BI.

No code editing, no manual Key Vault commands, no local tooling required.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Platform | **Azure Functions only**, polished with one-click deploy | Keeps the proven runtime; targets users already in the Microsoft/Power BI ecosystem |
| Data layer | **Blob-primary**: timer-triggered incremental sync writes Blob Storage; Power BI reads from blob. Live pass-through kept only as a fallback mode | Decouples SM rate limits from PBI refresh frequency; kills the timeout risk; enables history; survives SM outages |
| Output schema | **Star schema + flat view**: five tidy tables as the standard, single flat table kept as "simple mode" | Proper Power BI modeling (relationships, typed numeric values) without abandoning casual users |
| History | **Optional snapshot toggle**, off by default, with retention setting | Trend/quarter-over-quarter analysis for those who want it, no storage growth for those who don't |
| UI | **Setup wizard** (guided flow, not a full admin dashboard) | Covers the whole connect-SM-to-Power-BI journey without becoming a big app |
| SurveyMonkey auth | **Token paste first, guided OAuth second** | Token paste works today and is simplest; OAuth added for users who prefer it |
| License | **MIT** | Maximum adoption, standard for this kind of glue tool |

## Architecture

```
SurveyMonkey API
      │  timer-triggered sync (incremental via start_modified_at),
      │  plus on-demand "Sync now" from the wizard
      ▼
Blob Storage  ← the canonical data layer (CSV files, star schema + flat view)
      │  fast static reads, function-key auth
      ▼
HTTP endpoints ──▶ Power BI (Web connector, scheduled refresh)
```

Why blob-primary: a pure pass-through re-pulls everything from SurveyMonkey
inside every Power BI refresh, which (a) burns SM's daily rate limit
(~100 paginated calls per 10k-response survey per refresh), (b) races the
function and PBI connector timeouts on big surveys, (c) can never serve
history because SM only has current state, and (d) fails whenever SM is down.
Syncing to blob on our own schedule fixes all four; Power BI refreshes become
static file reads that take seconds.

## Standardized output schema

Five tables per survey, each written as CSV to blob and served by an endpoint.
This is the shape the tool advertises:

| Table | Grain | Key columns |
|---|---|---|
| `surveys` | 1 row per survey | survey_id, title, language, response_count, date_created, date_modified |
| `questions` | 1 row per question | question_id, survey_id, page_id, position, heading, family, subtype |
| `choices` | 1 row per choice or matrix row | choice_id, question_id, text, position, weight (numeric score) |
| `responses` | 1 row per response | response_id, survey_id, response_status, collector_id, date_created, date_modified, time_spent, language |
| `answers` (fact) | 1 row per answer | response_id, question_id, choice_id, row_id, row_text, value_text, value_numeric, other_text |

Schema rules:

- **Open-ended text**: verbatim lands in `value_text` (choice_id null). The
  `questions.family/subtype` columns let Power BI separate verbatim tables
  from chartable questions. Numerical-textbox answers are additionally parsed
  into `value_numeric`.
- **"Other (please specify)"**: the row keeps its `choice_id` (so choice
  distributions stay correct) AND carries the typed text in `other_text` —
  the text no longer overwrites the choice.
- **Ratings/weighted choices**: `choices.weight` and `answers.value_numeric`
  carry the numeric score so averages/NPS aggregate natively in DAX.
- **Matrix questions**: `row_id`/`row_text` are real columns, not string
  concatenation. Multi-textbox questions use the same mechanism.
- **Skipped questions** keep the existing null-row convention (one row,
  value_* null) so skips remain visible and countable.
- **Question added after a response was collected** emits nothing for that
  response (unchanged — there is nothing true to say).

The current single flat table (one row per response × question × answer)
remains available as `flat.csv` / a `?view=flat` option — "simple mode" for
users who don't want to model. It gets the same typing fixes (value_numeric,
separated row/other text).

## Blob layout

```
data/
  {survey_id}/
    latest/                 surveys.csv, questions.csv, choices.csv,
                            responses.csv, answers.csv, flat.csv
    snapshots/{YYYY-MM-DD}/ same files, frozen (only when history toggle is on)
    state.json              last-sync watermark, row counts, sync log tail
```

`latest/` is what the endpoints serve. Snapshots are governed by the history
toggle + retention setting from the wizard. Sync is incremental after the
first full pull: `responses/bulk?start_modified_at={watermark}` fetches only
changed responses, merged into the stored dataset.

## Current state (what already exists and gets reused)

- `src/lib/flatten.js` — pure flattening transform, 7 passing tests. Becomes
  the basis of the star-schema builder (M2); flat view keeps using it.
- `src/lib/surveyMonkeyClient.js` — SM v3 wrapper with pagination and typed
  401/403 errors. Gains nothing but reuse; `start_modified_at` support
  already exists via `modifiedSince`.
- `src/lib/secretsClient.js` — swappable secret backend; `setSecret` already
  exists and becomes the wizard's storage path.
- `src/lib/surveyDetailsCache.js`, `src/lib/logger.js` — unchanged (PHI-safe
  allowlist logging is a selling point, keep it).
- `src/functions/` — `health`, `listSurveys`, `getFlattenedResponses`.
  `getFlattenedResponses` becomes the "live fallback mode" path.
- `scripts/setupOAuth.js` — manual CLI fallback; the wizard supersedes it.

## Milestones

### M1 — Open-source project hygiene
- `LICENSE` (MIT), README rewrite for a general audience, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates.
- CI: GitHub Actions running `npm test` on Node 18 and 20.
- `CHANGELOG.md`; move `handleSurveyMonkeyError` into `src/lib/`; create the
  `docs/architecture.md` the README references.

### M2 — Data layer: schema builder + sync engine (the core)
- `src/lib/schema.js`: pure star-schema builder (survey details + responses →
  the five tables), including the typing rules above. Unit-tested with
  fixtures, same style as `flatten.test.js`. Extend fixtures to cover
  open-ended, other-specify, matrix, numerical-textbox, and weighted-rating
  cases.
- `src/lib/csv.js`: CSV serialization (proper quoting/escaping, UTF-8 BOM so
  Excel/Power BI detect encoding).
- `src/lib/blobStore.js`: thin wrapper over `@azure/storage-blob` using the
  Function App's managed identity (no connection strings). Handles
  `latest/`, `snapshots/`, `state.json` read/write.
- `src/lib/syncEngine.js`: orchestrates a sync — read watermark, incremental
  pull, merge with stored responses, rebuild tables, write `latest/`,
  optionally freeze a snapshot, update `state.json`, enforce retention.
- `src/functions/syncTimer.js`: timer trigger, schedule from app settings
  (wizard-configurable). `src/functions/syncNow.js`: admin-key HTTP trigger.

### M3 — Serving endpoints (what Power BI calls)
- `GET /api/surveys/{id}/data/{table}` — serve `latest/{table}.csv` from blob
  (`table` ∈ surveys|questions|choices|responses|answers|flat), with
  `?format=json` option. Function-key auth, streamed, fast.
- `GET /api/surveys/{id}/snapshots` + snapshot retrieval for trend users.
- Live fallback mode: existing `getFlattenedResponses` path retained and
  documented for tiny surveys / no-storage setups.

### M4 — Setup/config API (the wizard's backend)
All `authLevel: 'admin'` (master key — only the deployer configures):
- `GET  /api/setup/status` — token stored? valid? last sync per survey?
- `POST /api/setup/token` — validate pasted token against SM, store via
  `setSecret()`.
- `POST /api/setup/oauth/start` + `GET /api/setup/oauth/callback` —
  guided OAuth (state-parameter CSRF protection; client secret to Key Vault).
- `GET  /api/setup/surveys` — survey browser (reuses `listSurveys`).
- `POST /api/setup/sync-config` — which surveys to sync, schedule, history
  toggle, retention.
- `GET  /api/setup/connection-info?surveyId=` — endpoint URLs + generated
  Power Query (M) snippet that loads all five tables (or flat) into Power BI.

### M5 — Setup wizard UI
- Plain HTML/CSS/JS in `public/`, no build step, served by a catch-all
  admin-key function.
- Steps: 1) Welcome/prereqs (SM Developer App how-to, scopes) →
  2) Credentials (token tab | OAuth tab, inline 401/403 explanations) →
  3) Pick surveys + sync schedule + history toggle, run first sync with live
  progress → 4) Connect Power BI (copy URLs, copy M snippet, walkthrough).

### M6 — One-click deploy (infrastructure as code)
- `infra/main.bicep`: Function App (Consumption, Node 20, system-assigned
  identity), Storage account (+ `data` container; identity granted Blob Data
  Contributor), Key Vault (identity granted secrets get/list/set), App
  Insights, app settings wired. Compiled `azuredeploy.json` for the
  Deploy-to-Azure button. `WEBSITE_RUN_FROM_PACKAGE` pointed at the release
  zip so the button alone yields a running app.
- `docs/deploy.md`: button path + manual `az` CLI path.

### M7 — Power BI experience polish
- `docs/powerbi.md`: full walkthrough — Desktop, Service, scheduled refresh,
  credential handling, building the five-table model, using snapshots for
  trend reports.
- Power Query template file (.pq/.pbit consideration) that builds the whole
  model from one base URL + key.

### M8 — Release
- CI release workflow: test → package zip → GitHub Release (the artifact M6's
  button deploys). Tag v1.0.0, changelog, README badges.

## Security notes (carried through every milestone)

- Setup/wizard endpoints require the Function App **master key**; data
  endpoints keep `authLevel: 'function'`.
- Credentials flow browser → HTTPS → Key Vault via `setSecret()`; never
  logged (existing allowlist logger), never echoed back, never in
  client-side storage.
- Blob access via managed identity only — no connection strings or SAS
  tokens in config.
- OAuth callback validates `state`; client secret lives in Key Vault.
- Survey answer data lives only in the user's own storage account.

## Suggested repo rename

`sm-powerbi-function` → something discoverable, e.g.
`surveymonkey-powerbi-connector`. Decide before v1.0.0 while inbound links
are few.

## Sequencing

M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8. The schema builder and sync engine
(M2) are the heart of the product and are fully unit-testable locally with
fixtures (Azurite for blob integration tests). The wizard (M4–M5) builds on
them; the deploy button (M6) comes once there's something worth deploying.
