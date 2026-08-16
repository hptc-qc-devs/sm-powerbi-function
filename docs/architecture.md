# Architecture

How the connector is put together, and why. For where it's heading, see
[`ROADMAP.md`](ROADMAP.md).

## The problem

Power BI has no native SurveyMonkey connector, and SurveyMonkey's API doesn't
return anything Power BI can model directly. A single response comes back as a
tree — pages contain questions, questions contain answers, and answers
reference choice IDs whose text lives in a completely separate
`/surveys/{id}/details` payload. Power BI's Web connector can fetch JSON, but
unpicking that structure in Power Query is painful and every team ends up
writing the same brittle M code.

This project puts a small service in between that does the reshaping once, in
a place that's testable, and hands Power BI something flat.

## System shape

```
Power BI (Desktop / Service, scheduled refresh)
        |
        v  HTTPS + function key
Azure Function App (Node.js 18/20, Consumption plan)
        |
        +--> Key Vault      (Managed Identity; reads the SurveyMonkey token)
        |
        +--> SurveyMonkey API v3
                 1. GET /surveys/{id}/details   -> question & choice text
                 2. GET /surveys/{id}/responses/bulk -> the answers (paginated)
        |
        v
   flatten -> tabular rows -> JSON response
```

Everything runs in the deployer's own Azure subscription. There is no hosted
component, so survey data and credentials never pass through infrastructure
the maintainers control.

## Module layout

```
src/
  functions/                   HTTP entry points (thin: parse, call, respond)
    health.js                  GET /api/health
    listSurveys.js             GET /api/surveys
    getFlattenedResponses.js   GET /api/surveys/{surveyId}/flattened-responses
  lib/                         All the actual logic
    flatten.js                 Pure transform: nested JSON -> flat rows
    surveyMonkeyClient.js      SurveyMonkey API wrapper, pagination, typed errors
    surveyDetailsCache.js      Per-survey question/choice lookups, cached
    secretsClient.js           Secret storage behind a swappable backend
    apiErrors.js               Upstream errors -> HTTP responses
    logger.js                  Structured logging with a content allowlist
scripts/
  setupOAuth.js                Local-only: obtain and/or store a token
test/
  flatten.test.js              Fixture-driven unit tests
  fixtures/                    Synthetic survey details + responses
```

The rule the layout encodes: **functions are thin, lib holds the logic.**
Anything worth testing lives in `lib/` and takes plain data as input, so the
test suite never needs Azure, network access, or the Functions runtime.

## Key design decisions

### Flattening is a pure function

`src/lib/flatten.js` has no imports, no I/O, and no logging. Given a response
object, survey metadata, and lookup maps, it returns rows. That constraint is
deliberate: the transform is the part most likely to need changes as real
survey data reveals edge cases, so it's the part that has to be cheapest to
test. Every question-type bug can be reproduced by adding a fixture.

### The three states of a question

This is the subtlest part of the transform, and it's a data-integrity
decision rather than a technical one:

| Situation | What's emitted | Why |
|---|---|---|
| Question has answers | One row per answer | The straightforward case. Multi-select produces several rows. |
| Question present, `answers: []` | **One row** with `answer_value: null` | The respondent saw the question and skipped it. That's a real, meaningful observation — dropping the row would silently inflate completion rates. |
| Question absent from the response | **Nothing** | The question didn't exist when this response was collected (added to the survey later). There is nothing true to say about it, so inventing a null row would be a lie. |

Getting this wrong is easy and the resulting numbers look plausible, which is
why it's documented here and covered by tests.

### Unrecognized answer shapes degrade visibly

`resolveAnswerValue` handles matrix rows, choices, and free text explicitly,
then falls back to serializing the raw answer as JSON rather than dropping it.
SurveyMonkey adds question types over time; the failure mode should be an
obviously odd-looking value in a cell that someone reports as a bug, not data
that quietly disappears.

### Two caches, two different lifetimes

Both are module-scoped, so they live as long as a warm Function instance and
reset naturally on cold start. Neither is a durable store.

- **Survey details** (`surveyDetailsCache.js`, 4h default): question and
  choice text changes rarely, and every response page needs the same lookup
  maps. Fetching `/details` once per survey instead of once per request is
  the single biggest saving on SurveyMonkey API calls.
- **Secrets** (`secretsClient.js`, 10 min): short on purpose. Key Vault calls
  aren't free, but a rotated credential should take effect quickly. Ten
  minutes trades a little efficiency for a bounded rotation delay.

### Secrets go through one abstraction

Nothing outside `secretsClient.js` knows Key Vault exists — callers just ask
for `getSecret(name)`. Organizations that mandate a different secrets manager
only have to change that file. In Azure, `DefaultAzureCredential` resolves to
the Function App's system-assigned Managed Identity, so there is no credential
to store or rotate; locally the same code resolves to the developer's
`az login` session.

### Logging cannot leak survey content

`logger.js` uses an **allowlist**, not a denylist: only known-safe keys
(`surveyId`, `responseId`, `rowCount`, `durationMs`, status codes, and
similar) reach the log. Anything else is replaced with a redaction marker.

A denylist would be the obvious design and the wrong one — it fails open, so
one unexpected field name in a future code path leaks respondent text into
Application Insights forever. The allowlist fails closed: the worst case is a
missing diagnostic, and adding a key is a deliberate, reviewable act.

### Auth failures are triaged, not just proxied

`surveyMonkeyClient.js` throws typed errors (`SurveyMonkeyAuthError`,
`SurveyMonkeyScopeError`) and `apiErrors.js` maps them to responses. The
distinction matters because the fixes are completely different:

- **401** — the token was revoked. Only a human can fix it, by re-authorizing.
  There is no automated retry, because **SurveyMonkey does not issue refresh
  tokens**; a retry loop would just burn rate limit.
- **403** — the token is valid but the Developer App lacks a scope. A
  configuration fix in SurveyMonkey, not a credential problem.

Both surface to the caller as `502` — this service is healthy, the upstream
isn't — distinguished by the `error` code in the body so callers can tell the
two apart and act accordingly.

### Endpoints require a function key

All endpoints use `authLevel: 'function'`. The key is what Power BI presents
as its credential, and it should be passed as an `x-functions-key` header
rather than a query string where the tooling allows it. Note this is a key for
*this service*, not a SurveyMonkey credential — the SurveyMonkey token never
leaves Key Vault and the Function's memory.

## Known limitations

These are consequences of the current stateless design, and are what the
roadmap addresses:

- **Rate limits.** Every request re-pulls the full survey. A 10,000-response
  survey is roughly 100 paginated API calls, and SurveyMonkey caps daily
  request volume, so frequent Power BI refreshes across several surveys can
  exhaust the quota.
- **Timeouts.** The whole pull-and-flatten happens inside one HTTP request,
  which must finish within both the Function timeout and Power BI's patience.
  Large surveys are at risk.
- **No history.** SurveyMonkey exposes only current state, so trend analysis
  is impossible without storing snapshots.
- **Upstream availability.** If SurveyMonkey is down, a scheduled refresh
  fails and the report is empty.
- **One survey per request.** Cross-survey dashboards need one query per
  survey, unioned in Power Query.

The planned fix for the first four is the same: sync into Blob Storage on a
schedule and serve Power BI from storage. See [`ROADMAP.md`](ROADMAP.md).
