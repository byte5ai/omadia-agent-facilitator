// The protocol (spec 2.2 "Record"): the path to the result, decisions with
// their rationale, open points, and action items with owner and due date.
// Built from the tables of one facilitation, deterministically.

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Closing, Facilitation, ProtocolEvent } from '../model.js';
import { lifecycleOf } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import type { Work } from './core.js';
import { facilitatorName } from './lifecycle.js';
import { initiatorName } from './names.js';
import { deliveryStatusWords, listClosings, markOf, resultStatusWords } from './resultStatus.js';

const CHANGE_EVENTS = ['proposal_accepted', 'proposal_rejected', 'runoff', 'proposal_amended'];
const CAPABILITY_EVENTS = ['capability_used', 'capability_refused', 'grant_issued', 'grant_revoked'];

/** What the group has, for the binding close. */
export async function closingSummary(w: { tx: Queryable; f: Facilitation }): Promise<{ decisions: string[]; actions: string[]; open: string[] }> {
  const t = texts(w.f.language);
  const participants = await store.listParticipants(w.tx, w.f.id);
  const name = (id: string): string => participants.find((p) => p.principalId === id)?.displayName ?? t.unnamedPerson;
  const decisions = (await store.listDecisions(w.tx, w.f.id)).map((d) => d.statement);
  const items = await store.listActionItems(w.tx, w.f.id);
  // Only what its owner accepted is an action item; a nomination nobody
  // accepted is an open point (spec 5.4, criterion 37).
  const actions = items
    .filter((a) => a.status === 'confirmed' || a.status === 'done')
    .map((a) => t.actionLine(a.number, a.description, name(a.ownerPrincipal), formatWhen(a.dueDate, w.f.timezone, w.f.language), t.actionStatusWords[a.status]));
  const open = [
    ...items.filter((a) => a.status === 'proposed').map((a) => t.notAccepted(a.number, a.description, name(a.ownerPrincipal))),
    ...(await store.listEvents(w.tx, w.f.id, ['parked'])).map((e) => String(e.payload['topic'])),
  ];
  return { decisions, actions, open };
}

export interface ProtocolOptions {
  /** Nothing after this moment is included (a participant who left). */
  until?: Date;
}

export async function buildProtocol(q: Queryable, f: Facilitation, opts: ProtocolOptions = {}): Promise<string> {
  const t = texts(f.language);
  const p = t.protocol;
  const before = <T extends { occurredAt?: Date; recordedAt?: Date; decidedAt?: Date; createdAt?: Date }>(row: T): boolean => {
    const at = row.occurredAt ?? row.recordedAt ?? row.decidedAt ?? row.createdAt;
    return !opts.until || !at || at.getTime() <= opts.until.getTime();
  };
  const when = (d: Date): string => formatWhen(d, f.timezone, f.language);
  const participants = await store.listParticipants(q, f.id);
  const name = (id: string | null): string => participants.find((x) => x.principalId === id)?.displayName ?? t.unnamedPerson;
  const steps = await store.listSteps(q, f.id);
  const dods = (await store.listDodVersions(q, f.id)).filter((d) => d.consentState === 'initial' || d.consentState === 'accepted').filter(before);
  const decisions = (await store.listDecisions(q, f.id)).filter(before);
  const clusters = (await store.listClusters(q, f.id)).filter((c) => c.confirmed).filter(before);
  const contributions = (await store.listContributions(q, f.id)).filter((c) => c.status === 'valid').filter(before);
  const actions = (await store.listActionItems(q, f.id)).filter(before);
  const events = (await store.listEvents(q, f.id)).filter(before);
  const of = (kinds: readonly string[]): ProtocolEvent[] => events.filter((e) => kinds.includes(e.kind));
  const section = (title: string, lines: readonly string[]): string[] => ['', `${title}:`, ...(lines.length > 0 ? lines.map((l) => `- ${l}`) : [`- ${p.none}`])];

  /** One change of the rules: what happened and, where there is one, to what. */
  const changeLine = (e: ProtocolEvent): string => {
    if (e.kind === 'runoff') {
      const options = steps.find((s) => s.id === e.payload['stepId'])?.options ?? [];
      const tied = (Array.isArray(e.payload['tied']) ? (e.payload['tied'] as unknown[]) : []).map((key) => options.find((o) => o.key === key)?.label ?? String(key));
      return p.runoff(t.list(tied));
    }
    const what = p.changeKinds[e.kind] ?? e.kind.replace(/_/g, ' ');
    const detail = String(e.payload['summary'] ?? e.payload['statement'] ?? '').trim();
    return detail === '' ? what : `${what}: ${detail}`;
  };

  // Every final protocol carries its result status, and separately the
  // delivery status of its closing document (spec 5.11).
  const closing = (await listClosings(q, f.id)).find((c) => c.kind === (f.phase === 'aborted' ? 'abort' : 'result'));
  const mark = closing ? markOf(closing) : undefined;
  const statusLines = closing
    ? [
        `${t.resultStatus.label}: ${mark ? resultStatusWords(f.language, mark) : t.resultStatus.awaiting}`,
        ...(closing.kind === 'result' ? [`${t.resultStatus.delivery}: ${deliveryStatusWords(f.language, closing.deliveryStatus)}`] : []),
      ]
    : [];
  return [
    p.title(f.goal),
    ...statusLines,
    `${p.facilitator}: ${facilitatorName(f)}`,
    `${p.initiator}: ${initiatorName(f, participants) ?? t.unnamedPerson}`,
    `${p.participants}: ${participants.map((x) => (x.status === 'left' ? `${x.displayName} (${p.left})` : x.displayName)).join(', ')}`,
    ...section(p.definitionOfDone, dods.map((d) => `${p.version} ${String(d.version)}: ${d.text}`)),
    ...section(p.agenda, steps.map((s) => t.agendaLine(s.position, s.title, s.timeboxMinutes))),
    ...section(
      p.contributions,
      contributions.map((c) => {
        const step = steps.find((s) => s.id === c.stepId);
        return `${step ? `${step.title}: ` : ''}${name(c.participantPrincipal)}: ${String(c.payload['summary'] ?? '')}`;
      }),
    ),
    ...section(p.clusters, clusters.map((c) => `${c.label} (${String(c.memberContributionIds.length)})`)),
    ...section(p.summaries, of(['summary_confirmed']).map((e) => String(e.payload['text']))),
    ...section(p.decisions, decisions.map((d) => (d.rationale ? `${d.statement} (${p.rationale}: ${d.rationale})` : d.statement))),
    ...section(p.actions, actions.filter((a) => a.status === 'confirmed' || a.status === 'done').map((a) => t.actionLine(a.number, a.description, name(a.ownerPrincipal), when(a.dueDate), t.actionStatusWords[a.status]))),
    ...section(p.parked, [
      ...actions.filter((a) => a.status === 'proposed').map((a) => t.notAccepted(a.number, a.description, name(a.ownerPrincipal))),
      ...of(['parked']).map((e) => String(e.payload['topic'])),
    ]),
    ...section(p.changes, of(CHANGE_EVENTS).map((e) => `${when(e.occurredAt)}: ${changeLine(e)}`)),
    ...section(p.capabilities, of(CAPABILITY_EVENTS).map((e) => `${when(e.occurredAt)}: ${String(e.payload['summary'] ?? e.kind)}`)),
    '',
    `${p.outcome}: ${t.phase[lifecycleOf(f)]}${f.closeReason && f.phase === 'aborted' ? ` (${f.closeReason})` : ''}`,
  ].join('\n');
}

/**
 * Send somebody what they are owed with the protocol, privately.
 *
 * A facilitator can write privately only to people who have its app, so a
 * private message that cannot arrive is the normal case, not an error. Then
 * the protocol stands in the group, once, with one short line: nobody is
 * pointed at a private message that will not come, and nobody is named.
 */
export function sendWithProtocol(w: Work, to: { principalId: string }, message: { purpose: string; key: string; text: string }, protocol: string, closing?: Pick<Closing, 'id' | 'documentVersion'>): void {
  // Part of a closing: sent inside its dispatch limit, whatever the state is by then.
  const ofClosing = closing ? { closing: { id: closing.id, version: closing.documentVersion } } : {};
  const inGroup = { purpose: 'protocol_in_group', key: 'once', deliveryClass: 'essential' as const, text: texts(w.f.language).protocolInGroup(protocol) };
  // Who could not be reached before is not tried again.
  if ((w.f.settings.unreachable ?? []).includes(to.principalId)) {
    w.post({ purpose: inGroup.purpose, key: inGroup.key, to: 'group', deliveryClass: 'essential', text: inGroup.text, ...ofClosing });
    return;
  }
  w.post({ ...message, to, deliveryClass: 'essential', fallback: inGroup, ...ofClosing });
}
