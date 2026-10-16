// 0.6.0 — durable facilitation state through the tools: a "restart" is a
// fresh store + toolkit against the same fake kernel.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { FacilitationStateStore } from '../src/stateStore.js';
import { facilitationRoleKey } from '../src/toolkit.js';
import { buildTools, fakeKernel, oldKernel } from './fakeKernel.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-10-15T11:30:00.000Z');
const now = (): Date => NOW;

describe('restart round trip', () => {
  it('goal, DoD, progress and nudge count survive a restart (no conversationId needed)', async () => {
    const kernel = fakeKernel();
    const before = buildTools({ ephemeralRuns: kernel.service });
    await before.call('facilitation_start', { goal: 'Termin finden', definitionOfDone: 'Ein Termin ist bestätigt', conversationId: 'grp-1' });
    await before.call('facilitation_nudge', { text: 'Wer fehlt noch?', conversationId: 'grp-1' });
    await before.call('facilitation_nudge', { text: 'Noch zwei Stimmen.', conversationId: 'grp-1' });
    await before.call('facilitation_progress', { dodMet: false, summary: '4/6 abgestimmt', conversationId: 'grp-1' });

    const after = buildTools({ ephemeralRuns: kernel.service });
    const status = await after.call('facilitation_status');
    assert.ok(status.includes('Facilitation-Status: active'), status);
    assert.ok(status.includes('Ziel: Termin finden'), status);
    assert.ok(status.includes('Definition of Done: Ein Termin ist bestätigt'), status);
    assert.ok(status.includes('4/6 abgestimmt'), status);
    assert.ok(status.includes('Nudges: 2/12'), status);
    assert.equal(after.store.get('grp-1')?.nudgesSent, 2);
  });

  it('the nudge cap counts persisted nudges — a restart does not hand out fresh slots', async () => {
    const kernel = fakeKernel();
    const before = buildTools({ ephemeralRuns: kernel.service });
    await before.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    kernel.runs.get('run-1')!.state = { v: 1, phase: 'active', nudgesSent: 12 };

    const after = buildTools({ ephemeralRuns: kernel.service });
    const out = await after.call('facilitation_nudge', { text: 'x', conversationId: 'grp-1' });
    assert.ok(out.includes('Nudge-Limit erreicht'), out);
    assert.deepEqual(after.nudges, []);
  });

  it('an explicit conversationId that misses triggers one kernel re-read', async () => {
    const kernel = fakeKernel();
    const tools = buildTools({ ephemeralRuns: kernel.service });
    await tools.call('facilitation_status'); // hydration pass: nothing yet
    // Another process started a facilitation after our pass.
    await kernel.service.createEphemeralRun({
      agentId: '@omadia/agent-facilitator',
      patternId: 'facilitation',
      slots: {},
      payload: { goal: 'late', definitionOfDone: 'd', conversationId: 'grp-late' },
    });
    const status = await tools.call('facilitation_status', { conversationId: 'grp-late' });
    assert.ok(status.includes('Ziel: late'), status);
  });
});

describe('facilitation_start — deadline', () => {
  it('derives the TTL from the stated deadline (+2h grace) and carries it in the payload', async () => {
    const kernel = fakeKernel({ now });
    const tools = buildTools({ ephemeralRuns: kernel.service, now, config: { defaultTtlHours: 18 } });
    // Incident shape: 18h default TTL, vote deadline 22.5h out.
    const out = await tools.call('facilitation_start', {
      goal: 'Abstimmung',
      definitionOfDone: 'Alle haben abgestimmt',
      conversationId: 'grp-1',
      deadline: '2026-10-16T12:00:00+02:00',
    });
    const run = kernel.runs.get('run-1')!;
    assert.equal(run.ttlMs, Math.round((22.5 + 2) * HOUR_MS));
    assert.equal(run.payload.deadline, '2026-10-16T12:00:00+02:00');
    assert.equal(run.payload.conversationId, 'grp-1');
    assert.equal(run.payload.initiatorRoleKey, 'facilitation-initiator');
    assert.ok(out.includes('Deadline: 2026-10-16T12:00:00+02:00'), out);
    assert.ok(out.includes('Workflow-Laufzeit (TTL) bis:'), out);
    assert.ok(!out.includes('Achtung'), out);
  });

  it('refuses past and offset-less deadlines without creating a run', async () => {
    const kernel = fakeKernel({ now });
    const tools = buildTools({ ephemeralRuns: kernel.service, now });
    const past = await tools.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'c', deadline: '2026-10-14T10:00:00Z' });
    assert.ok(past.includes('Vergangenheit'), past);
    const local = await tools.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'c', deadline: '2026-10-16T15:00' });
    assert.ok(local.includes('Zeitzone'), local);
    assert.equal(kernel.runs.size, 0);
  });

  it('warns honestly when the kernel clamps the lifetime below the deadline', async () => {
    const kernel = fakeKernel({ now, maxTtlMs: 10 * HOUR_MS });
    const tools = buildTools({ ephemeralRuns: kernel.service, now });
    const out = await tools.call('facilitation_start', {
      goal: 'g',
      definitionOfDone: 'd',
      conversationId: 'grp-1',
      deadline: '2026-10-16T10:00:00Z',
    });
    assert.ok(out.includes('Achtung: Der Kernel hat die Laufzeit begrenzt'), out);
    assert.ok(out.includes('VOR der Deadline'), out);
  });

  it('allowlists the conversationId: no braces, whitespace, control chars, overlong ids or the reserved run: prefix', async () => {
    const kernel = fakeKernel();
    const tools = buildTools({ ephemeralRuns: kernel.service });
    for (const bad of ['x{{ctx.goal}}', 'a b', 'a\nb', 'run:abc', 'x'.repeat(257), 'quote"d']) {
      const out = await tools.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: bad });
      assert.ok(out.includes('ungültig'), `${JSON.stringify(bad)} → ${out}`);
    }
    assert.equal(kernel.runs.size, 0);
    const teams = await tools.call('facilitation_start', {
      goal: 'g',
      definitionOfDone: 'd',
      conversationId: '19:abc-DEF_123@thread.v2;messageid=1729',
    });
    assert.ok(teams.includes('Ziel: g'), teams);
  });

  it('works unchanged against an old kernel (no durable-state methods)', async () => {
    const kernel = fakeKernel();
    const tools = buildTools({ ephemeralRuns: oldKernel(kernel.service) });
    const out = await tools.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    assert.ok(out.includes('Ziel: g'), out);
    await tools.call('facilitation_progress', { dodMet: false, summary: 's', conversationId: 'grp-1' });
    assert.deepEqual(kernel.saves, []);
    assert.equal(tools.store.get('grp-1')?.progress?.summary, 's');
  });
});

describe('facilitation_stop — report, cancel, mark', () => {
  it('reports first, then cancels the run, then marks stopped — no state write after a cancel', async () => {
    const events: string[] = [];
    const kernel = fakeKernel({ events });
    const tools = buildTools({ ephemeralRuns: kernel.service, events });
    await tools.call('facilitation_start', { goal: 'Ziel X', definitionOfDone: 'd', conversationId: 'grp-1' });
    await tools.call('facilitation_progress', { dodMet: false, summary: '3/5 erledigt', conversationId: 'grp-1' });
    events.length = 0;

    const out = await tools.call('facilitation_stop', { conversationId: 'grp-1' });
    assert.deepEqual(events, ['report', 'cancel']);
    assert.equal(kernel.runs.get('run-1')!.status, 'cancelled');
    assert.equal(tools.store.get('grp-1')?.phase, 'stopped');
    assert.ok(out.includes('wurde abgebrochen'), out);
    assert.ok(!out.includes('läuft bis'), out);
    assert.ok(tools.reports[0]!.text.includes('3/5 erledigt'));
    assert.ok(tools.reports[0]!.text.includes('Ziel X'));
  });

  it('old kernel: says the run continues and persists nothing it cannot', async () => {
    const kernel = fakeKernel();
    const tools = buildTools({ ephemeralRuns: oldKernel(kernel.service) });
    await tools.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    const out = await tools.call('facilitation_stop', { conversationId: 'grp-1' });
    assert.ok(out.includes('Deadline/TTL weiter'), out);
    assert.equal(tools.store.get('grp-1')?.phase, 'stopped');
    assert.equal(tools.reports.length, 1);
  });

  it('a failed cancel persists the stop — after a restart the facilitation stays stopped', async () => {
    const kernel = fakeKernel();
    const failingCancel = {
      ...kernel.service,
      cancelOwnRun: async () => {
        throw new Error('db down');
      },
    };
    const before = buildTools({ ephemeralRuns: failingCancel });
    await before.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    const out = await before.call('facilitation_stop', { conversationId: 'grp-1' });
    assert.ok(out.includes('konnte nicht abgebrochen werden'), out);
    assert.equal(kernel.runs.get('run-1')!.state?.phase, 'stopped');

    const after = buildTools({ ephemeralRuns: kernel.service });
    const status = await after.call('facilitation_status', { conversationId: 'grp-1' });
    assert.ok(status.includes('Facilitation-Status: stopped'), status);
    const progress = await after.call('facilitation_progress', { dodMet: false, summary: 's', conversationId: 'grp-1' });
    assert.ok(progress.includes('Keine aktive Facilitation'), progress);
  });
});

describe('facilitation_report — roleKey by conversationId', () => {
  it('reports to the named conversation’s initiator role, not the most recent one', async () => {
    const kernel = fakeKernel();
    let tick = 0;
    const store = new FacilitationStateStore(() => new Date(1_760_000_000_000 + tick++ * 1000));
    const tools = buildTools({ ephemeralRuns: kernel.service, store });
    await tools.call('facilitation_start', { goal: 'g1', definitionOfDone: 'd', conversationId: 'c1' });
    await tools.call('facilitation_start', { goal: 'g2', definitionOfDone: 'd', conversationId: 'c2' });
    // Per-conversation roles as facilitation_start provisions them with an inviter.
    (store.get('c1') as { roleKey?: string }).roleKey = facilitationRoleKey('c1');
    (store.get('c2') as { roleKey?: string }).roleKey = facilitationRoleKey('c2');
    store.recordProgress('c2', { dodMet: false, summary: 'newest' });

    await tools.call('facilitation_report', { kind: 'final', text: 'Ergebnis c1', conversationId: 'c1' });
    assert.equal(tools.reports[0]!.principal, `role:${facilitationRoleKey('c1')}`);

    await tools.call('facilitation_report', { kind: 'final', text: 'ohne id' });
    assert.equal(tools.reports[1]!.principal, `role:${facilitationRoleKey('c2')}`);
  });

  it('an unknown explicit conversationId is refused — never redirected to latest()', async () => {
    const kernel = fakeKernel();
    const tools = buildTools({ ephemeralRuns: kernel.service });
    await tools.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'c1' });
    (tools.store.get('c1') as { roleKey?: string }).roleKey = facilitationRoleKey('c1');
    const out = await tools.call('facilitation_report', { kind: 'final', text: 'x', conversationId: 'unknown' });
    assert.ok(out.includes('Report abgelehnt'), out);
    assert.equal(tools.reports.length, 0);
  });

  it('a known record without its own role reports to the configured default', async () => {
    const kernel = fakeKernel();
    let tick = 0;
    const store = new FacilitationStateStore(() => new Date(1_760_000_000_000 + tick++ * 1000));
    const tools = buildTools({ ephemeralRuns: kernel.service, store });
    store.restore({ conversationId: 'no-role', phase: 'active', runId: 'run-x' });
    store.restore({ conversationId: 'other', phase: 'active', runId: 'run-y', roleKey: 'facilitation-other' }); // latest
    await tools.call('facilitation_report', { kind: 'final', text: 'x', conversationId: 'no-role' });
    assert.equal(tools.reports[0]!.principal, 'role:facilitation-initiator');
  });
});

describe('review guards', () => {
  it('stop with two active facilitations and no conversationId refuses instead of cancelling a guess', async () => {
    const kernel = fakeKernel();
    const tools = buildTools({ ephemeralRuns: kernel.service });
    await tools.call('facilitation_start', { goal: 'g1', definitionOfDone: 'd', conversationId: 'c1' });
    await tools.call('facilitation_start', { goal: 'g2', definitionOfDone: 'd', conversationId: 'c2' });
    const out = await tools.call('facilitation_stop');
    assert.ok(out.includes('conversationId'), out);
    assert.equal(kernel.runs.get('run-1')!.status, 'running');
    assert.equal(kernel.runs.get('run-2')!.status, 'running');
    assert.equal(tools.reports.length, 0);

    await tools.call('facilitation_stop', { conversationId: 'c2' });
    assert.equal(kernel.runs.get('run-2')!.status, 'cancelled');
    assert.equal(kernel.runs.get('run-1')!.status, 'running');
  });

  it('caps the progress summary so the persisted state stays well below 16 KiB', async () => {
    const kernel = fakeKernel();
    const tools = buildTools({ ephemeralRuns: kernel.service });
    await tools.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'c1' });
    await tools.call('facilitation_progress', { dodMet: false, summary: 'ä'.repeat(20_000), conversationId: 'c1' });
    assert.equal(tools.store.get('c1')?.progress?.summary.length, 1000);
    const state = kernel.runs.get('run-1')!.state!;
    assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') < 16 * 1024);
  });
});
