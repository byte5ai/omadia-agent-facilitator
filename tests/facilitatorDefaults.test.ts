// Per-facilitator defaults (spec 2043 §5.6, §7; byte5ai/omadia#2066): the
// operator sets default methods and the reminder policy on the facilitator's
// page; the kernel hands them over with the facilitator's profile
// (`AgentProfile.archetypeSettings`). They sit over the instance settings,
// which stay the default for everything a facilitator does not set.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { HOUR_MS } from '../src/clock.js';
import { CONFIG_DEFAULTS, facilitatorConfig, profileSettings } from '../src/config.js';
import { rows } from '../src/db/sql.js';
import * as store from '../src/db/store.js';
import type { Job } from '../src/model.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

// ── the pure overlay ─────────────────────────────────────────────────────────

test('without settings (an older kernel, or nothing set) the instance settings apply unchanged', () => {
  assert.deepEqual(facilitatorConfig(CONFIG_DEFAULTS, undefined), CONFIG_DEFAULTS);
  assert.deepEqual(facilitatorConfig(CONFIG_DEFAULTS, {}), CONFIG_DEFAULTS);
  assert.equal(profileSettings({ agentSlug: 'mira' }), undefined);
  assert.equal(profileSettings(undefined), undefined);
});

test("a facilitator's own defaults override the instance settings; offsets furthest first", () => {
  const config = facilitatorConfig(CONFIG_DEFAULTS, {
    default_decision_method: 'approval',
    default_prioritisation_method: 'ranked',
    ranked_points: [5, 3, 1],
    reminder_offsets_hours: [6, 48],
  });
  assert.equal(config.defaultDecisionMethod, 'approval');
  assert.equal(config.defaultPrioritisationMethod, 'ranked');
  assert.deepEqual(config.rankedPoints, [5, 3, 1]);
  assert.deepEqual(config.reminderOffsetsHours, [48, 6]);
  // Everything else stays the instance's.
  assert.equal(config.retentionDays, CONFIG_DEFAULTS.retentionDays);
  assert.equal(config.timezone, CONFIG_DEFAULTS.timezone);
});

test('invalid settings are ignored and logged; the instance setting applies', () => {
  const logs: string[] = [];
  const config = facilitatorConfig(
    CONFIG_DEFAULTS,
    { default_decision_method: 'assignment', default_prioritisation_method: 'single', ranked_points: [3, -1], reminder_offsets_hours: Array.from({ length: 11 }, (_v, i) => i + 1) },
    (m) => logs.push(m),
  );
  assert.equal(config.defaultDecisionMethod, undefined);
  assert.equal(config.defaultPrioritisationMethod, undefined);
  assert.deepEqual(config.rankedPoints, CONFIG_DEFAULTS.rankedPoints);
  assert.deepEqual(config.reminderOffsetsHours, CONFIG_DEFAULTS.reminderOffsetsHours);
  assert.equal(logs.length, 4);
  assert.ok(logs.every((l) => l.includes('the instance setting applies')));
});

test('a list given as text is read like the instance setting', () => {
  assert.deepEqual(facilitatorConfig(CONFIG_DEFAULTS, { reminder_offsets_hours: '2, 12' }).reminderOffsetsHours, [12, 2]);
});

// ── through the engine ───────────────────────────────────────────────────────

let h: Harness;
before(async () => {
  if (PG_SKIP) return;
  h = await createHarness({ start: '2026-11-18T09:00:00Z', config: { maxActivePerFacilitator: 40, startsPerHourPerFacilitator: 100 } });
  h.kernel.agentSettings.set('mira', {
    default_decision_method: 'approval',
    default_prioritisation_method: 'approval',
    ranked_points: [5, 3, 1],
    reminder_offsets_hours: [48, 6],
  });
  h.kernel.agentSettings.set('lena', { default_decision_method: 'ranked', ranked_points: [5, 3, 1] });
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

const OPTIONS = ['Harbour', 'Old Town', 'Castle Hill'];
const inHours = (hours: number): string => new Date(h.clock.now().getTime() + hours * HOUR_MS).toISOString();
const steps = async (conv: string) => store.listSteps(h.db.pool, (await h.facilitation(conv)).id);
const tool = (conv: string, name: string, args: Record<string, unknown>, agent = 'mira'): Promise<string> => h.tool(name, args, { conversation: conv, agent });

test("a facilitator's reminder offsets are its facilitations' reminder policy", { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('fd-reminders', [ANNA, BERT]);
  const f = await startActive(h, conv, { method: 'single', options: OPTIONS, deadline: inHours(96) });
  assert.deepEqual(f.reminderPolicy.offsetsHours, [48, 6]);
  assert.deepEqual(f.reminderPolicy.baseHours, [48, 6]);
  assert.match(h.kernel.groupPosts(conv)[0]?.text ?? '', /Reminders: 48 h, 6 h before the deadline/);
});

test('a vote that names options without a method uses the default decision method', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('fd-vote', [ANNA, BERT]);
  await startActive(h, conv, { options: OPTIONS, deadline: inHours(72) });
  const [step] = await steps(conv);
  assert.equal(step?.method, 'approval');
  assert.deepEqual(step?.options.map((o) => o.label), OPTIONS);
});

test("templates take the facilitator's default methods; a consent step stays consent", { skip: PG_SKIP }, async () => {
  const decision = h.kernel.conversation('fd-decision', [ANNA, BERT]);
  await tool(decision, 'facilitation_start', { goal: 'Pick a venue', format: 'decision' });
  assert.equal((await steps(decision)).find((s) => s.kind === 'decide')?.method, 'approval');

  const prioritisation = h.kernel.conversation('fd-prio', [ANNA, BERT]);
  await tool(prioritisation, 'facilitation_start', { goal: 'Order the backlog', format: 'prioritisation' });
  assert.equal((await steps(prioritisation)).find((s) => s.kind === 'prioritise')?.method, 'approval');

  const alignment = h.kernel.conversation('fd-alignment', [ANNA, BERT]);
  await tool(alignment, 'facilitation_start', { goal: 'Agree on the roadmap', format: 'alignment' });
  assert.equal((await steps(alignment)).find((s) => s.kind === 'decide')?.method, 'consent');
});

test("a ranked vote takes the facilitator's points per rank", { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('fd-points', [ANNA, BERT]);
  await startActive(h, conv, { options: OPTIONS, deadline: inHours(72) }, 'lena');
  const [step] = await steps(conv);
  assert.equal(step?.method, 'ranked');
  assert.deepEqual(step?.methodConfig['points'], [5, 3, 1]);
});

test('a facilitator without settings follows the instance settings', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('fd-instance', [ANNA, BERT]);
  const f = await startActive(h, conv, { method: 'ranked', options: OPTIONS, deadline: inHours(72) }, 'jonas');
  assert.deepEqual(f.reminderPolicy.offsetsHours, [24, 2]);
  const [step] = await steps(conv);
  assert.deepEqual(step?.methodConfig['points'], [3, 2, 1]);

  const template = h.kernel.conversation('fd-instance-template', [ANNA, BERT]);
  await tool(template, 'facilitation_start', { goal: 'Pick a venue', format: 'decision' }, 'jonas');
  assert.equal((await steps(template)).find((s) => s.kind === 'decide')?.method, 'ranked');
});

test("a deadline change derives the reminders from the facilitator's offsets again", { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('fd-deadline', [ANNA, BERT]);
  const f = await startActive(h, conv, { method: 'single', options: OPTIONS, deadline: inHours(96) });
  const next = inHours(144);
  await tool(conv, 'facilitation_propose_change', { change: 'deadline', deadline: next });
  for (const who of ['anna', 'bert']) {
    await h.kernel.say(conv, who, 'agreed');
    await h.settle();
  }
  const moved = await h.facilitation(conv);
  assert.equal(moved.deadline?.toISOString(), next);
  assert.deepEqual(moved.reminderPolicy.offsetsHours, [48, 6]);
  const pending = (await rows<Job>(h.db.pool, `SELECT * FROM plg_omadia_agent_facilitator_jobs WHERE facilitation_id = $1 AND status = 'pending' AND kind = 'reminder' ORDER BY due_at`, [f.id])).map((j) => j.dueAt.toISOString());
  const at = (hours: number): string => new Date(Date.parse(next) - hours * HOUR_MS).toISOString();
  assert.deepEqual(pending, [at(48), at(6)]);
});
