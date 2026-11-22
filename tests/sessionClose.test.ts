// The binding close of a session and sessions at the end of a facilitation
// (spec 5.2, 5.3, 6.3; #2076; criteria 3, 38, 49, 51).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS, MINUTE_MS } from '../src/clock.js';
import * as store from '../src/db/store.js';
import { listClosings } from '../src/engine/resultStatus.js';
import type { Session } from '../src/model.js';
import { ANNA, BERT, CARA, createHarness, passWindow } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness({ start: '2026-11-20T09:00:00Z' });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const posts = (conv: string): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
const tool = (conv: string, name: string, args: Record<string, unknown> = {}): Promise<string> => h.tool(name, args, { conversation: conv });
async function say(conv: string, who: string, text: string, opts = {}) {
  const record = await h.kernel.say(conv, who, text, opts);
  await h.settle();
  return record;
}
const inMinutes = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * MINUTE_MS).toISOString();
const sessionNamed = async (facilitationId: string, title: string): Promise<Session | undefined> => (await store.listSessions(h.db.pool, facilitationId)).find((s) => s.title === title);
const held = (conversationId: string): boolean => h.kernel.reservations.some((r) => r.conversationId === conversationId && r.releasedAt === undefined);

/**
 * A facilitation whose definition of done is free text (so a session
 * summary needs the group's confirmation), with three sessions in three
 * linked meeting chats: Alpha (later), Beta (next) and Gamma (first).
 */
async function threeSessions(name: string) {
  const home = h.kernel.conversation(`${name}-home`, [ANNA, BERT, CARA]);
  const goal = `Team charter ${name}`;
  await tool(home, 'facilitation_start', { goal, definitionOfDone: 'Everybody can live with the charter', agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'discuss', title: 'Discuss' }] });
  await tool(home, 'facilitation_open');
  const chats: Record<string, string> = {};
  for (const [title, start] of [['Alpha call', 300], ['Beta call', 120], ['Gamma call', 60]] as const) {
    await tool(home, 'facilitation_session', { action: 'schedule', title, start: inMinutes(start), modality: 'online' });
    const chat = h.kernel.conversation(`${name}-${title.split(' ')[0]?.toLowerCase() ?? ''}`, [ANNA, BERT, CARA]);
    chats[title] = chat;
    await h.kernel.linkRequest(chat, 'anna', `@mira link this chat to ${goal} for ${title}`);
    await h.settle();
  }
  const f = await h.facilitation(home);
  return { home, f, alpha: chats['Alpha call'] as string, beta: chats['Beta call'] as string, gamma: chats['Gamma call'] as string };
}

test('criteria 3 and 38: a session ends with its frozen summary as its own closing event; a failed send is retried with the same document version after later changes and a restart', { skip: PG_SKIP }, async () => {
  const { home, f, gamma } = await threeSessions('sc38');
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Gamma call'))?.status, 'live');
  await say(gamma, 'bert', 'Respect');
  // The summary's first send fails.
  h.kernel.sendFaults.push({ code: 'channel_error', message: 'the channel is down' });
  await tool(home, 'facilitation_session', { action: 'end' });
  const gammaSession = await sessionNamed(f.id, 'Gamma call');
  assert.equal(gammaSession?.status, 'confirming', 'a free-text definition of done: the summary needs confirmation');
  const [closing] = (await listClosings(h.db.pool, f.id)).filter((c) => c.sessionId === gammaSession?.id);
  assert.deepEqual([closing?.kind, closing?.eventId, closing?.documentVersion, closing?.requiresConfirmation, closing?.deliveryStatus], ['session', `session:${gammaSession?.id ?? ''}`, 1, true, 'pending']);
  const version = (await h.facilitation(home)).stateVersion;
  // Contributions and a phase-relevant change follow; then a restart.
  await say(home, 'cara', 'Openness');
  await tool(home, 'facilitation_step', { action: 'close' });
  assert.ok((await h.facilitation(home)).stateVersion > version);
  await h.restart();
  h.clock.advance(MINUTE_MS);
  await h.tick();
  const delivered = h.kernel.groupPosts(gamma).filter((p) => p.text.startsWith('Summary of the session "Gamma call"'));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.text, `${closing?.document ?? ''}\n\nPlease confirm this summary: reply "agreed", or "objection: <reason>" to this message. Without an objection it counts as confirmed on ${delivered[0]?.text.match(/confirmed on (.*)\.$/)?.[1] ?? ''}.`);
  const outbox = await h.db.pool.query<{ closing_id: string; document_version: number; required_state_version: number | null }>(
    `SELECT closing_id, document_version, required_state_version FROM plg_omadia_agent_facilitator_outbox WHERE facilitation_id = $1 AND purpose = 'session_summary'`,
    [f.id],
  );
  assert.deepEqual(outbox.rows.map((r) => [r.closing_id, r.document_version, r.required_state_version]), [[closing?.id, 1, null]]);
  const after = (await listClosings(h.db.pool, f.id)).find((c) => c.id === closing?.id);
  assert.deepEqual([after?.deliveryStatus, after?.part], ['delivered', 'confirmation']);
});

test('criterion 51 and 49 (regular close): a summary that awaits confirmation outlives the conclusion; an objection after a restart counts; only then is its chat free', { skip: PG_SKIP }, async () => {
  const { home, f, alpha, gamma } = await threeSessions('sc51');
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  await tool(home, 'facilitation_session', { action: 'end' });
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Gamma call'))?.status, 'confirming');
  h.clock.advance(60 * MINUTE_MS);
  await h.tick();
  assert.equal((await sessionNamed(f.id, 'Beta call'))?.status, 'live');

  // The facilitation concludes: the scheduled session is cancelled with a
  // note in its chat, the live one closes with its summary, the confirming
  // one keeps its window.
  const proposed = (): boolean => /^Proposal: /.test(posts(home).at(-1) ?? '');
  for (let i = 0; i < 6 && !proposed() && (await h.facilitation(home)).phase === 'active'; i++) await tool(home, 'facilitation_step', { action: 'close' });
  if (proposed()) {
    for (const who of ['anna', 'bert', 'cara']) await say(home, who, 'agreed');
    await passWindow(h, home);
  }
  const phase = (await h.facilitation(home)).phase;
  assert.ok(phase === 'concluding' || phase === 'closed', phase);
  assert.equal((await sessionNamed(f.id, 'Alpha call'))?.status, 'cancelled');
  assert.match(posts(alpha).at(-1) ?? '', /^The session "Alpha call" does not take place/);
  assert.equal(held(alpha), false);
  assert.equal((await sessionNamed(f.id, 'Gamma call'))?.status, 'confirming');
  assert.equal(held(gamma), true, 'a confirming session keeps its chat until its confirmation has ended');

  await h.restart();
  await say(gamma, 'bert', 'objection: we never agreed on the second value');
  assert.match(posts(gamma).at(-1) ?? '', /^Objection from Bert: we never agreed on the second value/);
  h.clock.advance(25 * HOUR_MS);
  await h.tick();
  const gammaSession = await sessionNamed(f.id, 'Gamma call');
  assert.equal(gammaSession?.status, 'closed');
  const closing = (await listClosings(h.db.pool, f.id)).find((c) => c.sessionId === gammaSession?.id);
  assert.deepEqual([closing?.resultStatus, closing?.resultReason, closing?.part], ['not_confirmed', 'objection', 'done']);
  assert.match(posts(gamma).at(-1) ?? '', /^The summary of "Gamma call" stands as: not confirmed \(/);
  assert.equal(held(gamma), false, 'free once its confirmation has ended');
  // The ended process receives nothing new there.
  const count = h.kernel.events.length;
  await say(gamma, 'cara', 'one more thing');
  assert.equal(h.kernel.events.filter((e) => (e as { processId?: string }).processId === f.id).length, h.kernel.events.slice(0, count).filter((e) => (e as { processId?: string }).processId === f.id).length);
});

test('criterion 49 (stop): scheduled sessions are cancelled, a live one closes without a consent request, a confirming one ends marked; every chat is free at once', { skip: PG_SKIP }, async () => {
  const { home, f, alpha, beta, gamma } = await threeSessions('sc49');
  h.clock.advance(61 * MINUTE_MS);
  await h.tick();
  await tool(home, 'facilitation_session', { action: 'end' });
  await h.tick();
  h.clock.advance(60 * MINUTE_MS);
  await h.tick();
  assert.deepEqual(
    [(await sessionNamed(f.id, 'Alpha call'))?.status, (await sessionNamed(f.id, 'Beta call'))?.status, (await sessionNamed(f.id, 'Gamma call'))?.status],
    ['scheduled', 'live', 'confirming'],
  );
  await h.restart();
  await say(home, 'anna', 'stop');
  assert.equal((await h.facilitation(home)).phase, 'aborted');
  await h.tick();
  assert.deepEqual(
    [(await sessionNamed(f.id, 'Alpha call'))?.status, (await sessionNamed(f.id, 'Beta call'))?.status, (await sessionNamed(f.id, 'Gamma call'))?.status],
    ['cancelled', 'closed', 'closed'],
  );
  assert.match(posts(alpha).at(-1) ?? '', /^The session "Alpha call" does not take place/);
  const betaSummary = posts(beta).find((t) => t.includes('Summary of the session "Beta call"')) ?? '';
  assert.match(betaSummary, /^Result status: not confirmed \(.*\)\n\nSummary of the session "Beta call"/s);
  assert.doesNotMatch(betaSummary, /Please confirm/, 'no consent request that can no longer be answered');
  const gammaFinal = posts(gamma).at(-1) ?? '';
  assert.match(gammaFinal, /^Result status: not confirmed \(.*\)\n\nSummary of the session "Gamma call"/s);
  assert.doesNotMatch(gammaFinal, /Please confirm/);
  for (const chat of [alpha, beta, gamma]) {
    assert.equal(held(chat), false, `${chat} is free`);
    assert.equal(h.kernel.modeOf(f.id, chat), undefined);
  }
  const closings = await listClosings(h.db.pool, f.id);
  assert.ok(closings.filter((c) => c.kind === 'session' && c.sessionId !== null).every((c) => c.resultStatus !== null));
});

test('criterion 59: at the deadline the last session closes and the evaluation waits for its confirmation; an objection ends it with an abort report naming it, also across a restart; both orders of the two jobs due at the deadline', { skip: PG_SKIP }, async () => {
  for (const [outcome, order] of [['objection', 'deadline first'], ['consent', 'deadline first'], ['objection', 'session end first'], ['consent', 'session end first']] as const) {
    const name = `sc59-${outcome}-${order.split(' ')[0] ?? ''}`;
    const home = h.kernel.conversation(`${name}-home`, [ANNA, BERT, CARA]);
    const chat = h.kernel.conversation(`${name}-chat`, [ANNA, BERT, CARA]);
    const goal = `Charter ${name}`;
    const deadline = inMinutes(180);
    await tool(home, 'facilitation_start', { goal, definitionOfDone: 'Everybody can live with the charter', deadline, agenda: [{ kind: 'collect', title: 'Values' }, { kind: 'discuss', title: 'Discuss' }] });
    await tool(home, 'facilitation_open');
    await tool(home, 'facilitation_session', { action: 'schedule', title: 'Last call', start: inMinutes(60), end: deadline, modality: 'online' });
    await h.kernel.linkRequest(chat, 'anna', `@mira link this chat to ${goal}`);
    await h.settle();
    const f = await h.facilitation(home);
    h.clock.advance(61 * MINUTE_MS);
    await h.tick();
    assert.equal((await sessionNamed(f.id, 'Last call'))?.status, 'live');
    // Both jobs are due at the same moment; the scheduler takes them by their
    // sequence. Put the session's end in front of the deadline, or behind it.
    const seqs = await h.db.pool.query<{ kind: string; seq: string }>(
      `SELECT kind, seq FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND status = 'pending' AND kind IN ('deadline', 'session_end')`,
      [f.id],
    );
    const seqOf = (kind: string): number => Number(seqs.rows.find((r) => r.kind === kind)?.seq);
    const [first, second] = order === 'deadline first' ? ['deadline', 'session_end'] : ['session_end', 'deadline'];
    await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_jobs SET seq = $3 WHERE facilitation_id = $1 AND kind = $2 AND status = 'pending'`, [f.id, first, Math.min(seqOf('deadline'), seqOf('session_end'))]);
    await h.db.pool.query(`UPDATE plg_omadia_agent_facilitator_jobs SET seq = $3 WHERE facilitation_id = $1 AND kind = $2 AND status = 'pending'`, [f.id, second, Math.max(seqOf('deadline'), seqOf('session_end'))]);
    // The deadline: the session closes, its summary needs confirmation, the evaluation waits.
    h.clock.advance(120 * MINUTE_MS);
    await h.tick();
    await h.tick();
    assert.equal((await sessionNamed(f.id, 'Last call'))?.status, 'confirming');
    assert.equal((await h.facilitation(home)).phase, 'active', 'waiting, not evaluated');
    assert.equal((await h.facilitation(home)).settings.deadlineWait, true);
    // Across the kernel boundary (ADR 0030): the session's closing scope is
    // open before the kernel holds the active scope in its wait, and the wait
    // ends at the latest with that closing's limit.
    const closingScope = h.kernel.scopes.find((s) => s.processId === f.id && s.kind === 'closing' && s.eventId.startsWith('session:'));
    const activeScope = h.kernel.scopes.find((s) => s.processId === f.id && s.kind === 'active');
    assert.equal(closingScope?.state, 'open');
    assert.equal(activeScope?.deadlineWait, true, 'the kernel holds the moderation in its deadline wait');
    assert.ok(Date.parse(activeScope?.deadline ?? '') <= Date.parse(closingScope?.absoluteLimit ?? ''));
    assert.ok(h.kernel.waitRequests.filter((r) => r.processId === f.id).every((r) => r.openClosings > 0), 'the wait is never asked for before its closing is open');
    assert.ok(h.kernel.openedWithEventAt.some((o) => o.kind === 'closing' && o.eventId === closingScope?.eventId && o.eventAt !== undefined), 'the closing names its event');
    // Meanwhile nothing else changes.
    const before = (await store.listContributions(h.db.pool, f.id)).length;
    await say(home, 'cara', 'One more value');
    assert.equal((await store.listContributions(h.db.pool, f.id)).length, before);
    await h.restart();
    if (outcome === 'objection') await say(chat, 'bert', 'objection: that is not what we said');
    h.clock.advance(25 * HOUR_MS);
    await h.tick();
    await h.tick();
    const after = await h.facilitation(home);
    if (outcome === 'objection') {
      assert.equal(after.phase, 'aborted');
      assert.match(after.closeReason ?? '', /the summary of the session "Last call" is not confirmed/);
    } else {
      assert.notEqual(after.phase, 'active', 'evaluated once the confirmation ended');
      assert.doesNotMatch(after.closeReason ?? '', /summary of the session/);
    }
    assert.equal(after.settings.deadlineWait, undefined);
  }
});
