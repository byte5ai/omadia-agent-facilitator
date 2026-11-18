// 0.7.0 — regressions from the 2026-11-17 field report (a vote moderated in
// a Teams group chat): three hourly runs nudged one conversation, twelve
// reminders in a day (three after midnight, after everyone had voted), the
// definition of done could only be corrected by a restart, and nobody could
// say who had not voted yet.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseConfig, parseQuietHours } from '../src/config.js';
import { checkNudgePolicy, isQuietHour, localHour } from '../src/nudgePolicy.js';
import { buildParticipantOverview } from '../src/participants.js';
import type { ConversationRostersService } from '../src/services.js';
import type { FacilitationRecord } from '../src/stateStore.js';
import { buildTools, fakeKernel } from './fakeKernel.js';

const HOUR_MS = 60 * 60 * 1000;
// 11:00 Berlin (CET) — outside the default quiet window.
const NOON = new Date('2026-11-17T10:00:00.000Z');

function clock(start: Date): { now: () => Date; advance: (ms: number) => void } {
  let current = start.getTime();
  return { now: () => new Date(current), advance: (ms) => (current += ms) };
}

const POLICY = { nudgeMinIntervalHours: 4, nudgeQuietHours: { startHour: 20, endHour: 8 }, timezone: 'Europe/Berlin' };

function activeRecord(patch: Partial<FacilitationRecord> = {}): FacilitationRecord {
  return { conversationId: 'grp-1', phase: 'active', createdAt: NOON.toISOString(), updatedAt: NOON.toISOString(), ...patch };
}

describe('nudge policy', () => {
  it('lets a first nudge through during the day', () => {
    assert.equal(checkNudgePolicy(activeRecord(), POLICY, NOON), undefined);
  });

  it('refuses once the definition of done is recorded as met', () => {
    const record = activeRecord({ progress: { dodMet: true, summary: 'alle vier haben abgestimmt', updatedAt: '2026-11-17T06:00:00.000Z' } });
    assert.equal(checkNudgePolicy(record, POLICY, NOON)?.reason, 'dod_met');
  });

  it('refuses after the stated deadline', () => {
    const record = activeRecord({ deadline: '2026-11-17T10:00:00+01:00' });
    assert.equal(checkNudgePolicy(record, POLICY, NOON)?.reason, 'deadline_passed');
  });

  it('keeps the minimum spacing between two nudges and names the next slot', () => {
    const record = activeRecord({ lastNudge: { at: '2026-11-17T08:00:00.000Z', text: 'x' } });
    const refusal = checkNudgePolicy(record, POLICY, NOON);
    assert.deepEqual(refusal, { reason: 'too_soon', nextAllowedAt: '2026-11-17T12:00:00.000Z', sinceStart: false });
    assert.equal(checkNudgePolicy(record, POLICY, new Date('2026-11-17T12:00:00.000Z')), undefined);
  });

  it('counts the spacing from the start while no nudge was sent yet', () => {
    const record = activeRecord({ startedAt: '2026-11-17T09:59:35.000Z' });
    assert.deepEqual(checkNudgePolicy(record, POLICY, NOON), {
      reason: 'too_soon',
      nextAllowedAt: '2026-11-17T13:59:35.000Z',
      sinceStart: true,
    });
    // A run restored from before 0.7.1 carries no start time and is not held back.
    assert.equal(checkNudgePolicy(activeRecord(), POLICY, NOON), undefined);
  });

  it('refuses during quiet hours in the configured timezone, across midnight', () => {
    // 00:18 Berlin — the reminder that triggered the complaint.
    const night = new Date('2026-11-17T23:18:00.000Z');
    assert.equal(localHour(night, 'Europe/Berlin'), 0);
    assert.equal(checkNudgePolicy(activeRecord(), POLICY, night)?.reason, 'quiet_hours');
    assert.equal(checkNudgePolicy(activeRecord(), { ...POLICY, nudgeQuietHours: undefined }, night), undefined);
  });

  it('reads quiet windows that wrap midnight and ones that do not', () => {
    assert.equal(isQuietHour(23, { startHour: 20, endHour: 8 }), true);
    assert.equal(isQuietHour(7, { startHour: 20, endHour: 8 }), true);
    assert.equal(isQuietHour(8, { startHour: 20, endHour: 8 }), false);
    assert.equal(isQuietHour(13, { startHour: 12, endHour: 14 }), true);
    assert.equal(isQuietHour(14, { startHour: 12, endHour: 14 }), false);
  });
});

describe('nudge config', () => {
  it('parses quiet hours and rejects malformed windows', () => {
    assert.deepEqual(parseQuietHours('22-07'), { startHour: 22, endHour: 7 });
    assert.equal(parseQuietHours('off'), undefined);
    assert.equal(parseQuietHours('25-3'), 'invalid');
    assert.equal(parseQuietHours('8-8'), 'invalid');
    assert.equal(parseQuietHours('abends'), 'invalid');
  });

  it('falls back to the defaults on invalid values and logs each one', () => {
    const logs: string[] = [];
    const values: Record<string, unknown> = { nudge_min_interval_hours: '-1', nudge_quiet_hours: 'nachts', timezone: 'Mars/Olympus' };
    const config = parseConfig(<T>(key: string) => values[key] as T | undefined, (msg) => logs.push(msg));
    assert.equal(config.nudgeMinIntervalHours, 4);
    assert.deepEqual(config.nudgeQuietHours, { startHour: 20, endHour: 8 });
    assert.equal(config.timezone, 'Europe/Berlin');
    assert.equal(logs.length, 3);
  });

  it('accepts an operator who switches the discipline off', () => {
    const values: Record<string, unknown> = { nudge_min_interval_hours: '0', nudge_quiet_hours: 'off' };
    const config = parseConfig(<T>(key: string) => values[key] as T | undefined);
    assert.equal(config.nudgeMinIntervalHours, 0);
    assert.equal(config.nudgeQuietHours, undefined);
  });
});

describe('facilitation_nudge — discipline through the tool', () => {
  it('sends at most one nudge per interval and records the delivered text for the status', async () => {
    const time = clock(NOON);
    const kernel = fakeKernel({ now: time.now });
    const t = buildTools({ ephemeralRuns: kernel.service, now: time.now, config: POLICY });
    await t.call('facilitation_start', { goal: 'Safeword wählen', definitionOfDone: 'Alle vier haben abgestimmt', conversationId: 'grp-1' });

    // 0.7.1 — the first tick ran 25 s after the handshake and nudged at once.
    time.advance(25 * 1000);
    const early = await t.call('facilitation_nudge', { text: 'Noch keine Stimme.', conversationId: 'grp-1' });
    assert.ok(early.includes('gerade erst gestartet'), early);
    assert.ok(early.includes('15:00 Uhr (Europe/Berlin)'), early);
    assert.equal(t.nudges.length, 0);

    time.advance(4 * HOUR_MS);
    assert.ok((await t.call('facilitation_nudge', { text: 'Eine Stimme fehlt noch.', conversationId: 'grp-1' })).includes('Nudge gesendet (1/12)'));
    time.advance(HOUR_MS);
    const second = await t.call('facilitation_nudge', { text: 'Und jetzt?', conversationId: 'grp-1' });
    assert.ok(second.includes('zu frisch'), second);
    assert.equal(t.nudges.length, 1);
    assert.equal(t.store.get('grp-1')?.nudgesSent, 1, 'a refused nudge burns no slot');

    const status = await t.call('facilitation_status', { conversationId: 'grp-1' });
    assert.ok(status.includes('Letzter Nudge in den Gruppen-Chat'), status);
    assert.ok(status.includes('Eine Stimme fehlt noch.'), status);

    time.advance(3 * HOUR_MS);
    assert.ok((await t.call('facilitation_nudge', { text: 'Bitte noch abstimmen.', conversationId: 'grp-1' })).includes('(2/12)'));
  });

  it('stops reminding once the definition of done is recorded as met', async () => {
    const time = clock(NOON);
    const kernel = fakeKernel({ now: time.now });
    const t = buildTools({ ephemeralRuns: kernel.service, now: time.now, config: POLICY });
    await t.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    await t.call('facilitation_progress', { dodMet: true, summary: 'alle vier haben abgestimmt', conversationId: 'grp-1' });
    time.advance(6 * HOUR_MS);
    const out = await t.call('facilitation_nudge', { text: 'Bitte bestätigen.', conversationId: 'grp-1' });
    assert.ok(out.includes('als erfüllt protokolliert'), out);
    assert.equal(t.nudges.length, 0);
  });

  it('keeps the spacing across a restart (last nudge is part of the durable state)', async () => {
    const time = clock(NOON);
    const kernel = fakeKernel({ now: time.now });
    const before = buildTools({ ephemeralRuns: kernel.service, now: time.now, config: POLICY });
    await before.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });

    // The start anchor survives a restart too.
    time.advance(HOUR_MS);
    const mid = buildTools({ ephemeralRuns: kernel.service, now: time.now, config: POLICY });
    assert.ok((await mid.call('facilitation_nudge', { text: 'Zu früh', conversationId: 'grp-1' })).includes('gerade erst gestartet'));

    time.advance(3 * HOUR_MS);
    assert.ok((await mid.call('facilitation_nudge', { text: 'Erste Erinnerung', conversationId: 'grp-1' })).includes('(1/12)'));

    time.advance(HOUR_MS);
    const after = buildTools({ ephemeralRuns: kernel.service, now: time.now, config: POLICY });
    const out = await after.call('facilitation_nudge', { text: 'Zweite Erinnerung', conversationId: 'grp-1' });
    assert.ok(out.includes('zu frisch'), out);
    assert.equal(after.nudges.length, 0);
  });
});

describe('facilitation_update', () => {
  it('changes the definition of done in place — same run, progress and nudges kept', async () => {
    const time = clock(NOON);
    const kernel = fakeKernel({ now: time.now });
    const t = buildTools({ ephemeralRuns: kernel.service, now: time.now });
    await t.call('facilitation_start', { goal: 'Safeword wählen', definitionOfDone: 'Mindestens 3 von 4 bestätigt', conversationId: 'grp-1' });
    await t.call('facilitation_progress', { dodMet: false, summary: '3 von 4 Stimmen', conversationId: 'grp-1' });

    const out = await t.call('facilitation_update', { definitionOfDone: 'Alle vier haben abgestimmt, keine Bestätigungsrunde', conversationId: 'grp-1' });
    assert.ok(out.includes('kein Neustart'), out);
    assert.equal(kernel.runs.size, 1, 'no second run');
    const record = t.store.get('grp-1');
    assert.equal(record?.runId, 'run-1');
    assert.equal(record?.definitionOfDone, 'Alle vier haben abgestimmt, keine Bestätigungsrunde');
    assert.equal(record?.goal, 'Safeword wählen');
    assert.equal(record?.progress?.summary, '3 von 4 Stimmen');

    const status = await t.call('facilitation_status', { conversationId: 'grp-1' });
    assert.ok(status.includes('Definition of Done: Alle vier haben abgestimmt, keine Bestätigungsrunde'), status);
    assert.ok(status.includes('zuletzt geändert'), status);
  });

  it('survives a restart: the changed wording wins over the run payload', async () => {
    const kernel = fakeKernel({ now: () => NOON });
    const before = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    await before.call('facilitation_start', { goal: 'g', definitionOfDone: 'alt', conversationId: 'grp-1' });
    await before.call('facilitation_update', { definitionOfDone: 'neu', deadline: '2026-11-20T12:00:00+01:00', conversationId: 'grp-1' });

    const after = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    const status = await after.call('facilitation_status');
    assert.ok(status.includes('Definition of Done: neu'), status);
    assert.ok(status.includes('Deadline: 2026-11-20T12:00:00+01:00'), status);
    assert.equal(kernel.runs.get('run-1')?.payload.definitionOfDone, 'alt', 'payload stays the original brief');
  });

  it('warns when the new deadline lies behind the workflow lifetime', async () => {
    const kernel = fakeKernel({ now: () => NOON });
    const t = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    await t.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    const out = await t.call('facilitation_update', { deadline: '2026-11-20T12:00:00+01:00', conversationId: 'grp-1' });
    assert.ok(out.includes('VOR der neuen Deadline'), out);
  });

  it('refuses empty input, bad deadlines and a facilitation that is not active', async () => {
    const kernel = fakeKernel({ now: () => NOON });
    const t = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    assert.ok((await t.call('facilitation_update', { definitionOfDone: 'x' })).includes('Keine aktive Facilitation'));
    await t.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    assert.ok((await t.call('facilitation_update', {})).includes('mindestens eines'));
    assert.ok((await t.call('facilitation_update', { deadline: 'Freitag 12 Uhr' })).includes('kein ISO-Zeitpunkt'));
    assert.ok((await t.call('facilitation_update', { deadline: '2026-11-01T12:00:00+01:00' })).includes('Vergangenheit'));
    assert.equal(t.store.get('grp-1')?.amendedAt, undefined);
  });
});

describe('restart after a stop whose run kept going', () => {
  it('cancels the predecessor run before creating the successor', async () => {
    const kernel = fakeKernel({ now: () => NOON });
    const t = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    await t.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    // The stop could not cancel the run (old kernel / failed call).
    t.store.markStopped('grp-1');

    await t.call('facilitation_start', { goal: 'g', definitionOfDone: 'd2', conversationId: 'grp-1' });
    assert.equal(kernel.runs.get('run-1')?.status, 'cancelled');
    assert.equal(kernel.runs.get('run-2')?.status, 'running');
    assert.equal(t.store.get('grp-1')?.runId, 'run-2');
    assert.ok(t.logs.some((l) => l.includes('predecessor run run-1 cancelled')), t.logs.join('\n'));
  });
});

describe('participants', () => {
  const roster = { participants: ['Christian Wendler', 'Christian Köhler', 'Teresita Biel', 'Marcel Wege'], partial: false };

  it('derives who is pending from roster minus contributors', () => {
    const overview = buildParticipantOverview(roster, ['Christian Wendler', 'teresita biel', 'Marcel']);
    assert.deepEqual(overview.contributed, ['Christian Wendler', 'Teresita Biel', 'Marcel Wege']);
    assert.deepEqual(overview.pending, ['Christian Köhler']);
    assert.deepEqual(overview.unmatched, []);
  });

  it('never guesses between two people sharing a first name', () => {
    const overview = buildParticipantOverview(roster, ['Christian', 'Felix']);
    assert.deepEqual(overview.contributed, []);
    assert.deepEqual(overview.unmatched, ['Christian', 'Felix']);
    assert.equal(overview.pending.length, 4);
  });

  it('shows participants, contributors and who is pending in the status; bots are left out', async () => {
    const rosters: ConversationRostersService = {
      getRoster: async () => ({
        conversationType: 'group',
        participants: [
          ...roster.participants.map((displayName, i) => ({ userRef: { kind: 'teams-aad', id: `u${String(i)}`, displayName } })),
          { userRef: { kind: 'teams-bot', id: 'b1', displayName: 'Karen' }, isBot: true },
        ],
        partial: false,
      }),
    };
    const kernel = fakeKernel({ now: () => NOON });
    const t = buildTools({ ephemeralRuns: kernel.service, now: () => NOON, rosters });
    t.store.markPending({ conversationId: 'grp-1', channelType: 'teams' });
    await t.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    await t.call('facilitation_progress', {
      dodMet: false,
      summary: '3 von 4 Stimmen',
      contributors: ['Christian Wendler', 'Teresita Biel', 'Marcel Wege'],
      conversationId: 'grp-1',
    });
    // A later summary-only update keeps the list.
    await t.call('facilitation_progress', { dodMet: false, summary: 'Stand unverändert', conversationId: 'grp-1' });

    const status = await t.call('facilitation_status', { conversationId: 'grp-1' });
    assert.ok(status.includes('Teilnehmende (4): Christian Wendler, Christian Köhler, Teresita Biel, Marcel Wege'), status);
    assert.ok(status.includes('Ausstehend: Christian Köhler'), status);
    assert.ok(!status.includes('Karen'), status);
  });

  it('refuses a contributor name that fits nobody and stores the roster spelling', async () => {
    const rosters: ConversationRostersService = {
      getRoster: async () => ({
        conversationType: 'group',
        participants: roster.participants.map((displayName, i) => ({ userRef: { kind: 'teams-aad', id: `u${String(i)}`, displayName } })),
        partial: false,
      }),
    };
    const kernel = fakeKernel({ now: () => NOON });
    const t = buildTools({ ephemeralRuns: kernel.service, now: () => NOON, rosters });
    t.store.markPending({ conversationId: 'grp-1', channelType: 'teams' });
    await t.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });

    // "Felix" is what a masked model context turned a real name into.
    const refused = await t.call('facilitation_progress', { dodMet: false, summary: '2 Stimmen', contributors: ['Teresita Biel', 'Felix'], conversationId: 'grp-1' });
    assert.ok(refused.includes('NICHT protokolliert'), refused);
    assert.ok(refused.includes('Felix'), refused);
    assert.ok(refused.includes('Gültige Namen: Christian Wendler, Christian Köhler, Teresita Biel, Marcel Wege'), refused);
    assert.equal(t.store.get('grp-1')?.progress, undefined, 'nothing is recorded');

    // An ambiguous first name is refused the same way.
    assert.ok((await t.call('facilitation_progress', { dodMet: false, summary: 's', contributors: ['Christian'], conversationId: 'grp-1' })).includes('NICHT protokolliert'));

    await t.call('facilitation_progress', { dodMet: false, summary: '2 Stimmen', contributors: ['teresita biel', 'Marcel'], conversationId: 'grp-1' });
    assert.deepEqual(t.store.get('grp-1')?.progress?.contributors, ['Teresita Biel', 'Marcel Wege']);
  });

  it('keeps the contributors across a restart', async () => {
    const kernel = fakeKernel({ now: () => NOON });
    const before = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    await before.call('facilitation_start', { goal: 'g', definitionOfDone: 'd', conversationId: 'grp-1' });
    await before.call('facilitation_progress', { dodMet: false, summary: 's', contributors: ['A B', 'C D'], conversationId: 'grp-1' });

    const after = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    await after.call('facilitation_status');
    assert.deepEqual(after.store.get('grp-1')?.progress?.contributors, ['A B', 'C D']);
  });
});

describe('times and wording check in the handshake (0.7.1)', () => {
  it('prints every time with its local reading and asks the initiator to check the wording', async () => {
    const kernel = fakeKernel({ now: () => NOON });
    const t = buildTools({ ephemeralRuns: kernel.service, now: () => NOON });
    const handshake = await t.call('facilitation_start', {
      goal: 'g',
      definitionOfDone: 'd',
      deadline: '2026-11-20T12:00:00+01:00',
      conversationId: 'grp-1',
    });
    assert.ok(handshake.includes('Deadline: 2026-11-20T12:00:00+01:00 = Fr., 20.11.2026, 12:00 Uhr (Europe/Berlin)'), handshake);
    // 13:00Z is 14:00 in Berlin — the reading that was got wrong in the chat.
    assert.ok(handshake.includes('T13:00:00.000Z = Fr., 20.11.2026, 14:00 Uhr (Europe/Berlin)'), handshake);
    assert.ok(handshake.includes('An den Initiator: Bitte prüfe Ziel und Definition of Done'), handshake);

    const status = await t.call('facilitation_status', { conversationId: 'grp-1' });
    assert.ok(status.includes('= Fr., 20.11.2026, 14:00 Uhr (Europe/Berlin)'), status);
  });
});
