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
        timer (SYNC_SCHEDULE, default every 6h)
                 |
                 v
        Azure Function App (Node.js 18/20)
                 |
                 +--> Key Vault  (Managed Identity; reads the SurveyMonkey token)
                 |
                 +--> SurveyMonkey API v3
                 |        1. GET /surveys/{id}/details        question & choice text
                 |        2. GET /surveys/{id}/responses/bulk  answers (paginated,
                 |                                             incremental)
                 v
        build star schema -> CSV -> Blob Storage
                 |
                 v  HTTPS + function key
        Power BI (Desktop / Service, scheduled refresh)
```

Everything runs in the deployer's own Azure subscription. There is no hosted
component, so survey data and credentials never pass through infrastructure
the maintainers control.

**Power BI never talks to SurveyMonkey.** That indirection is the point of the
design, and it's covered under "Why storage sits in the middle" below.

There is also a **direct mode** (`GET /api/surveys/{id}/flattened-responses`)
that pulls and flattens inside the request with nothing stored. It's useful
for small surveys and for validating a token quickly, and it carries the
rate-limit and timeout constraints that the synced path exists to remove.

## Module layout

```
src/
  functions/                   Entry points (thin: parse, call, respond)
    health.js                  GET /api/health
    listSurveys.js             GET /api/surveys
    getFlattenedResponses.js   GET .../flattened-responses (direct mode)
    syncTimer.js               Scheduled sync
    syncNow.js                 POST /api/sync[/{surveyId}] (admin key)
  lib/                         All the actual logic
    schema.js                  Pure transform: nested JSON -> star schema
    flatten.js                 Pure transform: nested JSON -> flat rows
    csv.js                     Table rows -> CSV
    syncEngine.js              Orchestrates a sync (pull, merge, build, write)
    blobStore.js               Blob layout and access
    surveyMonkeyClient.js      SurveyMonkey API wrapper, pagination, typed errors
    surveyDetailsCache.js      Per-survey question/choice lookups, cached
    secretsClient.js           Secret storage behind a swappable backend
    apiErrors.js               Upstream errors -> HTTP responses
    logger.js                  Structured logging with a content allowlist
scripts/
  setupOAuth.js                Local-only: obtain and/or store a token
test/
  schema.test.js               Star-schema transform
  csv.test.js                  Serialization and escaping
  syncEngine.test.js           Sync orchestration, against in-memory fakes
  flatten.test.js              Legacy flat transform
  fixtures/                    Synthetic survey details + responses
```

The rule the layout encodes: **functions are thin, lib holds the logic.**
Anything worth testing lives in `lib/` and takes plain data as input, so the
test suite never needs Azure, network access, or the Functions runtime.

## Why storage sits in the middle

Serving Power BI directly from the SurveyMonkey API looks simpler, and it
fails in four ways that all have the same fix.

1. **Rate limits.** SurveyMonkey caps API requests per day. A survey with
   10,000 responses is roughly 100 paginated calls. Multiply by a few surveys
   and an eight-times-daily refresh schedule and the quota is gone by
   mid-morning — after which the connector looks broken.
2. **Timeouts.** A synchronous pull has to finish inside both the Function
   timeout and Power BI's patience. Large surveys fail unpredictably, which
   is worse than failing consistently.
3. **No history.** SurveyMonkey exposes only current state. Without stored
   snapshots, "this quarter versus last" has no data to work from, ever.
4. **Upstream outages.** If SurveyMonkey is down when a refresh fires, the
   report is empty.

Syncing on a schedule fixes all four at once. SurveyMonkey is contacted on
*our* cadence regardless of how often Power BI refreshes; refreshes become
static file reads measured in seconds; snapshots accumulate history; and a
SurveyMonkey outage leaves the last good sync serving.

### Incremental pulls, full rebuilds

After the first sync, only responses modified since the stored watermark are
fetched. They're merged into the retained raw set keyed on response id, so an
edited response replaces its earlier version rather than appearing twice.

The tables are then rebuilt **from the entire merged set**, not patched
row-by-row. Patching would be faster and is the usual design; it's also how
these pipelines rot, because every edge case that doesn't apply a delta
correctly leaves permanent drift that nobody notices until the numbers are
questioned months later. Rebuilding guarantees the output of an incremental
sync is byte-identical to a full one.

Two conditions force a full pull rather than an incremental one: an explicit
request (`?full=true`), and a missing raw base. The second matters — if the
raw blob is lost but `state.json` survives, an incremental pull would fetch
only recent responses and quietly write a dataset missing everything older.

### What gets stored

```
{surveyId}/latest/{table}.csv       what the data endpoints serve
{surveyId}/raw/responses.json       merged raw responses (the incremental base)
{surveyId}/snapshots/{date}/...     frozen copies, when history is enabled
{surveyId}/state.json               watermark, row counts, last sync result
```

Respondent identifiers — IP address, email, name — are stripped before
anything is written. The tables never expose them, so retaining them in the
raw base would mean holding personal data the connector has no use for.
Language is kept, because it's genuinely analytical.

Snapshots are off by default. Turning them on freezes a dated copy each sync
and prunes past the retention window. Retention is enforced in code rather
than by a storage lifecycle policy so it behaves identically however the
storage account was provisioned.

## Why a star schema

The original output was one wide table: a row per response × question ×
answer, every value a string. It works, and it has two flaws that matter for
analytics.

Everything being a string means a satisfaction rating arrives as the label
`"Good"` with the number 4 nowhere in the data, so averaging requires a
lookup table hand-built in Power Query. And a single denormalized table
repeats survey and question text on every row while forcing awkward DAX,
because Power BI's engine is built around relationships between dimension and
fact tables.

So `schema.js` emits five related tables:

| Table | Grain | Role |
|---|---|---|
| `surveys` | 1 per survey | dimension |
| `questions` | 1 per question | dimension |
| `choices` | 1 per choice / matrix row / "other" option | dimension |
| `responses` | 1 per response | dimension |
| `answers` | 1 per answer | **fact** |

The rules encoded in the transform, each of which was a bug in the flat shape:

- **`value_numeric` carries meaning, not just labels.** Choice weights and
  ranking positions become numbers, so ratings and NPS aggregate natively.
- **Numeric coercion is deliberately narrow.** Only questions SurveyMonkey
  marks as numerical get their text parsed. Guessing at every text field
  would turn postcodes and years into quantities.
- **Matrix rows get their own columns.** The flat shape concatenated them
  into `"Customer support: Good"`, which can't be grouped or filtered.
- **"Other (please specify)" keeps both halves.** Previously the typed text
  overwrote the choice, silently dropping "Other" from distribution counts.
  Now `choice_id` and `other_text` are separate columns.
- **`is_na` is flagged** so "Not applicable" can be excluded from averages
  rather than counting as zero.

A `flat` view is still produced for people who don't want to model anything,
but it's **derived from the star tables** rather than transformed separately,
so the two cannot disagree. It inherits the typed columns.

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

- **The first sync of a very large survey can outrun the Function timeout.**
  It's a full pull, and Consumption plans cap at 10 minutes. Subsequent syncs
  are incremental and far quicker. Narrowing `SYNC_SURVEY_IDS` and letting the
  timer work through surveys separately is the workaround.
- **Sync latency.** Power BI sees data as fresh as the last sync, so a
  six-hour schedule means data up to six hours old. Tighten the schedule or
  trigger `POST /api/sync` on demand.
- **One survey per request.** Cross-survey dashboards need one query per
  survey, unioned in Power Query. A multi-survey endpoint is on the roadmap.
- **No automated token refresh**, because SurveyMonkey doesn't offer it.
- **Direct mode keeps its original constraints** — rate limits, timeouts, no
  history — by definition, since nothing is stored. It exists for small
  surveys and quick validation.

See [`ROADMAP.md`](ROADMAP.md) for what's planned next.
