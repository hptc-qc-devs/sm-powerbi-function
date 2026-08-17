/*
 * Setup wizard.
 *
 * Vanilla JavaScript on purpose: no framework, no bundler, no build step, so
 * the wizard can be edited by cloning the repo and opening this file. It is
 * small enough that a framework would cost more than it saved.
 *
 * The admin key arrives as ?code= in this page's own URL — that is how Azure
 * let the browser load the page at all — so it is read back out and sent as an
 * x-functions-key header on API calls. It is never written to localStorage or
 * put in a link, so it lives only as long as the tab does.
 */

(function () {
  'use strict';

  var KEY = new URLSearchParams(location.search).get('code') || '';
  var state = { surveys: [], selected: new Set(), syncedIds: [] };

  // The key arrives in the URL because that is the only way Azure lets the
  // browser load this page at all. Once read, it is scrubbed from the address
  // bar so the master key does not sit in browser history, get copied when
  // someone shares the link, or reappear from the back button. It stays in
  // memory for the life of the tab, which is all the wizard needs.
  if (KEY && window.history && window.history.replaceState) {
    var cleaned = new URL(location.href);
    cleaned.searchParams.delete('code');
    window.history.replaceState({}, document.title, cleaned.pathname + cleaned.search + cleaned.hash);
  }

  // --- API ----------------------------------------------------------------

  async function api(path, options) {
    options = options || {};

    var headers = { Accept: 'application/json' };
    if (KEY) headers['x-functions-key'] = KEY;
    if (options.body) headers['Content-Type'] = 'application/json';

    var response = await fetch('/api/' + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    var payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      // Some failures (a 401 from the host itself) are not JSON.
      payload = null;
    }

    if (!response.ok) {
      var message =
        (payload && (payload.message || payload.error)) ||
        (response.status === 401
          ? 'Not authorized. Open this page with ?code=YOUR-MASTER-KEY appended to the URL.'
          : 'Request failed (' + response.status + ').');

      var err = new Error(message);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  // --- DOM helpers --------------------------------------------------------

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }
  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function banner(node, kind, message) {
    node.className = 'banner ' + kind;
    node.textContent = message;
    node.hidden = false;
  }

  function showGlobalError(message) {
    banner($('#global-error'), 'error', message);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function busy(button, isBusy, busyLabel) {
    if (isBusy) {
      button.dataset.label = button.textContent;
      button.textContent = busyLabel || 'Working…';
      button.disabled = true;
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
    }
  }

  // --- navigation ---------------------------------------------------------

  function goTo(step) {
    $$('.step').forEach(function (section) {
      section.hidden = section.dataset.step !== String(step);
    });

    $$('.steps li').forEach(function (item) {
      var n = Number(item.dataset.stepTab);
      delete item.dataset.active;
      delete item.dataset.done;
      if (n === step) item.dataset.active = 'true';
      else if (n < step) item.dataset.done = 'true';
    });

    window.scrollTo({ top: 0 });

    if (step === 3) loadSurveys();
    if (step === 4) populateSurveyPicker();
  }

  // --- step 1: environment status ----------------------------------------

  async function refreshStatus() {
    var detail = $('#env-detail');

    try {
      var status = await api('setup/status');

      setCheck('storage', status.checks.storageReachable);
      setCheck('token', status.checks.tokenValid);

      if (!status.checks.storageReachable) {
        detail.textContent =
          'Storage is not reachable. Check STORAGE_ACCOUNT_URL and that the Function App ' +
          'identity has the Storage Blob Data Contributor role.';
      } else if (status.checks.tokenValid) {
        detail.textContent = status.account && status.account.username
          ? 'Connected to SurveyMonkey as ' + status.account.username + '.'
          : 'Connected to SurveyMonkey.';
        $('#to-step-3').disabled = false;
      } else {
        detail.textContent = status.token_message || 'No SurveyMonkey token stored yet.';
      }

      if (status.config) {
        state.selected = new Set(status.config.surveyIds || []);
        $('#history-enabled').checked = Boolean(status.config.historyEnabled);
        $('#retention-days').value = status.config.retentionDays;
        $('#response-status').value = status.config.responseStatus || 'completed';
      }

      state.syncedIds = (status.surveys || [])
        .filter(function (s) { return s.synced; })
        .map(function (s) { return s.survey_id; });

      if (state.syncedIds.length > 0) $('#to-step-4').disabled = false;
    } catch (err) {
      setCheck('storage', false);
      setCheck('token', false);
      detail.textContent = err.message;
      if (err.status === 401) showGlobalError(err.message);
    }
  }

  function setCheck(name, ok) {
    var node = $('.checks li[data-check="' + name + '"]');
    if (node) node.dataset.state = ok ? 'ok' : 'bad';
  }

  // --- step 2: credentials ------------------------------------------------

  function initTabs() {
    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        $$('.tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');

        $$('.tab-panel').forEach(function (panel) {
          panel.hidden = panel.dataset.panel !== tab.dataset.tab;
        });
      });
    });
  }

  async function saveToken() {
    var button = $('#save-token');
    var result = $('#token-result');
    var token = $('#token').value.trim();

    if (!token) {
      banner(result, 'error', 'Paste your access token first.');
      return;
    }

    busy(button, true, 'Checking…');
    try {
      var response = await api('setup/token', { method: 'POST', body: { token: token } });

      banner(
        result,
        'ok',
        response.account && response.account.username
          ? 'Connected as ' + response.account.username + '. Token saved.'
          : 'Token validated and saved.'
      );

      // Clear it from the field once stored — it lives in the secret store now.
      $('#token').value = '';
      $('#to-step-3').disabled = false;
      setCheck('token', true);
    } catch (err) {
      banner(result, 'error', err.message);
    } finally {
      busy(button, false);
    }
  }

  async function startOAuth() {
    var button = $('#start-oauth');
    var result = $('#oauth-result');

    var body = {
      clientId: $('#client-id').value.trim(),
      clientSecret: $('#client-secret').value.trim(),
      redirectUri: $('#redirect-uri').value,
    };

    if (!body.clientId || !body.clientSecret) {
      banner(result, 'error', 'Enter both the client ID and client secret from your app.');
      return;
    }

    busy(button, true, 'Starting…');
    try {
      var response = await api('setup/oauth/start', { method: 'POST', body: body });

      $('#client-secret').value = '';
      banner(
        result,
        'warn',
        'Opening SurveyMonkey in a new tab. Approve access there, then come back and ' +
          'press Continue. The link is valid for 10 minutes and works once.'
      );
      window.open(response.authorize_url, '_blank', 'noopener');

      // The callback stores the token out of band, so poll for it rather than
      // asking the user to tell us when they are done.
      pollForToken();
    } catch (err) {
      banner(result, 'error', err.message);
    } finally {
      busy(button, false);
    }
  }

  function pollForToken() {
    var attempts = 0;

    var timer = setInterval(async function () {
      attempts += 1;
      if (attempts > 60) return clearInterval(timer); // give up after ~5 minutes

      try {
        var status = await api('setup/status');
        if (status.checks.tokenValid) {
          clearInterval(timer);
          banner(
            $('#oauth-result'),
            'ok',
            status.account && status.account.username
              ? 'Connected as ' + status.account.username + '.'
              : 'Connected to SurveyMonkey.'
          );
          $('#to-step-3').disabled = false;
          setCheck('token', true);
        }
      } catch (e) {
        // Transient failures while the user is away are not worth reporting.
      }
    }, 5000);
  }

  // --- step 3: surveys ----------------------------------------------------

  async function loadSurveys() {
    var list = $('#survey-list');
    list.innerHTML = '';
    list.appendChild(el('p', 'muted', 'Loading surveys…'));

    try {
      var response = await api('setup/surveys');
      state.surveys = response.data || [];

      if (state.surveys.length === 0) {
        list.innerHTML = '';
        list.appendChild(
          el('p', 'muted', 'This token cannot see any surveys. Check the app has the View Surveys scope.')
        );
        return;
      }

      // Selection already stored server-side wins over anything cached here.
      state.surveys.forEach(function (survey) {
        if (survey.selected) state.selected.add(survey.id);
      });

      renderSurveys();
    } catch (err) {
      list.innerHTML = '';
      list.appendChild(el('p', 'muted', err.message));
    }
  }

  function renderSurveys() {
    var list = $('#survey-list');
    list.innerHTML = '';

    state.surveys.forEach(function (survey) {
      var row = el('label', 'survey-row');

      var checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(survey.id);
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) state.selected.add(survey.id);
        else state.selected.delete(survey.id);
      });

      var text = el('div');
      text.appendChild(el('div', 'title', survey.title || '(untitled survey)'));

      var meta = [];
      if (typeof survey.response_count === 'number') {
        meta.push(survey.response_count + ' responses');
      }
      meta.push(survey.synced ? 'synced ' + formatDate(survey.last_sync_at) : 'not synced yet');
      text.appendChild(el('div', 'meta', meta.join(' · ')));

      row.appendChild(checkbox);
      row.appendChild(text);
      list.appendChild(row);
    });
  }

  async function saveAndSync() {
    var button = $('#save-and-sync');
    var result = $('#sync-result');

    var config = {
      surveyIds: Array.from(state.selected),
      historyEnabled: $('#history-enabled').checked,
      retentionDays: Number($('#retention-days').value),
      responseStatus: $('#response-status').value,
    };

    busy(button, true, 'Saving…');
    try {
      await api('setup/sync-config', { method: 'POST', body: config });

      banner(
        result,
        'warn',
        'Saved. Running the first sync — this pulls every response and can take a few ' +
          'minutes on a large survey.'
      );

      busy(button, true, 'Syncing…');
      var sync = await api('sync', { method: 'POST' });

      var failed = (sync.results || []).filter(function (r) { return r.status === 'failed'; });
      var succeeded = (sync.results || []).filter(function (r) { return r.status === 'ok'; });

      state.syncedIds = succeeded.map(function (r) { return r.surveyId; });

      if (failed.length === 0) {
        banner(result, 'ok', 'Synced ' + succeeded.length + ' survey(s). Ready for Power BI.');
      } else {
        banner(
          result,
          'warn',
          'Synced ' + succeeded.length + ', failed ' + failed.length + ': ' +
            failed.map(function (f) { return f.surveyId + ' (' + f.error + ')'; }).join('; ')
        );
      }

      if (succeeded.length > 0) $('#to-step-4').disabled = false;
    } catch (err) {
      banner(result, 'error', err.message);
    } finally {
      busy(button, false);
    }
  }

  // --- step 4: Power BI ---------------------------------------------------

  function populateSurveyPicker() {
    var picker = $('#survey-picker');
    picker.innerHTML = '';

    var candidates = state.surveys.filter(function (s) {
      return state.selected.has(s.id) || state.syncedIds.indexOf(s.id) !== -1;
    });

    if (candidates.length === 0) {
      candidates = state.syncedIds.map(function (id) { return { id: id, title: 'Survey ' + id }; });
    }

    candidates.forEach(function (survey) {
      var option = el('option', null, survey.title || survey.id);
      option.value = survey.id;
      picker.appendChild(option);
    });

    if (candidates.length > 0) loadConnectionInfo(candidates[0].id);
  }

  async function loadConnectionInfo(surveyId) {
    var container = $('#connection-info');
    container.innerHTML = '';
    container.appendChild(el('p', 'muted', 'Loading…'));

    try {
      var info = await api('setup/connection-info?surveyId=' + encodeURIComponent(surveyId));
      container.innerHTML = '';

      if (!info.synced) {
        var warning = el('div', 'banner warn');
        warning.textContent =
          'This survey has not synced yet, so these URLs will return "not synced" until it does.';
        container.appendChild(warning);
      }

      container.appendChild(el('h3', null, 'Quickest route: one table'));
      container.appendChild(
        el('p', 'muted', 'Power BI Desktop → Get Data → Web → Advanced. Add the key as a header.')
      );
      container.appendChild(copyBlock(info.quick_start.url));

      container.appendChild(el('h3', null, 'Function key'));
      container.appendChild(el('p', 'muted', info.key_hint));
      container.appendChild(
        el('p', 'muted', 'Send it as the header ' + info.key_header + '.')
      );

      container.appendChild(el('h3', null, 'Full model: all five tables'));
      container.appendChild(
        el(
          'p',
          'muted',
          'Paste into Power BI Desktop → Get Data → Blank query → Advanced Editor, name it ' +
            'GetSurveyTable, then create one query per table calling GetSurveyTable("answers") ' +
            'and so on. See docs/powerbi.md for the relationships and measures.'
        )
      );
      container.appendChild(copyBlock(info.power_query, true));

      container.appendChild(el('h3', null, 'Table URLs'));
      container.appendChild(tableOfUrls(info.tables));

      if (info.snapshots && info.snapshots.length > 0) {
        container.appendChild(el('h3', null, 'Snapshots available'));
        container.appendChild(
          el('p', 'muted', info.snapshots.join(', ') + ' — add ?snapshot=DATE to any table URL.')
        );
      }
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(el('p', 'muted', err.message));
    }
  }

  function copyBlock(text, isBlock) {
    var wrapper = el('div');

    if (isBlock) {
      wrapper.appendChild(el('pre', null, text));
    } else {
      var row = el('div', 'copy-row');
      var input = el('input');
      input.type = 'text';
      input.readOnly = true;
      input.value = text;
      row.appendChild(input);
      wrapper.appendChild(row);
    }

    var button = el('button', 'ghost', 'Copy');
    button.addEventListener('click', function () {
      copyText(text, button);
    });
    wrapper.appendChild(button);

    return wrapper;
  }

  function tableOfUrls(tables) {
    var table = el('table');
    var head = el('tr');
    head.appendChild(el('th', null, 'Table'));
    head.appendChild(el('th', null, 'URL'));
    table.appendChild(head);

    tables.forEach(function (entry) {
      var row = el('tr');
      row.appendChild(el('td', null, entry.table));

      var cell = el('td');
      cell.appendChild(el('code', null, entry.url));
      row.appendChild(cell);

      table.appendChild(row);
    });

    return table;
  }

  // --- utilities ----------------------------------------------------------

  function copyText(text, button) {
    var done = function () {
      var original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = original; }, 1500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }

    function fallback() {
      // clipboard API needs a secure context; plain http://localhost during
      // development is not always one.
      var area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
      document.body.removeChild(area);
    }
  }

  function formatDate(value) {
    if (!value) return 'never';
    var date = new Date(value);
    return isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
  }

  // --- wiring -------------------------------------------------------------

  function init() {
    $('#redirect-uri').value = location.origin + '/api/setup/oauth/callback';

    $$('[data-goto]').forEach(function (button) {
      button.addEventListener('click', function () {
        goTo(Number(button.dataset.goto));
      });
    });

    $$('[data-copy]').forEach(function (button) {
      button.addEventListener('click', function () {
        copyText($(button.dataset.copy).value, button);
      });
    });

    $('#show-token').addEventListener('change', function (event) {
      $('#token').type = event.target.checked ? 'text' : 'password';
    });

    $('#save-token').addEventListener('click', saveToken);
    $('#start-oauth').addEventListener('click', startOAuth);
    $('#save-and-sync').addEventListener('click', saveAndSync);
    $('#survey-picker').addEventListener('change', function (event) {
      loadConnectionInfo(event.target.value);
    });

    initTabs();
    goTo(1);
    refreshStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
