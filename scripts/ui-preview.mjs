#!/usr/bin/env node
/**
 * ui-preview.mjs — look at the facilitations view without a running host.
 *
 *     node scripts/ui-preview.mjs [port] [path/to/plugin-ui.css]
 *
 * Serves `ui/` the way the host does (same Content-Security-Policy, at
 * /p/<plugin id>/ui/) next to a mock of the operator API with sample data, so
 * the page can be opened in a browser. Development only; nothing here ships.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 4173);
const cssPath = process.argv[3] ?? resolve(root, '../odoo-bot/middleware/assets/plugin-ui/plugin-ui.css');
const UI_PREFIX = '/p/%40omadia%2Fagent-facilitator/ui/';
const API = '/api/v1/facilitation/facilitations';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const sample = (id, facilitator, phase, extra = {}) => ({
  id,
  facilitator,
  channelType: 'teams',
  conversationId: `19:${id.slice(0, 8)}@thread.v2`,
  phase,
  format: 'decision',
  language: 'de',
  counts: { participants: 4, activeParticipants: 4, contributions: 3, decisions: 0, actionItems: 0, steps: 5, messagesSent: 7 },
  deadline: '2026-11-21T16:00:00.000Z',
  createdAt: '2026-11-18T09:00:00.000Z',
  activatedAt: '2026-11-18T09:05:00.000Z',
  concludedAt: null,
  closedAt: null,
  closeReason: null,
  followupState: 'none',
  purgeAfter: null,
  ...extra,
});

const facilitations = [
  sample('11111111-1111-4111-8111-111111111111', 'mira', 'active'),
  sample('22222222-2222-4222-8222-222222222222', 'jonas', 'configuring', { format: 'retrospective', deadline: null, counts: { participants: 6, activeParticipants: 6, contributions: 0, decisions: 0, actionItems: 0, steps: 7, messagesSent: 0 } }),
  sample('33333333-3333-4333-8333-333333333333', 'mira', 'closed', { closedAt: '2026-11-17T15:30:00.000Z', closeReason: 'result', followupState: 'active', purgeAfter: '2027-02-15T15:30:00.000Z', counts: { participants: 5, activeParticipants: 4, contributions: 12, decisions: 2, actionItems: 2, steps: 7, messagesSent: 31 } }),
  sample('44444444-4444-4444-8444-444444444444', 'jonas', 'aborted', { closedAt: '2026-11-16T10:00:00.000Z', closeReason: 'ended without a result', purgeAfter: '2027-02-14T10:00:00.000Z' }),
];
const audit = new Map();
const envelope = (data, meta) => ({ ok: true, data, error: null, ...(meta ? { meta } : {}) });
const refusal = (code, message) => ({ ok: false, data: null, error: { code, message } });

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        done(JSON.parse(raw || '{}'));
      } catch {
        done({});
      }
    });
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname === '/api/_harness/plugin-ui.css') {
    if (!existsSync(cssPath)) return json(res, 404, refusal('not_found', 'stylesheet not found'));
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    return res.end(readFileSync(cssPath));
  }
  if (url.pathname.startsWith(UI_PREFIX)) {
    const file = url.pathname.slice(UI_PREFIX.length) || 'index.html';
    const path = join(root, 'ui', file);
    if (file.includes('..') || !existsSync(path) || !TYPES[extname(path)]) return json(res, 404, refusal('not_found', 'no such file'));
    res.writeHead(200, { 'content-type': TYPES[extname(path)], 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
    return res.end(readFileSync(path));
  }
  if (url.pathname === API && req.method === 'GET') {
    const phase = url.searchParams.get('phase');
    const facilitator = url.searchParams.get('facilitator');
    const data = facilitations.filter((f) => (!phase || f.phase === phase) && (!facilitator || f.facilitator === facilitator));
    return json(res, 200, envelope(data, { total: data.length }));
  }
  const match = /^\/api\/v1\/facilitation\/facilitations\/([0-9a-f-]{36})\/(content|terminate|audit)$/.exec(url.pathname);
  if (match) {
    const [, id, action] = match;
    const f = facilitations.find((x) => x.id === id);
    if (!f) return json(res, 404, refusal('not_found', 'No such facilitation.'));
    if (action === 'audit') return json(res, 200, envelope(audit.get(id) ?? []));
    const { reason } = await readBody(req);
    if (typeof reason !== 'string' || reason.trim().length < 10) return json(res, 400, refusal('reason_required', 'State why you need this, in at least 10 characters. The reason is recorded.'));
    audit.set(id, [...(audit.get(id) ?? []), { action: action === 'content' ? 'content_read' : 'terminate', actor: 'operator@example.com', reason: reason.trim(), occurredAt: new Date().toISOString() }]);
    if (action === 'terminate') {
      f.phase = 'aborted';
      f.closedAt = new Date().toISOString();
      return json(res, 200, envelope({ id, phase: 'aborted' }));
    }
    return json(res, 200, envelope({ goal: 'Sample goal', protocol: 'Protocol: Sample goal\nFacilitator: Mira\nStarted by: Anna\nParticipants: Anna, Bert, Cara, Dave\n\nDecisions:\n- Venue: Harbour (Harbour 10, Old Town 6)' }));
  }
  // Like the web UI's proxy for a path that does not exist behind it.
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>404</title>');
}).listen(port, '127.0.0.1', () => {
  console.log(`facilitations view: http://127.0.0.1:${port}${UI_PREFIX}  (add ?lang=de for German)`);
});
