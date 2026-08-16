# Roadmap: From internal function to open-source SurveyMonkey → Power BI connector

## Vision

Anyone with a SurveyMonkey account and an Azure subscription should be able to:

1. Click a **Deploy to Azure** button.
2. Open a built-in **setup wizard** in their browser, paste their SurveyMonkey
   credentials (or walk through OAuth), and test the connection.
3. Browse their surveys in the wizard and **copy ready-made Power BI
   connection URLs** (plus a Power Query snippet) for each one.
4. Point Power BI's Web connector at those URLs and get flat, analytics-ready
   rows on every scheduled refresh.

No code editing, no manual Key Vault commands, no local tooling required.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Platform | **Azure Functions only**, polished with one-click deploy | Keeps the proven runtime; targets users who already live in the Microsoft/Power BI ecosystem |
| UI | **Setup wizard** (guided flow, not a full admin dashboard) | Covers the entire connect-SM-to-Power-BI journey without becoming a big app |
| SurveyMonkey auth | **Token paste first, guided OAuth second** | Token paste works today and is simplest; OAuth flow added for users who prefer it |
| License | **MIT** | Maximum adoption, standard for this kind of glue tool |

## Current state (what already exists and gets reused)

- `src/lib/flatten.js` — pure flattening transform, 7 passing unit tests. Unchanged.
- `src/lib/surveyMonkeyClient.js` — SM v3 API wrapper with pagination and typed 401/403 errors. Unchanged.
- `src/lib/secretsClient.js` — swappable secret backend with `getSecret`/`setSecret`; `setSecret` already exists and becomes the wizard's storage path.
- `src/lib/surveyDetailsCache.js`, `src/lib/logger.js` — unchanged (PHI-safe logging is a selling point, keep it).
- `src/functions/` — `health`, `listSurveys`, `getFlattenedResponses` endpoints. Unchanged behavior; `listSurveys` gets reused by the wizard's survey browser.
- `scripts/setupOAuth.js` — the manual CLI path; stays as a fallback, the wizard supersedes it for most users.

## Milestones

### M1 — Open-source project hygiene
*Goal: the repo looks and behaves like a real open-source project.*

- `LICENSE` — MIT.
- `README.md` rewrite for a general audience: what it does, Deploy-to-Azure
  button, screenshots of the wizard (added in M4), quickstart. Internal
  SOW/phase references removed from README and code comments.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (how to report vulns).
- `.github/ISSUE_TEMPLATE/` (bug, feature) and `PULL_REQUEST_TEMPLATE.md`.
- CI: GitHub Actions workflow running `npm test` on Node 18 and 20.
- `CHANGELOG.md` (Keep a Changelog format).
- Housekeeping: move `handleSurveyMonkeyError` from
  `src/functions/listSurveys.js` into `src/lib/` (it's shared library code);
  create the `docs/architecture.md` the README already references.

### M2 — One-click deploy (infrastructure as code)
*Goal: "Deploy to Azure" button that provisions everything.*

- `infra/main.bicep`: Function App (Consumption, Node 20, system-assigned
  managed identity), Storage account, Key Vault (RBAC, identity granted
  Secrets User + Secrets Officer), Application Insights, all app settings
  (`KEY_VAULT_URI`, `SM_API_BASE_URL`, `SM_ACCESS_TOKEN_SECRET_NAME`,
  `SECRETS_BACKEND=keyvault`) wired automatically.
- `azuredeploy.json` compiled from the Bicep for the
  `https://portal.azure.com/#create/Microsoft.Template/uri/...` button.
- Code deployment via `WEBSITE_RUN_FROM_PACKAGE` pointing at the GitHub
  release zip (built by CI), so the button alone yields a running app.
- `docs/deploy.md`: button path + manual `az` CLI path for people who want
  control.

### M3 — Setup/config API (the wizard's backend)
*Goal: everything the wizard does has a server endpoint; credentials go to Key Vault, never to the browser again.*

New functions under `src/functions/setup/`, all `authLevel: 'admin'` (master
key only — the deployer is the only person who can configure):

- `GET  /api/setup/status` — is a token stored? does it work? (calls SM `/users/me`)
- `POST /api/setup/token` — validate a pasted access token against SM, then
  store via existing `setSecret()`.
- `POST /api/setup/oauth/start` — accept client ID/secret + redirect URI,
  store them, return the SurveyMonkey authorize URL.
- `GET  /api/setup/oauth/callback` — exchange code for token, store it,
  redirect back into the wizard. CSRF-protected with a `state` parameter.
- `GET  /api/setup/surveys` — thin reuse of `listSurveys` for the browser step.
- `GET  /api/setup/connection-info?surveyId=` — returns the flattened-responses
  URL and a generated Power Query (M) snippet for that survey.

Unit tests for the validation/state logic (no-network, same style as
`flatten.test.js`).

### M4 — Setup wizard UI
*Goal: the browser experience.*

- Plain HTML/CSS/JS single-page app in `public/` — **no build step**, keeping
  the repo `npm install && func start` simple for contributors.
- Served by a catch-all HTTP function (`GET /api/ui/{*path}`, plus root
  redirect), `authLevel: 'admin'` consistent with the setup API.
- Wizard steps:
  1. **Welcome / prerequisites** — link to creating a SurveyMonkey Developer
     App, with the exact scopes needed.
  2. **Credentials** — tabbed: *Paste access token* | *Connect with OAuth*.
     Inline validation, clear error messages for 401 (bad/revoked token) and
     403 (missing scopes).
  3. **Test & browse** — live connection check, then the user's survey list
     with titles and response counts.
  4. **Connect Power BI** — per survey: the ready-to-copy endpoint URL, a
     copy-paste Power Query (M) snippet using `Web.Contents` with the
     function key in a header, and step-by-step Power BI Desktop/Service
     instructions.

### M5 — Power BI experience polish
*Goal: reduce friction on the Power BI side.*

- `?format=csv` option on `flattened-responses` (Power BI handles CSV well and
  it's easier for non-technical users to sanity-check in a browser).
- `docs/powerbi.md`: full walkthrough — Desktop, Service, scheduled refresh,
  credential handling (function key as header, anonymous auth caveats).
- Multi-survey endpoint (`/api/flattened-responses?surveyIds=a,b,c`) for
  master dashboards — stretch, may slip to post-1.0.

### M6 — Release
*Goal: v1.0.0 on GitHub.*

- CI release workflow: test → package zip → GitHub Release (the artifact M2's
  button deploys).
- Version, tag, changelog entry.
- README badges (CI, license, release).

## Security notes (carried through every milestone)

- Setup/wizard endpoints require the Function App **master key** — only the
  deployer configures the tool. Data endpoints keep `authLevel: 'function'`.
- Credentials flow browser → HTTPS → Key Vault via `setSecret()`; never
  logged (existing allowlist logger), never returned by any endpoint,
  never in client-side storage.
- OAuth callback validates `state`; client secret is stored in Key Vault,
  not embedded in the UI.
- `SECURITY.md` documents the reporting process and the threat model.

## Suggested repo rename

`sm-powerbi-function` → something discoverable, e.g.
`surveymonkey-powerbi-connector`. Optional, decide before v1.0.0 while
inbound links are few.

## Sequencing

M1 → M3 → M4 → M2 → M5 → M6. The wizard (M3+M4) is the heart of the product
and can be built and tested locally before the deploy button (M2) exists;
hygiene (M1) is quick and makes every later PR look right.
