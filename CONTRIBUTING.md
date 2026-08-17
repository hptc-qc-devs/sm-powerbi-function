# Contributing

Thanks for considering a contribution. This project exists to save teams from
rebuilding the same SurveyMonkey → Power BI plumbing, so improvements that
make it work for more people are exactly what it needs.

## Ways to help

- **Report a bug.** Especially valuable: SurveyMonkey question types that
  don't flatten correctly. Include the question type and a *redacted* sample
  of the response JSON.
- **Improve the docs.** If setup tripped you up, that's a documentation bug.
- **Pick up a roadmap item.** [`docs/ROADMAP.md`](docs/ROADMAP.md) lists the
  planned milestones. Comment on the related issue before starting something
  large so we don't duplicate work.

## Getting set up

```bash
git clone https://github.com/hptc-qc-devs/surveymonkey-powerbi-connector.git
cd surveymonkey-powerbi-connector
npm install
npm test
```

The tests need no Azure resources and no network access, so they run
immediately after clone. You only need a Key Vault and a SurveyMonkey token
when running the Function itself against real data (see the README quickstart).

## Making a change

1. Branch off `master`.
2. Make your change, with tests.
3. Run `npm test` — it must pass.
4. Open a pull request describing what changed and why.

### Commit messages

Write a short imperative subject line ("Add matrix question handling"), then a
body explaining *why* if it isn't obvious from the diff.

## Code conventions

This codebase has a few deliberate patterns. Please follow them:

- **Keep transformation logic pure.** Everything in `src/lib/flatten.js` is a
  pure function: no network calls, no logging, no Azure SDK. That's what makes
  it cheaply testable with fixtures. New transformation logic belongs in the
  same style.
- **Never log survey content.** `src/lib/logger.js` enforces an allowlist —
  only IDs, counts, timings, and status codes get through, and anything else
  is redacted. If you need a new metadata field in logs, add it to
  `ALLOWED_META_KEYS` deliberately, and only if it cannot contain
  respondent-entered text or question wording.
- **Secrets go through `src/lib/secretsClient.js`.** Don't reach for the Key
  Vault SDK directly elsewhere; the abstraction exists so the storage backend
  can be swapped.
- **Map upstream errors in one place.** `src/lib/apiErrors.js` translates
  SurveyMonkey failures into HTTP responses so every endpoint tells the same
  story. Extend it rather than handling status codes inline.
- **Match the surrounding style.** 2-space indent, semicolons, single quotes,
  CommonJS `require`. No linter is enforced yet; consistency with neighbouring
  code is the standard.

## Testing

Tests use Node's built-in test runner (`node --test`) — no framework
dependency. Add fixtures under `test/fixtures/` and keep them small,
synthetic, and free of any real respondent data.

Contributions that fix a transformation bug should include a fixture that
fails before the fix and passes after.

### Unit tests

```bash
npm test
```

These run offline against fixtures — no Azure resources, no network. The
transformation and sync-orchestration logic is covered here, with the storage
layer substituted by in-memory fakes.

### Integration tests

The storage layer is also tested against a real Azure Storage API using
[Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite),
which is installed as a dev dependency. In one terminal:

```bash
npm run azurite
```

and in another:

```bash
npm run test:integration
```

These verify what the in-memory fakes cannot: container creation, not-found
handling, listing, prefix deletion, and a complete sync writing real blobs.
Without `STORAGE_CONNECTION_STRING` set they skip automatically, which is why
plain `npm test` stays offline.

`npm audit` reports advisories in Azurite's transitive dependencies. Azurite
is a local test emulator and is never deployed; `npm audit --omit=dev` (what
matters for a deployment) is clean.

### Azure Functions Core Tools

Core Tools is **not** a project dependency — install it
[globally](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
as the README's prerequisites describe. It's a large platform-specific binary,
it's already a documented prerequisite, and pinning it in `package.json` made
`npm install` fail on any machine that couldn't reach the Microsoft CDN. You
only need it to run the Function itself (`npm start`), not to run the tests.

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

Participation is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
