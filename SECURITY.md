# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**. Do not open a public
GitHub issue.

Use GitHub's private reporting: go to the repository's **Security** tab →
**Report a vulnerability**. This creates a private advisory visible only to
maintainers.

Please include:

- What the vulnerability allows an attacker to do
- Steps to reproduce, or a proof of concept
- The version or commit you tested against

You can expect an initial acknowledgement within a few days. We'll keep you
updated as we work on a fix, and we'll credit you in the advisory unless you'd
rather stay anonymous.

Please give us a reasonable window to release a fix before disclosing
publicly.

## Supported versions

This project is in early development and has not reached 1.0 yet. Only the
latest commit on `master` receives security fixes.

## Threat model

Understanding what this software is responsible for will help you judge
whether something is a vulnerability.

**You deploy and own the infrastructure.** This is self-hosted. The Function
runs in your Azure subscription, reads from your Key Vault, and returns data
to your Power BI tenant. There is no hosted service and no maintainer-operated
component that ever sees your data or credentials.

**What the software is responsible for:**

- Never writing survey content or credentials to logs. `src/lib/logger.js`
  enforces an allowlist of metadata keys; everything else is redacted. A path
  that leaks question text, answer values, or token material into logs or
  Application Insights **is a vulnerability** — please report it.
- Never returning credentials in an HTTP response. Endpoints return survey
  data only. A response that echoes a token or client secret **is a
  vulnerability**.
- Reading secrets only through `src/lib/secretsClient.js`, which uses Managed
  Identity in Azure. Hardcoded credentials or a path that reads secrets from
  an untrusted source **is a vulnerability**.
- Respecting the configured authorization level on every endpoint. Data
  endpoints require a function key; setup and sync endpoints require the admin
  key. An endpoint that exposes survey data anonymously **is a vulnerability**.
- Never returning a stored credential. The setup API validates and stores
  tokens and OAuth client secrets, and no endpoint echoes any of them back —
  not in a success response, not in an error, not in a generated Power Query
  snippet.

**What is your responsibility as the deployer:**

- Protecting your Function keys. Anyone holding a key can read the survey data
  the endpoints serve. Treat keys like passwords, pass them as headers rather
  than URL query strings where possible, and rotate them if exposed.
- Key Vault access policies and Managed Identity role assignments.
- Restricting network access to your Function App if your survey data is
  sensitive.
- The scopes you grant your SurveyMonkey Developer App. Grant read-only
  scopes (`surveys_read`, `responses_read`); this software never needs write
  access.
- Keeping your deployment updated.

**The one anonymous endpoint, and why:**

`GET /api/setup/oauth/callback` is the only endpoint that does not require a
key. It has to be: SurveyMonkey redirects the user's browser to it after they
approve access, and a redirect cannot carry a function key. Azure's own key
parameter is `code`, which collides with the OAuth authorization code, so that
route is closed too.

What protects it instead is the `state` parameter, which is:

- 256 bits of randomness, generated per flow
- stored server-side and compared with a timing-safe comparison
- single-use — redeeming it deletes it, so a captured callback URL cannot be
  replayed
- valid for ten minutes

A request without matching state does nothing at all: no code exchange, no
secret read, no token write. Every failure returns the same message, so the
endpoint does not reveal whether a flow is in progress. All other setup
endpoints require the **admin (master) key**.

If you find a way to make that endpoint act without valid state, that **is a
vulnerability** — please report it.

**Known non-issues:**

- The `local-override` secrets backend (`SECRETS_BACKEND=local-override`)
  reads a token from an environment variable. This is a documented local
  development escape hatch that logs a loud warning. It is not intended for,
  and should never be enabled in, a deployed environment.
- SurveyMonkey access tokens are long-lived and cannot be silently refreshed,
  because SurveyMonkey does not issue refresh tokens. Manual re-authorization
  after revocation is a constraint of the upstream API, not a flaw here.
