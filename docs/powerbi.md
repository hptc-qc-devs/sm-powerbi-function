# Connecting Power BI

How to point Power BI at synced survey data, build the model, and get
scheduled refresh working.

## Before you start

You need:

- A deployed Function App with at least one completed sync. Check with
  `GET /api/surveys/{surveyId}/status` — it reports the last sync time and row
  counts per table.
- A **function key** from the Azure portal (Function App → App keys → default).
  This is the credential Power BI uses. It's a key for *this service*, not a
  SurveyMonkey credential.
- Your **survey ID**, from `GET /api/surveys`.

## The quick way: one table

If you don't want to model anything, load `flat` — one row per answer with
everything joined in.

Power BI Desktop → **Get Data** → **Web** → **Advanced**:

- URL parts: `https://YOUR-APP.azurewebsites.net/api/surveys/YOUR-SURVEY-ID/data/flat`
- HTTP request header parameters: `x-functions-key` = your function key

That works, and it's enough for simple counts and breakdowns. The five-table
model below is better for anything involving averages or filtering across
questions.

## The better way: the full model

Load all five tables at once with a single Power Query script. In Power BI
Desktop, **Get Data → Blank query → Advanced Editor**, and paste this after
filling in the three values at the top:

```m
let
    BaseUrl     = "https://YOUR-APP.azurewebsites.net",
    SurveyId    = "YOUR-SURVEY-ID",
    FunctionKey = "YOUR-FUNCTION-KEY",

    GetTable = (tableName as text) as table =>
        let
            Response = Web.Contents(
                BaseUrl,
                [
                    RelativePath = "api/surveys/" & SurveyId & "/data/" & tableName,
                    Headers      = [#"x-functions-key" = FunctionKey]
                ]
            ),
            Parsed = Csv.Document(
                Response,
                [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]
            ),
            Promoted = Table.PromoteHeaders(Parsed, [PromoteAllScalars = true])
        in
            Promoted
in
    GetTable
```

Name that query `GetSurveyTable`. Then create one query per table — each is a
one-liner:

```m
= GetSurveyTable("answers")
```

…and the same for `surveys`, `questions`, `choices` and `responses`.

> **Use `RelativePath`, don't build the full URL by string concatenation.**
> Power BI's service refuses to refresh data sources whose URL is computed at
> runtime ("dynamic data sources"). Passing the base URL to `Web.Contents` and
> putting the rest in `RelativePath` is what keeps scheduled refresh working.
> This is the single most common reason a report refreshes fine on the desktop
> and then fails in the service.

### Set the relationships

In **Model** view, create these (all one-to-many, single direction, filtering
from the dimension into `answers`):

| From | To |
|---|---|
| `questions[question_id]` | `answers[question_id]` |
| `responses[response_id]` | `answers[response_id]` |
| `choices[choice_id]` | `answers[choice_id]` |
| `surveys[survey_id]` | `responses[survey_id]` |

`answers` is your fact table; everything else filters it.

### Check the column types

Power BI usually infers these correctly from the CSV, but confirm:

- `answers[value_numeric]` → **Decimal Number**
- `answers[is_skipped]`, `questions[is_required]`, `choices[is_na]` → **True/False**
- `responses[date_created]`, `responses[date_modified]` → **Date/Time**
- `choices[weight]` → **Decimal Number**

If `value_numeric` comes in as text, averages won't work — that's the one to
check first when a measure misbehaves.

## Useful measures

Because `value_numeric` carries the actual rating score, these are one-liners:

```dax
Average Rating = AVERAGE(answers[value_numeric])

Response Count = DISTINCTCOUNT(answers[response_id])

Answered Rate =
DIVIDE(
    CALCULATE(COUNTROWS(answers), answers[is_skipped] = FALSE),
    COUNTROWS(answers)
)
```

Exclude "Not applicable" options from averages by filtering on the `choices`
table's `is_na` flag rather than trying to spot them by label text:

```dax
Average Rating (excl. N/A) =
CALCULATE(
    AVERAGE(answers[value_numeric]),
    FILTER(choices, choices[is_na] = FALSE)
)
```

## Scheduled refresh in the Power BI Service

1. Publish the report to a workspace.
2. Go to the dataset → **Settings** → **Data source credentials**.
3. Set the authentication method to **Anonymous**. The function key travels in
   the header, so there's no separate credential for Power BI to hold.
4. Under **Scheduled refresh**, set your cadence.

Refresh frequency here costs you nothing on the SurveyMonkey side — Power BI
reads synced files, and SurveyMonkey is only contacted on the connector's own
sync schedule. There's no reason to be shy about refreshing often; just don't
expect data newer than the last sync.

To line them up, set `SYNC_SCHEDULE` a little ahead of your Power BI refresh
time so each refresh picks up a fresh sync.

## Trend and historical reporting

SurveyMonkey only ever exposes current state, so year-over-year analysis needs
the snapshot layer. Set `SYNC_HISTORY_ENABLED=true` and each sync freezes a
dated copy.

Load a specific snapshot by adding it to the path:

```m
RelativePath = "api/surveys/" & SurveyId & "/data/answers",
Query        = [snapshot = "2026-03-31"]
```

`GET /api/surveys/{surveyId}/status` lists which snapshot dates exist.

Snapshots each carry a `snapshot_date` column, so appending several gives you
a table you can trend across. Retention is controlled by
`SYNC_SNAPSHOT_RETENTION_DAYS` (default 90) — raise it before you start
relying on a long history, because pruned snapshots are gone.

## Troubleshooting

**404 with `"error": "not_synced"`** — the survey hasn't synced yet. Trigger
one with `POST /api/sync/{surveyId}` using the **admin** key (not the function
key), or wait for the timer.

**401 or 403 from the Function** — the function key is wrong, missing, or
being sent to the wrong header. It's `x-functions-key`.

**502 with `"error": "surveymonkey_token_invalid"`** — the stored SurveyMonkey
token was revoked. Re-authorize; this can't recover on its own because
SurveyMonkey doesn't issue refresh tokens.

**Refresh works in Desktop, fails in the Service** — almost always the dynamic
data source problem. Use `RelativePath` as shown above.

**Averages return blank or wrong numbers** — check `value_numeric` is a
numeric column, and that N/A options are excluded via `choices[is_na]`.

**Text answers look like `'=SUM(...)`** — that leading apostrophe is
deliberate. A cell starting with `=` executes as a formula when a CSV is
opened in Excel, so respondent-entered text is neutralized on export. Request
`?format=json` to get the original text.
