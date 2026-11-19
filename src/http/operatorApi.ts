// The operator API (spec 5.8, 7): metadata of every facilitation, contents
// only through an audited access with a stated reason, and termination.
//
// The kernel mounts it behind its session gate (`auth: 'session'`), so every
// request here already belongs to a signed-in operator. `handle()` is the
// whole API as a function of plain values; `router()` adapts it to Express,
// which the kernel provides. No Express import: the package ships unbundled
// and a middleware is just a function.

import { Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';
import { listAudit, listMetadata, operatorContent, operatorTerminate } from '../engine/governance.js';

export const OPERATOR_API_PREFIX = '/api/v1/facilitation';

export interface ApiRequest {
  method: string;
  /** Path below the mount point, e.g. '/facilitations/<id>/content'. */
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  /** Who is signed in, as the kernel resolved it. */
  actor: string;
}

export interface ApiResponse {
  status: number;
  body: { ok: boolean; data: unknown; error: { code: string; message: string } | null; meta?: Record<string, unknown> };
}

const ok = (data: unknown, meta?: Record<string, unknown>): ApiResponse => ({ status: 200, body: { ok: true, data, error: null, ...(meta ? { meta } : {}) } });
const fail = (status: number, code: string, message: string): ApiResponse => ({ status, body: { ok: false, data: null, error: { code, message } } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASES = ['configuring', 'active', 'concluding', 'closed', 'aborted'];
const STATUS_BY_CODE: Record<string, number> = { not_found: 404, reason_required: 400, not_live: 409, unknown_facilitation: 404 };

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
const field = (body: unknown, key: string): string | undefined =>
  body !== null && typeof body === 'object' ? text((body as Record<string, unknown>)[key]) : undefined;

export async function handle(engine: FacilitationEngine, request: ApiRequest): Promise<ApiResponse> {
  if (!engine.available()) return fail(503, 'engine_unavailable', 'The facilitation engine has no database.');
  const db = engine.core.db();
  const segments = request.path.split('/').filter((s) => s !== '');
  const method = request.method.toUpperCase();
  try {
    if (segments[0] !== 'facilitations') return fail(404, 'not_found', 'No such resource.');
    const [, id, action] = segments;

    if (id === undefined) {
      if (method !== 'GET') return fail(405, 'method_not_allowed', 'Use GET.');
      const phase = text(request.query['phase']);
      if (phase !== undefined && !PHASES.includes(phase)) return fail(400, 'bad_phase', `phase must be one of: ${PHASES.join(', ')}`);
      const facilitator = text(request.query['facilitator']);
      const data = await listMetadata(db, { ...(phase ? { phase } : {}), ...(facilitator ? { facilitator } : {}) });
      return ok(data, { total: data.length });
    }

    if (!UUID.test(id)) return fail(400, 'bad_id', 'The facilitation id is not valid.');

    if (action === undefined) {
      if (method !== 'GET') return fail(405, 'method_not_allowed', 'Use GET.');
      const [data] = await listMetadata(db, { id });
      return data ? ok(data) : fail(404, 'not_found', 'No such facilitation.');
    }

    if (action === 'audit' && method === 'GET') {
      const audit = await listAudit(db, id);
      return ok(audit.map((a) => ({ action: a.action, actor: a.actor, reason: a.reason, occurredAt: a.occurredAt.toISOString() })));
    }

    // Reading contents is a POST: it writes the audit record and needs a reason.
    if (action === 'content' && method === 'POST') {
      return ok(await operatorContent(engine.core, id, request.actor, field(request.body, 'reason')));
    }

    if (action === 'terminate' && method === 'POST') {
      const ended = await operatorTerminate(engine.core, id, request.actor, field(request.body, 'reason'));
      return ok({ id: ended.id, phase: ended.phase });
    }

    return fail(404, 'not_found', 'No such resource.');
  } catch (err) {
    if (err instanceof Refusal) return fail(STATUS_BY_CODE[err.code] ?? 400, err.code, err.message);
    engine.core.log(`operator api ${method} ${request.path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    // The detail stays in the server log.
    return fail(500, 'internal_error', 'The request could not be completed.');
  }
}

interface ExpressLikeRequest {
  method: string;
  path?: string;
  url?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): unknown;
}

/** Resolves the signed-in operator for the audit trail. */
export type ActorResolver = (cookieHeader: string | undefined) => Promise<string | undefined>;

export function router(engine: FacilitationEngine, resolveActor: ActorResolver) {
  return (req: ExpressLikeRequest, res: ExpressLikeResponse): void => {
    void (async () => {
      const cookie = req.headers['cookie'];
      // The session gate already ran; this only names the operator. An
      // operator the kernel cannot name is refused for anything audited.
      const actor = await resolveActor(Array.isArray(cookie) ? cookie.join('; ') : cookie);
      const path = req.path ?? (req.url ?? '/').split('?')[0] ?? '/';
      const audited = req.method.toUpperCase() === 'POST';
      if (audited && !actor) {
        res.status(403).json(fail(403, 'unknown_operator', 'The signed-in operator could not be identified, so this action cannot be audited.').body);
        return;
      }
      const response = await handle(engine, { method: req.method, path, query: req.query ?? {}, body: req.body, actor: actor ?? 'operator' });
      res.status(response.status).json(response.body);
    })();
  };
}
