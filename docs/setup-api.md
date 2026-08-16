# Setup API

The endpoints the setup wizard is built on. They're documented separately
because you can drive the whole configuration flow with `curl` today, before
the wizard UI exists.

Every endpoint here requires the **admin (master) key**, not a function key —
this is configuration surface, not data. Get it from the Azure portal under
Function App → App keys → `_master`. Running locally, no key is needed.

```bash
BASE=https://your-app.azurewebsites.net
KEY=your-master-key
```

The one exception is the OAuth callback, which is anonymous by necessity —
see [`../SECURITY.md`](../SECURITY.md) for why, and what secures it instead.

## Where am I? — `GET /api/setup/status`

The first call to make. Reports each condition independently and names the
next step.

```bash
curl -H "x-functions-key: $KEY" "$BASE/api/setup/status"
```

```jsonc
{
  "ready": false,
  "checks": { "tokenStored": false, "tokenValid": false, "storageReachable": true },
  "account": null,
  "token_message": "No SurveyMonkey token stored yet.",
  "config": { "surveyIds": [], "historyEnabled": false, "retentionDays": 90, "source": "env" },
  "active_schedule": "0 0 */6 * * *",
  "surveys": [],
  "next_step": "store_token"
}
```

`next_step` is one of `fix_storage`, `store_token`, `reauthorize`, or
`choose_surveys`. The checks are separate because the fixes are different: a
missing token is a setup step, a rejected token is a re-authorization, and
unreachable storage is an infrastructure problem.

## Connecting SurveyMonkey

Two ways. Both end with a validated token in your secret store.

### Paste a token — `POST /api/setup/token`

Simplest, and works today. Create a private app at
[developer.surveymonkey.com](https://developer.surveymonkey.com/apps/), grant
it **View Surveys** and **View Responses**, and copy its access token.

```bash
curl -X POST -H "x-functions-key: $KEY" -H "Content-Type: application/json" \
  -d '{"token":"YOUR-SURVEYMONKEY-TOKEN"}' \
  "$BASE/api/setup/token"
```

The token is checked against SurveyMonkey *before* being stored, so a typo
fails here rather than surfacing hours later as a failed sync. A rejected
token is never written.

```jsonc
{ "stored": true, "account": { "username": "you@example.com" }, "next_step": "choose_surveys" }
```

### Guided OAuth — `POST /api/setup/oauth/start`

Use this if you'd rather not handle a raw token. You still need your own
SurveyMonkey Developer App; register its redirect URI as
`{BASE}/api/setup/oauth/callback` exactly.

```bash
curl -X POST -H "x-functions-key: $KEY" -H "Content-Type: application/json" \
  -d "{\"clientId\":\"...\",\"clientSecret\":\"...\",\"redirectUri\":\"$BASE/api/setup/oauth/callback\"}" \
  "$BASE/api/setup/oauth/start"
```

Returns an `authorize_url`. Open it, approve access, and SurveyMonkey redirects
back to the callback, which exchanges the code, validates the resulting token,
stores it, and shows a confirmation page. The link is good for ten minutes and
works once.

Your client secret goes to the secret store and is never returned.

## Choosing surveys — `GET /api/setup/surveys`

Every survey your token can see, annotated with whether it's selected for
syncing and how its last sync went.

```bash
curl -H "x-functions-key: $KEY" "$BASE/api/setup/surveys"
```

```jsonc
{
  "data": [
    { "id": "111", "title": "Patient Feedback", "response_count": 842,
      "selected": true, "synced": true, "last_sync_at": "2026-08-16T06:00:11Z" }
  ],
  "syncing_all": false,
  "total": 1
}
```

`syncing_all: true` means no explicit selection, so everything visible gets
synced. Convenient to start with; worth narrowing on a large account to stay
inside SurveyMonkey's daily API quota.

## Configuring the sync — `GET`/`POST /api/setup/sync-config`

```bash
curl -X POST -H "x-functions-key: $KEY" -H "Content-Type: application/json" \
  -d '{"surveyIds":["111","222"],"historyEnabled":true,"retentionDays":365}' \
  "$BASE/api/setup/sync-config"
```

| Field | Type | Meaning |
|---|---|---|
| `surveyIds` | `string[]` | Which surveys to sync. `[]` means all visible. |
| `historyEnabled` | `boolean` | Freeze a dated snapshot each sync. Enables trend reporting. |
| `retentionDays` | `number` | Prune snapshots older than this. `0` disables pruning. |
| `responseStatus` | `string` | `completed` (default), `partial`, or `all`. |
| `schedule` | `string` | NCRONTAB, six fields — see the caveat below. |

Omitted fields keep their current value. Configuration is stored in blob and
takes precedence over application settings, which is what makes it changeable
at runtime at all — a Function cannot rewrite its own app settings.

> **The schedule is different.** The Functions host binds the timer trigger at
> startup, so a new schedule only takes effect once `SYNC_SCHEDULE` is set as
> an application setting and the app restarts. The response returns it under
> `pending_app_settings` rather than pretending it has been applied:
>
> ```jsonc
> { "saved": true, "pending_app_settings": { "SYNC_SCHEDULE": "0 0 */2 * * *" } }
> ```

## Running a sync — `POST /api/sync`

```bash
curl -X POST -H "x-functions-key: $KEY" "$BASE/api/sync/111"      # one survey
curl -X POST -H "x-functions-key: $KEY" "$BASE/api/sync"          # all configured
curl -X POST -H "x-functions-key: $KEY" "$BASE/api/sync/111?full=true"
```

`full=true` ignores the stored watermark and re-pulls everything. You rarely
need it — syncs are incremental automatically, and a full pull happens on its
own when there's no retained data to merge into.

Syncing all surveys returns `207` if some succeeded and some failed, with
per-survey results, so a partial failure isn't hidden behind a `200`.

## Connecting Power BI — `GET /api/setup/connection-info`

```bash
curl -H "x-functions-key: $KEY" "$BASE/api/setup/connection-info?surveyId=111"
```

Returns the URL for every table plus a ready-to-paste Power Query script that
builds the whole five-table model. The base URL is derived from your request,
so the script is correct whether you're on localhost or deployed.

The function key in the script is a placeholder — function code can't read
host keys, and embedding a live credential in a response that gets copied
around is worse than fetching it from the portal once. Replace
`PASTE-YOUR-FUNCTION-KEY-HERE` and paste into Power BI's Advanced Editor. See
[`powerbi.md`](powerbi.md) for the relationships and measures to build on it.

## A complete setup, start to finish

```bash
BASE=https://your-app.azurewebsites.net
KEY=your-master-key
H="x-functions-key: $KEY"

curl -H "$H" "$BASE/api/setup/status"

curl -X POST -H "$H" -H "Content-Type: application/json" \
  -d '{"token":"YOUR-TOKEN"}' "$BASE/api/setup/token"

curl -H "$H" "$BASE/api/setup/surveys"

curl -X POST -H "$H" -H "Content-Type: application/json" \
  -d '{"surveyIds":["111"],"historyEnabled":true}' "$BASE/api/setup/sync-config"

curl -X POST -H "$H" "$BASE/api/sync/111"

curl -H "$H" "$BASE/api/setup/connection-info?surveyId=111"
```
