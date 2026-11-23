// Decision methods, table-driven (spec 5.5, acceptance 5). Pure: no database.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseBallot, summariseBallot, toOptions } from '../src/methods/ballot.js';
import type { Ballot, ParseResult } from '../src/methods/ballot.js';
import { assignmentState, evaluate, tally } from '../src/methods/evaluate.js';
import type { CastBallot, EvaluationInput } from '../src/methods/evaluate.js';
import type { MethodId } from '../src/model.js';

const OPTIONS = toOptions(['Harbour', 'Old Town', 'Castle Hill']);
const PEOPLE = [
  { id: 'anna', name: 'Anna Köhler' },
  { id: 'bert', name: 'Bert Maier' },
  { id: 'cara', name: 'Cara Maier' },
];
const ballot = (b: Ballot): ParseResult => ({ kind: 'ballot', ballot: b });
const NOT: ParseResult = { kind: 'not_a_ballot' };

const parse = (method: MethodId, text: string): ParseResult =>
  parseBallot({ method, options: OPTIONS, text, author: PEOPLE[1], people: PEOPLE });

test('option keys are A, B, C ... and continue after Z', () => {
  assert.deepEqual(OPTIONS.map((o) => o.key), ['A', 'B', 'C']);
  assert.equal(toOptions(Array.from({ length: 28 }, (_v, i) => `o${String(i)}`))[27]?.key, 'AB');
});

const PARSE_CASES: Array<[MethodId, string, ParseResult | { problem: string }]> = [
  // ranked: full and partial rankings, every announced spelling
  ['ranked', 'A > C > B', ballot({ type: 'ranked', ranking: ['A', 'C', 'B'] })],
  ['ranked', 'a>c>b', ballot({ type: 'ranked', ranking: ['A', 'C', 'B'] })],
  ['ranked', 'A, C, B.', ballot({ type: 'ranked', ranking: ['A', 'C', 'B'] })],
  ['ranked', 'A C B', ballot({ type: 'ranked', ranking: ['A', 'C', 'B'] })],
  ['ranked', 'Old Town > Harbour', ballot({ type: 'ranked', ranking: ['B', 'A'] })],
  ['ranked', '1. C 2. A 3. B', ballot({ type: 'ranked', ranking: ['C', 'A', 'B'] })],
  ['ranked', '2. A\n1. C', ballot({ type: 'ranked', ranking: ['C', 'A'] })],
  ['ranked', 'C', ballot({ type: 'ranked', ranking: ['C'] })],
  ['ranked', 'A > C', ballot({ type: 'ranked', ranking: ['A', 'C'] })],
  ['ranked', '@Mira vote: B > A', ballot({ type: 'ranked', ranking: ['B', 'A'] })],
  ['ranked', 'Meine Stimme: B > A', ballot({ type: 'ranked', ranking: ['B', 'A'] })],
  // ranked: refused with a hint
  ['ranked', 'A > A > B', { problem: 'duplicate_option' }],
  ['ranked', '1. A 1. B', { problem: 'duplicate_rank' }],
  ['ranked', '1. A 3. B', { problem: 'bad_rank' }],
  ['ranked', 'A > D > B', { problem: 'unknown_option' }],
  ['ranked', 'vote: Z', NOT],
  // ranked: not a ballot, so it goes to the facilitator as free text
  ['ranked', '', NOT],
  ['ranked', '   ', NOT],
  ['ranked', 'A good idea, I think we should talk about the castle first', NOT],
  ['ranked', 'I like the harbour best', NOT],
  ['ranked', 'Anna agrees too', NOT],
  // abstention is accepted by every method
  ['ranked', 'abstain', ballot({ type: 'abstention' })],
  ['single', 'Enthaltung', ballot({ type: 'abstention' })],
  ['approval', 'ich enthalte mich', ballot({ type: 'abstention' })],
  ['consent', 'abstention', ballot({ type: 'abstention' })],
  ['assignment', 'I abstain', ballot({ type: 'abstention' })],
  // single choice
  ['single', 'B', ballot({ type: 'single', choice: 'B' })],
  ['single', 'castle hill', ballot({ type: 'single', choice: 'C' })],
  ['single', 'A, B', { problem: 'too_many_options' }],
  ['single', 'B, B', ballot({ type: 'single', choice: 'B' })],
  ['single', 'maybe B', NOT],
  // approval
  ['approval', 'A, C', ballot({ type: 'approval', choices: ['A', 'C'] })],
  ['approval', 'C A C', ballot({ type: 'approval', choices: ['C', 'A'] })],
  ['approval', 'B', ballot({ type: 'approval', choices: ['B'] })],
  ['approval', 'A, X', { problem: 'unknown_option' }],
  // consent
  ['consent', 'consent', ballot({ type: 'consent', consent: true })],
  ['consent', 'Einverstanden!', ballot({ type: 'consent', consent: true })],
  ['consent', 'no objection', ballot({ type: 'consent', consent: true })],
  ['consent', 'Objection: too expensive for the team', ballot({ type: 'consent', consent: false, reason: 'too expensive for the team' })],
  ['consent', 'Einwand - der Termin kollidiert', ballot({ type: 'consent', consent: false, reason: 'der Termin kollidiert' })],
  ['consent', 'objection', { problem: 'reason_required' }],
  ['consent', 'ich widerspreche nicht', NOT],
  ['consent', 'sounds good to me in principle but', NOT],
  // assignment
  ['assignment', 'A: Anna', ballot({ type: 'assignment', nominations: [{ item: 'A', nominee: 'anna' }], declines: [] })],
  ['assignment', 'Harbour -> me', ballot({ type: 'assignment', nominations: [{ item: 'A', nominee: 'bert' }], declines: [] })],
  ['assignment', 'I take B', ballot({ type: 'assignment', nominations: [{ item: 'B', nominee: 'bert' }], declines: [] })],
  ['assignment', 'Ich übernehme Castle Hill', ballot({ type: 'assignment', nominations: [{ item: 'C', nominee: 'bert' }], declines: [] })],
  ['assignment', 'A: Anna Köhler; B: Cara Maier', ballot({ type: 'assignment', nominations: [{ item: 'A', nominee: 'anna' }, { item: 'B', nominee: 'cara' }], declines: [] })],
  ['assignment', 'decline B', ballot({ type: 'assignment', nominations: [], declines: ['B'] })],
  ['assignment', 'A: Zoe', { problem: 'unknown_person' }],
  ['assignment', 'A: Maier', { problem: 'unknown_person' }],
  ['assignment', 'A: Anna; A: Cara Maier', { problem: 'duplicate_option' }],
  ['assignment', 'Anna should do the harbour', NOT],
];

for (const [method, text, expected] of PARSE_CASES) {
  test(`parse ${method}: ${JSON.stringify(text)}`, () => {
    const result = parse(method, text);
    if ('problem' in expected) {
      assert.equal(result.kind, 'invalid');
      assert.equal(result.kind === 'invalid' ? result.problem : undefined, expected.problem);
    } else {
      assert.deepEqual(result, expected);
    }
  });
}

test('two people sharing a first name are ambiguous by first name', () => {
  const people = [...PEOPLE, { id: 'anna2', name: 'Anna Berg' }];
  const result = parseBallot({ method: 'assignment', options: OPTIONS, text: 'A: Anna', people });
  assert.equal(result.kind === 'invalid' ? result.problem : undefined, 'ambiguous_person');
});

test('a ballot is summarised the way its author wrote it down', () => {
  assert.equal(summariseBallot({ type: 'ranked', ranking: ['A', 'C'] }, OPTIONS), 'A (Harbour) > C (Castle Hill)');
  assert.equal(summariseBallot({ type: 'consent', consent: false, reason: 'too dear' }, OPTIONS), 'objection: too dear');
  assert.equal(summariseBallot({ type: 'assignment', nominations: [{ item: 'B', nominee: 'cara' }], declines: [] }, OPTIONS, PEOPLE), 'B (Old Town): Cara Maier');
});

const cast = (entries: Record<string, Ballot>): CastBallot[] => Object.entries(entries).map(([principal, b]) => ({ principal, ballot: b }));
const ranked = (...ranking: string[]): Ballot => ({ type: 'ranked', ranking });

test('ranked vote: 3/2/1 by default, missing ranks score 0, abstentions score nothing', () => {
  const result = tally('ranked', OPTIONS, cast({ a: ranked('A', 'C', 'B'), b: ranked('C'), c: { type: 'abstention' }, d: ranked('B', 'C') }));
  assert.deepEqual(result.scores, { A: 3, B: 4, C: 7 });
  assert.deepEqual(result.leaders, ['C']);
  assert.equal(result.votes, 3);
  assert.equal(result.abstentions, 1);
});

test('ranked vote: configurable points; ranks beyond the list score 0', () => {
  const result = tally('ranked', OPTIONS, cast({ a: ranked('A', 'B', 'C') }), [5, 1]);
  assert.deepEqual(result.scores, { A: 5, B: 1, C: 0 });
});

test('single choice and approval count votes per option', () => {
  assert.deepEqual(tally('single', OPTIONS, cast({ a: { type: 'single', choice: 'B' }, b: { type: 'single', choice: 'B' }, c: { type: 'single', choice: 'A' } })).scores, { A: 1, B: 2, C: 0 });
  assert.deepEqual(tally('approval', OPTIONS, cast({ a: { type: 'approval', choices: ['A', 'C'] }, b: { type: 'approval', choices: ['C'] } })).scores, { A: 1, B: 0, C: 2 });
});

const base = (over: Partial<EvaluationInput>): EvaluationInput => ({
  method: 'ranked',
  options: OPTIONS,
  ballots: [],
  activeParticipants: ['a', 'b', 'c', 'd'],
  closeRule: 'all_contributed',
  deadlineReached: false,
  hasOpenProposal: false,
  ...over,
});

const FOUR_CLEAR = cast({ a: ranked('A', 'C', 'B'), b: ranked('A', 'B'), c: ranked('C', 'A'), d: ranked('B', 'A', 'C') });
const FOUR_TIED = cast({ a: ranked('A', 'B'), b: ranked('B', 'A'), c: ranked('A', 'B'), d: ranked('B', 'A') });
const consent = (yes: boolean, reason = 'too expensive'): Ballot => (yes ? { type: 'consent', consent: true } : { type: 'consent', consent: false, reason });

const EVALUATION_CASES: Array<[string, EvaluationInput, string, Record<string, unknown>?]> = [
  ['three of four voted: waiting, with a provisional tally', base({ ballots: FOUR_CLEAR.slice(0, 3) }), 'waiting', { missing: ['d'] }],
  ['everybody voted, clear result', base({ ballots: FOUR_CLEAR }), 'clear', { winner: 'A' }],
  ['everybody voted, tie: runoff among the tied options', base({ ballots: FOUR_TIED }), 'tie', { tied: ['A', 'B'] }],
  ['an abstention completes participation', base({ ballots: cast({ a: ranked('C'), b: ranked('C', 'A'), c: ranked('A'), d: { type: 'abstention' } }) }), 'clear', { winner: 'C' }],
  ['everybody abstained: every option is level', base({ ballots: cast({ a: { type: 'abstention' }, b: { type: 'abstention' }, c: { type: 'abstention' }, d: { type: 'abstention' } }) }), 'tie', { tied: ['A', 'B', 'C'] }],
  ['a person who left is not waited for', base({ ballots: FOUR_CLEAR.slice(0, 3), activeParticipants: ['a', 'b', 'c'] }), 'clear', { winner: 'A' }],
  ['a pending change proposal blocks conclusion even with every vote in', base({ ballots: FOUR_CLEAR, hasOpenProposal: true }), 'blocked_by_proposal'],
  ['a pending change proposal blocks at the deadline too', base({ ballots: FOUR_CLEAR, hasOpenProposal: true, deadlineReached: true }), 'blocked_by_proposal'],
  ['close rule "at the deadline": complete participation does not conclude', base({ ballots: FOUR_CLEAR, closeRule: 'at_deadline' }), 'waiting', { missing: [] }],
  ['close rule "at the deadline": the deadline evaluates', base({ ballots: FOUR_CLEAR, closeRule: 'at_deadline', deadlineReached: true }), 'clear', { winner: 'A' }],
  ['deadline with three votes: the votes cast decide', base({ ballots: FOUR_CLEAR.slice(0, 3), deadlineReached: true }), 'clear', { winner: 'A' }],
  ['runoff timeout with the tie still standing', base({ ballots: FOUR_TIED, options: OPTIONS.slice(0, 2), deadlineReached: true }), 'tie', { tied: ['A', 'B'] }],
  ['deadline without any ballot: no result', base({ deadlineReached: true }), 'tie', { tied: ['A', 'B', 'C'] }],
  ['single choice, clear', base({ method: 'single', ballots: cast({ a: { type: 'single', choice: 'B' }, b: { type: 'single', choice: 'B' }, c: { type: 'single', choice: 'A' }, d: { type: 'single', choice: 'B' } }) }), 'clear', { winner: 'B' }],
  ['single choice, tie', base({ method: 'single', ballots: cast({ a: { type: 'single', choice: 'B' }, b: { type: 'single', choice: 'A' }, c: { type: 'single', choice: 'A' }, d: { type: 'single', choice: 'B' } }) }), 'tie', { tied: ['A', 'B'] }],
  ['approval, clear', base({ method: 'approval', ballots: cast({ a: { type: 'approval', choices: ['A', 'C'] }, b: { type: 'approval', choices: ['C'] }, c: { type: 'approval', choices: ['B', 'C'] }, d: { type: 'approval', choices: ['A'] } }) }), 'clear', { winner: 'C' }],
  ['consent: nobody objects', base({ method: 'consent', ballots: cast({ a: consent(true), b: consent(true), c: consent(true), d: { type: 'abstention' } }) }), 'consent_passed'],
  ['consent: a standing objection keeps it active', base({ method: 'consent', ballots: cast({ a: consent(true), b: consent(false), c: consent(true), d: consent(true) }) }), 'objection', { objections: [{ principal: 'b', reason: 'too expensive' }] }],
  ['consent: still waiting for one voice', base({ method: 'consent', ballots: cast({ a: consent(true), b: consent(true), c: consent(true) }) }), 'waiting', { missing: ['d'] }],
  ['consent at the deadline with an objection', base({ method: 'consent', ballots: cast({ a: consent(false, 'not now') }), deadlineReached: true }), 'objection'],
  ['consent at the deadline, silence is not an objection', base({ method: 'consent', ballots: cast({ a: consent(true) }), deadlineReached: true }), 'consent_passed'],
];

for (const [name, input, state, expected] of EVALUATION_CASES) {
  test(`evaluate: ${name}`, () => {
    const result = evaluate(input);
    assert.equal(result.state, state);
    for (const [key, value] of Object.entries(expected ?? {})) assert.deepEqual((result as unknown as Record<string, unknown>)[key], value, key);
  });
}

test('a provisional tally is available while waiting', () => {
  const result = evaluate(base({ ballots: FOUR_CLEAR.slice(0, 2) }));
  assert.deepEqual(result.state === 'waiting' ? result.provisional?.scores : undefined, { A: 6, B: 3, C: 2 });
});

const ROLES = toOptions(['Chair', 'Notes', 'Timekeeper']);
const nominate = (principal: string, item: string, nominee: string) => ({ principal, nominations: [{ item, nominee }], declines: [], confirms: [] });
const confirm = (principal: string, item: string) => ({ principal, nominations: [], declines: [], confirms: [item] });
const decline = (principal: string, item: string) => ({ principal, nominations: [], declines: [item], confirms: [] });

test('assignment: a name binds only when that person confirmed it themselves', () => {
  const state = assignmentState(ROLES, [nominate('bert', 'A', 'anna'), nominate('cara', 'B', 'cara')]);
  assert.deepEqual(state, [
    { item: 'A', nominee: 'anna', confirmed: false },
    { item: 'B', nominee: 'cara', confirmed: true },
    { item: 'C', confirmed: false },
  ]);
  assert.deepEqual(assignmentState(ROLES, [nominate('bert', 'A', 'anna'), confirm('anna', 'A')])[0], { item: 'A', nominee: 'anna', confirmed: true });
  assert.deepEqual(assignmentState(ROLES, [nominate('bert', 'A', 'anna'), confirm('cara', 'A')])[0], { item: 'A', nominee: 'anna', confirmed: false }, "somebody else's yes confirms nothing");
});

test('assignment: a declined nomination reopens the item; a confirmed item is not displaced', () => {
  assert.deepEqual(assignmentState(ROLES, [nominate('bert', 'A', 'anna'), decline('anna', 'A')])[0], { item: 'A', confirmed: false });
  assert.deepEqual(assignmentState(ROLES, [nominate('anna', 'A', 'anna'), nominate('bert', 'A', 'cara')])[0], { item: 'A', nominee: 'anna', confirmed: true });
  assert.deepEqual(assignmentState(ROLES, [nominate('anna', 'A', 'anna'), decline('anna', 'A'), nominate('bert', 'A', 'bert')])[0], { item: 'A', nominee: 'bert', confirmed: true });
  assert.deepEqual(assignmentState(ROLES, [nominate('anna', 'A', 'anna'), decline('bert', 'A')])[0], { item: 'A', nominee: 'anna', confirmed: true }, 'only the named person can decline');
});

test('assignment: done when every item has one confirmed name, open otherwise, also at the deadline', () => {
  const done = evaluate(base({ method: 'assignment', options: ROLES, assignmentEvents: [nominate('a', 'A', 'a'), nominate('b', 'B', 'b'), nominate('b', 'C', 'c'), confirm('c', 'C')] }));
  assert.equal(done.state, 'assignment_done');
  const open = evaluate(base({ method: 'assignment', options: ROLES, deadlineReached: true, assignmentEvents: [nominate('a', 'A', 'a'), nominate('b', 'B', 'c')] }));
  assert.equal(open.state, 'assignment_open');
  assert.deepEqual(open.state === 'assignment_open' ? [open.openItems, open.unconfirmed] : [], [['C'], ['B']]);
});

// K2 (live E2E on Discord and Telegram, 2026-11-23): a vote that goes out as
// text lists its options numbered and suggests "z. B. 2,1,3" (channel-sdk
// questionCardText). Such a ballot was not counted: only keys and labels were
// known. A bare number names the option at that position.
test('K2: options can be named by their number in the list, as the text vote suggests', () => {
  assert.deepEqual(parse('ranked', '2,1,3'), ballot({ type: 'ranked', ranking: ['B', 'A', 'C'] }));
  assert.deepEqual(parse('ranked', '3 > 1'), ballot({ type: 'ranked', ranking: ['C', 'A'] }));
  assert.deepEqual(parse('single', '2'), ballot({ type: 'single', choice: 'B' }));
  assert.deepEqual(parse('approval', '1, 3'), ballot({ type: 'approval', choices: ['A', 'C'] }));
  // Rank syntax keeps its meaning: "1. C" ranks C first, it does not name option 1.
  assert.deepEqual(parse('ranked', '1. C 2. A 3. B'), ballot({ type: 'ranked', ranking: ['C', 'A', 'B'] }));
  // A number past the list is no option.
  assert.deepEqual(parse('single', '4'), NOT);
  // A label that is itself a number wins over the position.
  const years = toOptions(['2027', '2026']);
  assert.deepEqual(
    parseBallot({ method: 'single', options: years, text: '2026', author: PEOPLE[1], people: PEOPLE }),
    ballot({ type: 'single', choice: 'B' }),
  );
});
