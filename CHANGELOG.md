# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-08-17

First public release. Everything below ships working end to end: one-click
deployment into your own Azure subscription, a browser setup wizard, scheduled
incremental sync from SurveyMonkey into Blob Storage, and a star-schema output
Power BI can model directly.

### Added

- **One-click deployment.** A Deploy to Azure button and
  [`infra/main.bicep`](infra/main.bicep) provision the Function App, storage
  account with its data container, Key Vault, Application Insights, and —
  the part that is easy to miss by hand — the two role assignments that let
  the app's managed identity actually write blobs and store secrets. Only a
  base name is required; everything else defaults.
  - `azuredeploy.json` is the compiled template the button deploys. CI
    recompiles the Bicep and fails if the committed file has drifted, since a
    stale template means the button silently installs old infrastructure.
  - [`docs/deploy.md`](docs/deploy.md) covers the button, the CLI route,
    deploying your own code, upgrading, teardown, and the failures that follow
    from a missing role assignment or app setting.

- **A setup wizard** at `GET /api/ui`, covering the whole journey in the
  browser: prerequisites, connecting SurveyMonkey by pasted token or guided
  OAuth, choosing surveys and sync options, running the first sync, and
  generating Power BI connection details.
  - Plain HTML, CSS and JavaScript with no build step or bundler, so it can be
    edited by cloning the repo and opening `public/`.
  - Follows the operating system's light or dark theme.
  - The admin key is read from the page's own URL and sent as a header; it is
    never written to storage, cookies, or any link, so it lives only as long
    as the tab.
  - Assets are served with `Cache-Control: no-store` and `nosniff`, and the
    path resolver refuses traversal by resolving and bounds-checking rather
    than pattern-matching the input.

- **A setup API** covering the whole configuration flow over HTTP, so a
  deployment can be configured without editing application settings by hand.
  Documented in [`docs/setup-api.md`](docs/setup-api.md).
  - `GET /api/setup/status` reports token, storage and config state as
    independent checks and names the next step, because a missing token, a
    revoked token and unreachable storage need different fixes.
  - `POST /api/setup/token` validates a pasted token against SurveyMonkey
    before storing it, so a typo fails immediately rather than as a failed
    sync hours later. A rejected token is never written.
  - `POST /api/setup/oauth/start` and `GET /api/setup/oauth/callback`
    implement the guided OAuth flow. The callback is anonymous by necessity —
    SurveyMonkey redirects a browser to it — and is secured by a 256-bit,
    single-use, ten-minute `state` compared in constant time.
  - `GET /api/setup/surveys` lists surveys annotated with selection and sync
    state.
  - `GET`/`POST /api/setup/sync-config` reads and writes sync configuration.
  - `GET /api/setup/connection-info` returns Power BI URLs and a generated
    Power Query script, with the base URL derived from the request.
- **Runtime-changeable configuration.** Sync settings now live in blob storage
  layered over application settings, since a Function cannot rewrite its own
  app settings. `SYNC_SCHEDULE` is the exception — it binds at host startup,
  so saving it returns `pending_app_settings` rather than implying it applied.

- **Data endpoints that serve the synced tables to Power BI**, completing the
  pipeline. `GET /api/surveys/{surveyId}/data/{table}` returns a synced table
  without calling SurveyMonkey at all, so Power BI refresh frequency no longer
  affects API usage.
  - `?format=json` returns typed rows — numbers and booleans come back as
    numbers and booleans, driven by declared column types rather than guessed
    from values.
  - `?snapshot=YYYY-MM-DD` serves a frozen snapshot for trend reporting.
  - A 404 distinguishes "never synced" from "wrong table name" and says what
    to do about it.
- `GET /api/surveys/{surveyId}/status` reporting last sync time, mode, row
  counts per table, and which snapshots exist.
- A CSV parser (`fromCsv`) completing the round trip, including undoing the
  export-time formula guard so JSON consumers see the original text.
- [`docs/powerbi.md`](docs/powerbi.md): a full Power BI walkthrough — a
  copy-paste Power Query script that loads all five tables, the relationships
  to create, DAX measures that use `value_numeric`, how to make scheduled
  refresh work in the Power BI Service, and troubleshooting.

- **Storage-backed sync.** A timer-triggered job pulls from SurveyMonkey on
  its own schedule and writes analytics-ready tables to Blob Storage, so
  Power BI refreshes read static files instead of re-pulling from
  SurveyMonkey. This removes the rate-limit and timeout ceilings that applied
  when every refresh hit the API directly.
  - Incremental after the first run: only responses modified since the stored
    watermark are fetched, merged by response id, and the tables rebuilt from
    the merged whole so no drift accumulates.
  - `POST /api/sync` and `POST /api/sync/{surveyId}` trigger a sync on demand
    (admin key; `?full=true` forces a complete re-pull).
  - Optional dated snapshots with automatic retention pruning, which is what
    makes quarter-over-quarter and year-over-year analysis possible.
  - Respondent identifiers are stripped before anything is persisted.
- **Star-schema output** (`src/lib/schema.js`): five related tables —
  `surveys`, `questions`, `choices`, `responses`, `answers` — that Power BI
  can model directly.
  - Rating and weighted-choice answers carry a numeric `value_numeric`, so
    averages and NPS aggregate in DAX without Power Query surgery.
  - Matrix answers expose `row_id`/`row_text` as real columns instead of
    concatenating them into `"Row: Choice"`.
  - "Other (please specify)" keeps both the choice it belongs to and the
    typed text, so choice distributions stay correct.
  - Numerical-textbox answers are parsed to numbers; text in other question
    types is never coerced.
  - HTML markup in question headings is stripped.
  - An improved single-table `flat` view is derived from the same tables, so
    simple mode and star schema cannot disagree.
- **CSV serialization** (`src/lib/csv.js`) with RFC 4180 quoting, UTF-8 BOM,
  and neutralization of spreadsheet formula injection in respondent-entered
  text.
- Integration tests covering the storage layer and a complete sync against a
  real Azure Storage API via Azurite. They skip unless
  `STORAGE_CONNECTION_STRING` is set, so `npm test` stays offline; CI runs
  both suites.
- MIT license, making the project open source.
- Contributor documentation: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md` (including a threat model for self-hosted deployments).
- GitHub issue and pull request templates.
- Continuous integration running the test suite on Node.js 20 and 22.
- `docs/architecture.md` describing the system design and the reasoning
  behind it.
- `docs/ROADMAP.md` setting out the path to a general-purpose connector:
  storage-backed sync, a star-schema output, a setup wizard, and one-click
  deployment.

### Changed

- **Supported Node.js versions are now 20 and 22**, up from 18 and 20. Node 18
  reached end-of-life in April 2025, and Homebrew disables its `node@20`
  formula in October 2026, so the old `<21.0.0` ceiling forced new
  contributors onto software they could no longer install. CI tests both.
- **`azure-functions-core-tools` is no longer a dev dependency.** It is a
  large platform-specific binary, it was already a documented prerequisite to
  install globally, and pinning it made `npm install` fail outright on any
  machine that could not reach the Microsoft CDN. Install it globally to run
  `npm start`; it is not needed for the tests.
- `getResponsesBulk` accepts a `status` option instead of hardcoding
  `completed`, so partial responses can be included via
  `SYNC_RESPONSE_STATUS`.
- Function timeout raised from 5 to 10 minutes, giving a first full sync of a
  large survey room to finish.
- Rewrote `README.md` for a general audience, replacing project-specific
  delivery language with setup instructions anyone can follow.
- Moved `handleSurveyMonkeyError` out of `src/functions/listSurveys.js` into
  `src/lib/apiErrors.js`, so endpoints no longer import shared logic from
  another endpoint module.
- Generalized code comments and the OAuth setup script's prompts, which
  previously assumed a specific delivery context.

## [0.1.0]

Initial working build.

### Added

- `GET /api/health` — liveness check confirming Key Vault is reachable.
- `GET /api/surveys` — lists surveys visible to the configured token.
- `GET /api/surveys/{surveyId}/flattened-responses` — the Power BI data feed,
  returning one row per response × question × answer.
- Flattening transform resolving question and choice text, handling matrix
  questions, skipped questions, and unrecognized answer shapes.
- Per-survey question/choice lookup caching.
- Key Vault secret storage behind a swappable backend abstraction, using
  Managed Identity in Azure.
- Allowlist-based logging that cannot emit survey content.
- `scripts/setupOAuth.js` for storing a token or running the OAuth flow.
