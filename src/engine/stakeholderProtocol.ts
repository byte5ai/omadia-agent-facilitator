// The facilitation protocol as a confirmed stakeholder receives it (spec 5.8,
// 5.11; #2078 criterion 30, #2065 criteria 39, 55, 63).
//
// A stakeholder is outside the process: they get the final protocol with its
// result status and the next steps, never contributions, status or anything
// else of the running facilitation, and never a session protocol. The filter
// works on whole, separately labelled parts:
//
//   part           labels
//   header         protocol            title, result status, delivery
//   decisions      protocol            deterministic: what the methods decided
//   next steps     protocol            accepted action items
//   open points    protocol            parked topics, unaccepted nominations
//   summaries      protocol, talk      model-written: carry their turn's labels
//   clusters       protocol, talk      proposed by the model, confirmed
//   contributions  contribution        what a participant said: never
//   participants   talk                who took part
//
// What a recipient may know by disclosure level:
//
//   full       protocol, talk          everything but contributions
//   existence  protocol                plus a note that something was left out
//   none       protocol                no note, no derived summary
//
// A part whose labels the recipient may not know is withheld as a whole; it
// is never redacted.

import type { Queryable } from '../db/pool.js';
import * as store from '../db/store.js';
import type { Disclosure, Facilitation } from '../model.js';
import { formatWhen, texts } from '../texts/index.js';
import { deliveryStatusWords, listClosings, markOf, resultStatusWords } from './resultStatus.js';

export type ProtocolLabel = 'protocol' | 'talk' | 'contribution';

export const KNOWN_LABELS: Readonly<Record<Disclosure, readonly ProtocolLabel[]>> = {
  full: ['protocol', 'talk'],
  existence: ['protocol'],
  none: ['protocol'],
};

export interface ProtocolPart {
  key: 'header' | 'decisions' | 'actions' | 'open' | 'summaries' | 'clusters' | 'contributions' | 'participants';
  labels: readonly ProtocolLabel[];
  lines: string[];
}

/** The facilitation protocol in its labelled parts. */
export async function protocolParts(q: Queryable, f: Facilitation): Promise<ProtocolPart[]> {
  const t = texts(f.language);
  const p = t.protocol;
  const when = (d: Date): string => formatWhen(d, f.timezone, f.language);
  const participants = await store.listParticipants(q, f.id);
  const name = (id: string | null): string => participants.find((x) => x.principalId === id)?.displayName ?? t.unnamedPerson;
  const closing = (await listClosings(q, f.id)).find((c) => c.kind === (f.phase === 'aborted' ? 'abort' : 'result'));
  const mark = closing ? markOf(closing) : undefined;
  const items = await store.listActionItems(q, f.id);
  const steps = await store.listSteps(q, f.id);
  const section = (title: string, lines: readonly string[]): string[] => ['', `${title}:`, ...(lines.length > 0 ? lines.map((l) => `- ${l}`) : [`- ${p.none}`])];
  return [
    {
      key: 'header',
      labels: ['protocol'],
      lines: [
        p.title(f.goal),
        `${t.resultStatus.label}: ${mark ? resultStatusWords(f.language, mark) : t.resultStatus.awaiting}`,
        ...(closing?.kind === 'result' ? [`${t.resultStatus.delivery}: ${deliveryStatusWords(f.language, closing.deliveryStatus)}`] : []),
        ...(f.phase === 'aborted' && f.closeReason ? [`${p.outcome}: ${t.phase.aborted} (${f.closeReason})`] : []),
      ],
    },
    { key: 'participants', labels: ['talk'], lines: [`${p.participants}: ${participants.map((x) => x.displayName).join(', ')}`] },
    { key: 'decisions', labels: ['protocol'], lines: section(p.decisions, (await store.listDecisions(q, f.id)).map((d) => (d.rationale ? `${d.statement} (${p.rationale}: ${d.rationale})` : d.statement))) },
    {
      key: 'actions',
      labels: ['protocol'],
      lines: section(p.actions, items.filter((a) => a.status === 'confirmed' || a.status === 'done').map((a) => t.actionLine(a.number, a.description, name(a.ownerPrincipal), when(a.dueDate), t.actionStatusWords[a.status]))),
    },
    {
      key: 'open',
      labels: ['protocol'],
      lines: section(p.parked, [
        ...items.filter((a) => a.status === 'proposed').map((a) => t.notAccepted(a.number, a.description, name(a.ownerPrincipal))),
        ...(await store.listEvents(q, f.id, ['parked'])).map((e) => String(e.payload['topic'])),
      ]),
    },
    { key: 'summaries', labels: ['protocol', 'talk'], lines: section(p.summaries, (await store.listEvents(q, f.id, ['summary_confirmed'])).map((e) => String(e.payload['text']))) },
    { key: 'clusters', labels: ['protocol', 'talk'], lines: section(p.clusters, (await store.listClusters(q, f.id)).filter((c) => c.confirmed).map((c) => c.label)) },
    {
      key: 'contributions',
      labels: ['contribution'],
      lines: section(
        p.contributions,
        (await store.listContributions(q, f.id)).filter((c) => c.status === 'valid').map((c) => `${steps.find((s) => s.id === c.stepId)?.title ?? ''}: ${name(c.participantPrincipal)}: ${String(c.payload['summary'] ?? '')}`),
      ),
    },
  ];
}

/** Whether a recipient with this disclosure level may know a part. */
export const mayKnow = (disclosure: Disclosure, part: Pick<ProtocolPart, 'labels'>): boolean => part.labels.every((l) => KNOWN_LABELS[disclosure].includes(l));

/** The protocol a stakeholder receives: only the parts they may know, and
 *  a note about the rest only from `existence` up. */
export async function stakeholderProtocol(q: Queryable, f: Facilitation, disclosure: Disclosure): Promise<{ text: string; withheld: ProtocolPart['key'][] }> {
  const parts = await protocolParts(q, f);
  const kept = parts.filter((part) => mayKnow(disclosure, part));
  // A part with nothing in it is not something left out.
  const withheld = parts.filter((part) => !mayKnow(disclosure, part) && !part.lines.every((l) => l === '' || l.endsWith(`- ${texts(f.language).protocol.none}`) || l.endsWith(':')));
  const note = disclosure !== 'none' && withheld.length > 0 ? ['', texts(f.language).stakeholderPartsWithheld()] : [];
  return { text: [...kept.flatMap((part) => part.lines), ...note].join('\n'), withheld: withheld.map((part) => part.key) };
}
