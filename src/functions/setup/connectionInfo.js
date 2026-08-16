const { app } = require('@azure/functions');
const { TABLE_NAMES } = require('../../lib/schema');
const blobStore = require('../../lib/blobStore');
const { makeLogger } = require('../../lib/logger');

/**
 * GET /api/setup/connection-info?surveyId=...
 *
 * Everything needed to connect Power BI to one survey: the table URLs and a
 * ready-to-paste Power Query script that builds the whole five-table model.
 *
 * The base URL is derived from the incoming request rather than configured,
 * so the snippet is correct whether the caller is on localhost or a deployed
 * Function App, without anyone having to type their own hostname.
 *
 * The function key is deliberately left as a placeholder. Function code
 * cannot read host keys without the master key, and embedding a live
 * credential in a response that a wizard may render, copy, or paste into a
 * shared document is worse than asking the user to fetch it from the portal
 * once.
 */
app.http('setupConnectionInfo', {
  methods: ['GET'],
  authLevel: 'admin',
  route: 'setup/connection-info',
  handler: async (request, context) => {
    const log = makeLogger(context);
    const surveyId = request.query.get('surveyId');

    if (!surveyId) {
      return {
        status: 400,
        jsonBody: { error: 'missing_survey_id', message: 'A surveyId query parameter is required.' },
      };
    }

    const baseUrl = deriveBaseUrl(request);

    let state = null;
    let snapshots = [];
    try {
      state = await blobStore.readJson(blobStore.paths.state(surveyId));
      if (state) snapshots = await blobStore.listSnapshotDates(surveyId);
    } catch (err) {
      log.warn('Could not read sync state for connection info', {
        surveyId,
        errorName: err.name,
      });
    }

    log.info('Generated Power BI connection info', { surveyId });

    return {
      status: 200,
      jsonBody: {
        survey_id: surveyId,
        synced: Boolean(state),
        last_sync_at: state ? state.last_sync_at : null,
        row_counts: state ? state.row_counts : null,
        snapshots,
        base_url: baseUrl,
        key_header: 'x-functions-key',
        key_hint:
          'Get the key from the Azure portal: Function App -> App keys -> default. Running ' +
          'locally, no key is required.',
        tables: TABLE_NAMES.map((table) => ({
          table,
          url: `${baseUrl}/api/surveys/${surveyId}/data/${table}`,
        })),
        quick_start: {
          description:
            'One wide table, no modelling required. In Power BI Desktop: Get Data -> Web -> ' +
            'Advanced, then add the key as a request header.',
          url: `${baseUrl}/api/surveys/${surveyId}/data/flat`,
        },
        power_query: buildPowerQuery(baseUrl, surveyId),
        docs: 'See docs/powerbi.md for relationships, DAX measures and scheduled refresh.',
      },
    };
  },
});

/**
 * Builds the base URL from the request.
 *
 * Behind Azure's front end the request arrives over HTTP with the original
 * scheme in x-forwarded-proto, so trusting request.url's protocol would
 * generate http:// links for an https deployment.
 */
function deriveBaseUrl(request) {
  const headers = request.headers;
  const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);

  const host = get('x-forwarded-host') || get('host');
  if (!host) {
    try {
      return new URL(request.url).origin;
    } catch {
      return 'https://your-function-app.azurewebsites.net';
    }
  }

  const forwardedProto = get('x-forwarded-proto');
  const proto = forwardedProto
    ? forwardedProto.split(',')[0].trim()
    : /^localhost(:|$)|^127\.0\.0\.1(:|$)/.test(host)
      ? 'http'
      : 'https';

  return `${proto}://${host}`;
}

/**
 * Generates the Power Query (M) script.
 *
 * Uses Web.Contents with RelativePath rather than a concatenated URL, because
 * the Power BI Service refuses to refresh "dynamic" data sources whose URL is
 * computed at runtime. Getting this wrong produces a report that refreshes on
 * the desktop and then fails in the service, which is a confusing thing to
 * debug after the fact.
 */
function buildPowerQuery(baseUrl, surveyId) {
  return `let
    BaseUrl     = "${baseUrl}",
    SurveyId    = "${surveyId}",
    FunctionKey = "PASTE-YOUR-FUNCTION-KEY-HERE",

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
    GetTable`;
}

module.exports = { deriveBaseUrl, buildPowerQuery };
