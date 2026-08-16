# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT license, making the project open source.
- Contributor documentation: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md` (including a threat model for self-hosted deployments).
- GitHub issue and pull request templates.
- Continuous integration running the test suite on Node.js 18 and 20.
- `docs/architecture.md` describing the system design and the reasoning
  behind it.
- `docs/ROADMAP.md` setting out the path to a general-purpose connector:
  storage-backed sync, a star-schema output, a setup wizard, and one-click
  deployment.

### Changed

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
