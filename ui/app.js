// The facilitations view for operators (spec 7).
//
// It shows metadata only: which facilitator runs each facilitation, its phase
// and counts. Contents and protocol are fetched only after the operator stated
// a reason, which the engine records; terminating works the same way.
//
// Plain browser JavaScript on purpose: the host serves this directory as it
// is, with `script-src 'self'`, so there is no inline script and no build.

(function () {
  'use strict';

  var LABELS = {
    en: {
      title: 'Facilitations',
      subtitle: 'Which facilitator runs which facilitation, its phase and counts. Contents are shown only with a stated reason; every access is recorded.',
      phase: 'Phase',
      facilitator: 'Facilitator',
      allPhases: 'All phases',
      refresh: 'Refresh',
      empty: 'No facilitations match.',
      columns: {
        facilitator: 'Facilitator',
        conversation: 'Conversation',
        phase: 'Phase and format',
        participants: 'Participants',
        counts: 'Counts',
        dates: 'Dates',
        actions: 'Actions',
      },
      counts: { contributions: 'Contributions', decisions: 'Decisions', actionItems: 'Action items', messages: 'Messages' },
      dates: { deadline: 'Deadline', created: 'Started', closed: 'Closed', ended: 'Ended', retention: 'Retention ends', deletion: 'Deleted from' },
      formats: { decision: 'Decision', prioritisation: 'Prioritisation', assignment: 'Assignment', ideas: 'Idea collection', retrospective: 'Retrospective', alignment: 'Alignment', custom: 'Custom' },
      activeOf: 'active of',
      phases: { configuring: 'Being set up', active: 'Running', concluding: 'Concluding', closed: 'Closed', aborted: 'Ended without a result', following_up: 'Following up action items', ended: 'Ended' },
      followup: 'follow-up running',
      showContents: 'Show contents',
      terminate: 'Terminate',
      contentsTitle: 'Contents of a facilitation',
      contentsHint: 'Contents and protocol are visible to its participants. State why you need to see them; the reason is recorded and noted in the protocol of the facilitation.',
      terminateTitle: 'Terminate a facilitation',
      terminateHint: 'The group gets an abort report that names your reason. This cannot be undone.',
      reason: 'Reason (at least 10 characters)',
      submitContents: 'Record the reason and show',
      submitTerminate: 'Record the reason and terminate',
      cancel: 'Cancel',
      audit: 'Recorded operator access',
      auditActions: { content_read: 'contents read', terminate: 'terminated' },
      terminated: 'The facilitation was ended. The group has been told.',
      loading: 'Loading…',
      unavailable: 'The facilitation engine is not available: ',
      failed: 'The request failed: ',
      none: '–',
    },
    de: {
      title: 'Moderationen',
      subtitle: 'Welcher Facilitator welche Moderation führt, ihre Phase und Zahlen. Inhalte werden nur mit angegebenem Grund gezeigt; jeder Zugriff wird festgehalten.',
      phase: 'Phase',
      facilitator: 'Facilitator',
      allPhases: 'Alle Phasen',
      refresh: 'Aktualisieren',
      empty: 'Keine passenden Moderationen.',
      columns: {
        facilitator: 'Facilitator',
        conversation: 'Unterhaltung',
        phase: 'Phase und Format',
        participants: 'Teilnehmende',
        counts: 'Zahlen',
        dates: 'Zeiten',
        actions: 'Aktionen',
      },
      counts: { contributions: 'Beiträge', decisions: 'Entscheidungen', actionItems: 'Aufgaben', messages: 'Nachrichten' },
      dates: { deadline: 'Deadline', created: 'Gestartet', closed: 'Abgeschlossen', ended: 'Beendet', retention: 'Aufbewahrung bis', deletion: 'Gelöscht ab' },
      formats: { decision: 'Entscheidung', prioritisation: 'Priorisierung', assignment: 'Zuweisung', ideas: 'Ideensammlung', retrospective: 'Retrospektive', alignment: 'Abstimmung', custom: 'Eigenes Format' },
      activeOf: 'aktiv von',
      phases: { configuring: 'Wird eingerichtet', active: 'Läuft', concluding: 'Wird abgeschlossen', closed: 'Abgeschlossen', aborted: 'Ohne Ergebnis beendet', following_up: 'Aufgaben werden nachverfolgt', ended: 'Beendet' },
      followup: 'Nachverfolgung läuft',
      showContents: 'Inhalte anzeigen',
      terminate: 'Beenden',
      contentsTitle: 'Inhalte einer Moderation',
      contentsHint: 'Inhalte und Protokoll sind für die Teilnehmenden sichtbar. Gib an, warum du sie sehen musst; der Grund wird festgehalten und im Protokoll der Moderation vermerkt.',
      terminateTitle: 'Moderation beenden',
      terminateHint: 'Die Gruppe erhält einen Abbruchbericht, der deinen Grund nennt. Das lässt sich nicht rückgängig machen.',
      reason: 'Grund (mindestens 10 Zeichen)',
      submitContents: 'Grund festhalten und anzeigen',
      submitTerminate: 'Grund festhalten und beenden',
      cancel: 'Abbrechen',
      audit: 'Festgehaltene Operator-Zugriffe',
      auditActions: { content_read: 'Inhalte gelesen', terminate: 'beendet' },
      terminated: 'Die Moderation wurde beendet. Die Gruppe wurde informiert.',
      loading: 'Lädt…',
      unavailable: 'Die Facilitation-Engine ist nicht verfügbar: ',
      failed: 'Die Anfrage ist fehlgeschlagen: ',
      none: '–',
    },
  };

  var PHASES = ['configuring', 'active', 'concluding', 'closed', 'aborted'];
  var COLUMNS = ['facilitator', 'conversation', 'phase', 'participants', 'counts', 'dates', 'actions'];
  // Behind the web UI the API is under /bot-api, on the middleware under /api.
  var API_BASES = ['/bot-api/v1/facilitation', '/api/v1/facilitation'];

  function pickLanguage() {
    var fromQuery = new URLSearchParams(window.location.search).get('lang');
    var wanted = (fromQuery || document.documentElement.getAttribute('data-lang') || navigator.language || 'en').toLowerCase().slice(0, 2);
    return LABELS[wanted] ? wanted : 'en';
  }

  var lang = pickLanguage();
  var t = LABELS[lang];
  var apiBase = null;
  var pending = null;

  function el(id) {
    return document.getElementById(id);
  }

  function node(tag, text, attrs) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    Object.keys(attrs || {}).forEach(function (key) {
      n.setAttribute(key, attrs[key]);
    });
    return n;
  }

  function when(iso) {
    if (!iso) return t.none;
    return new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  }

  function banner(kind, message) {
    var box = el('banner');
    box.textContent = '';
    if (!message) return;
    box.appendChild(node('p', message, { class: kind === 'error' ? 'harness-banner-error' : 'harness-banner-info' }));
  }

  // The first base that answers is kept. A 404 from the proxy means "not here".
  function request(method, path, body) {
    var bases = apiBase ? [apiBase] : API_BASES.slice();
    function attempt(index) {
      var base = bases[index];
      return fetch(base + path, {
        method: method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }).then(function (response) {
        var isJson = (response.headers.get('content-type') || '').indexOf('application/json') !== -1;
        if (!isJson) {
          if (index + 1 < bases.length) return attempt(index + 1);
          throw new Error('HTTP ' + response.status);
        }
        apiBase = base;
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload };
        });
      });
    }
    return attempt(0);
  }

  function describeError(result) {
    var error = result.payload && result.payload.error;
    return error ? error.message : 'HTTP ' + result.status;
  }

  function renderRows(items) {
    var rows = el('rows');
    rows.textContent = '';
    el('empty').hidden = items.length !== 0;
    items.forEach(function (f) {
      var tr = document.createElement('tr');
      // `state` is the lifecycle of the specification (1.4.0): after the
      // close it says whether action items are followed up or it has ended.
      var phase = t.phases[f.state || f.phase] || f.state || f.phase;
      if (!f.state && f.followupState === 'active') phase += ' (' + t.followup + ')';
      // Several short lines in one cell keep the table inside the host's frame.
      var lines = function (pairs) {
        var td = document.createElement('td');
        pairs.forEach(function (pair) {
          if (pair[1] === null || pair[1] === undefined) return;
          td.appendChild(node('div', pair[0] + ': ' + pair[1], { style: 'white-space: nowrap' }));
        });
        return td;
      };
      tr.appendChild(node('td', f.facilitator));
      // Conversation ids are long and have no spaces: let them break anywhere.
      tr.appendChild(node('td', f.channelType + ' · ' + f.conversationId, { style: 'word-break: break-all; min-width: 8rem; max-width: 11rem' }));
      var state = document.createElement('td');
      state.appendChild(node('div', phase));
      state.appendChild(node('div', t.formats[f.format] || f.format, { class: 'harness-subtitle' }));
      tr.appendChild(state);
      tr.appendChild(node('td', f.counts.activeParticipants + ' ' + t.activeOf + ' ' + f.counts.participants));
      tr.appendChild(
        lines([
          [t.counts.contributions, f.counts.contributions],
          [t.counts.decisions, f.counts.decisions],
          [t.counts.actionItems, f.counts.actionItems],
          [t.counts.messages, f.counts.messagesSent],
        ]),
      );
      tr.appendChild(
        lines([
          [t.dates.created, when(f.createdAt)],
          [t.dates.deadline, f.deadline ? when(f.deadline) : null],
          [t.dates.closed, f.closedAt ? when(f.closedAt) : null],
          [t.dates.ended, f.endedAt ? when(f.endedAt) : null],
          [t.dates.retention, f.purgeAfter ? when(f.purgeAfter) : null],
          // The effective deletion time: later than the retention end while a
          // closing or a scope still runs (spec 5.8).
          [t.dates.deletion, f.effectiveDeletionAt ? when(f.effectiveDeletionAt) : null],
        ]),
      );
      var cell = document.createElement('td');
      var actions = node('div', null, { style: 'display: grid; justify-items: start; white-space: nowrap' });
      cell.appendChild(actions);
      var show = node('button', t.showContents, { type: 'button', class: 'harness-btn' });
      show.addEventListener('click', function () {
        openDetail('content', f);
      });
      actions.appendChild(show);
      if (f.phase === 'configuring' || f.phase === 'active' || f.phase === 'concluding') {
        var stop = node('button', t.terminate, { type: 'button', class: 'harness-btn', style: 'margin-top: 0.5rem' });
        stop.addEventListener('click', function () {
          openDetail('terminate', f);
        });
        actions.appendChild(stop);
      }
      tr.appendChild(cell);
      rows.appendChild(tr);
    });
  }

  function load() {
    banner('info', t.loading);
    var query = [];
    var phase = el('filter-phase').value;
    var facilitator = el('filter-facilitator').value.trim();
    if (phase) query.push('phase=' + encodeURIComponent(phase));
    if (facilitator) query.push('facilitator=' + encodeURIComponent(facilitator));
    return request('GET', '/facilitations' + (query.length ? '?' + query.join('&') : ''))
      .then(function (result) {
        if (result.status === 503) {
          banner('error', t.unavailable + describeError(result));
          renderRows([]);
          return;
        }
        if (!result.payload.ok) {
          banner('error', t.failed + describeError(result));
          return;
        }
        banner('info', '');
        renderRows(result.payload.data);
      })
      .catch(function (err) {
        banner('error', t.failed + err.message);
      });
  }

  function loadAudit(id) {
    return request('GET', '/facilitations/' + id + '/audit').then(function (result) {
      var list = el('audit');
      list.textContent = '';
      var entries = result.payload.ok ? result.payload.data : [];
      el('audit-title').hidden = entries.length === 0;
      entries.forEach(function (entry) {
        list.appendChild(node('li', when(entry.occurredAt) + ' · ' + entry.actor + ' · ' + (t.auditActions[entry.action] || entry.action) + ' · ' + entry.reason));
      });
    });
  }

  function openDetail(kind, facilitation) {
    pending = { kind: kind, id: facilitation.id };
    el('detail').hidden = false;
    el('detail-title').textContent = (kind === 'content' ? t.contentsTitle : t.terminateTitle) + ' · ' + facilitation.facilitator;
    el('detail-hint').textContent = kind === 'content' ? t.contentsHint : t.terminateHint;
    el('submit-reason').textContent = kind === 'content' ? t.submitContents : t.submitTerminate;
    el('reason').value = '';
    el('protocol').hidden = true;
    el('protocol').textContent = '';
    el('reason').focus();
    loadAudit(facilitation.id).catch(function () {});
  }

  function closeDetail() {
    pending = null;
    el('detail').hidden = true;
  }

  function submitReason(event) {
    event.preventDefault();
    if (!pending) return;
    var current = pending;
    var path = '/facilitations/' + current.id + (current.kind === 'content' ? '/content' : '/terminate');
    request('POST', path, { reason: el('reason').value })
      .then(function (result) {
        if (!result.payload.ok) {
          banner('error', t.failed + describeError(result));
          return;
        }
        banner('info', '');
        if (current.kind === 'content') {
          el('protocol').textContent = result.payload.data.protocol;
          el('protocol').hidden = false;
        }
        loadAudit(current.id).catch(function () {});
        // The list is read again first; the confirmation stays visible after it.
        if (current.kind === 'terminate') {
          load().then(function () {
            banner('info', t.terminated);
          });
        }
      })
      .catch(function (err) {
        banner('error', t.failed + err.message);
      });
  }

  function init() {
    document.documentElement.lang = lang;
    document.title = t.title;
    el('title').textContent = t.title;
    el('subtitle').textContent = t.subtitle;
    el('label-phase').textContent = t.phase;
    el('label-facilitator').textContent = t.facilitator;
    el('refresh').textContent = t.refresh;
    el('empty').textContent = t.empty;
    el('label-reason').textContent = t.reason;
    el('cancel-reason').textContent = t.cancel;
    el('audit-title').textContent = t.audit;

    var select = el('filter-phase');
    select.appendChild(node('option', t.allPhases, { value: '' }));
    PHASES.forEach(function (phase) {
      select.appendChild(node('option', t.phases[phase], { value: phase }));
    });
    var head = el('head');
    COLUMNS.forEach(function (column) {
      head.appendChild(node('th', t.columns[column], { scope: 'col' }));
    });

    el('filters').addEventListener('submit', function (event) {
      event.preventDefault();
      load();
    });
    el('reason-form').addEventListener('submit', submitReason);
    el('cancel-reason').addEventListener('click', closeDetail);
    load();
  }

  // Exposed for the label test; the page itself only needs init().
  window.__facilitationsUi = { LABELS: LABELS, COLUMNS: COLUMNS, PHASES: PHASES };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
