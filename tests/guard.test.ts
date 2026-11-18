// Every text the engine sends goes through one guard (review, lower findings).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as store from '../src/db/store.js';
import { guardOutgoing } from '../src/engine/guard.js';
import { ANNA, BERT, createHarness, startActive } from './harness.js';
import type { Harness } from './harness.js';
import { PG_SKIP } from './pg.js';

const CASES: Array<[string, string, 'ok' | 'silent' | 'tool_fragment' | 'placeholder' | 'empty']> = [
  ['plain text', 'What matters most to you about the venue?', 'ok'],
  ['text with braces in prose', 'Options {A, B} are both fine, pick one.', 'ok'],
  ['silent marker alone', '[silent]', 'silent'],
  ['silent marker inside other text', 'Understood. [silent]', 'silent'],
  ['silent marker in another case', 'Nothing to add [SILENT] here', 'silent'],
  ['a JSON object', '{"name": "facilitation_status", "input": {}}', 'tool_fragment'],
  ['a JSON array', '[{"type": "text", "text": "hi"}]', 'tool_fragment'],
  ['a tool_use block inside text', 'Sure. {"type": "tool_use", "name": "facilitation_stop"}', 'tool_fragment'],
  ['function call markup', 'ok <invoke name="facilitation_stop"></invoke>', 'tool_fragment'],
  ['a fenced json tool call', 'Here:\n```json\n{"name": "x", "arguments": {}}\n```', 'tool_fragment'],
  ['a privacy placeholder', 'I recorded this for PLATZHALTER-PERSON-3.', 'placeholder'],
  ['an English privacy placeholder', 'Thanks, PLACEHOLDER-NAME-12!', 'placeholder'],
  ['nothing', '   ', 'empty'],
];
for (const [name, text, verdict] of CASES) {
  test(`guard: ${name}`, () => {
    const result = guardOutgoing(text);
    assert.equal(result.ok ? 'ok' : result.reason, verdict);
  });
}

let h: Harness;
before(async () => {
  if (!PG_SKIP) h = await createHarness();
});
after(async () => {
  if (!PG_SKIP) await h.close();
});

test('what the model returns never reaches the chat as a tool fragment, a placeholder or with a silent marker in it', { skip: PG_SKIP }, async () => {
  const conv = h.kernel.conversation('gu-turn', [ANNA, BERT]);
  const f = await startActive(h, conv, { goal: 'Talk', definitionOfDone: 'Done' });
  const posts = (): string[] => h.kernel.groupPosts(conv).map((p) => p.text);
  const answer = async (text: string): Promise<string[]> => {
    const before = posts().length;
    h.kernel.onTurn = () => text;
    await h.kernel.say(conv, 'anna', 'hello?');
    await h.settle();
    return posts().slice(before);
  };
  assert.deepEqual(await answer('Fine by me. [silent]'), [], 'a silent marker anywhere means: say nothing');
  const fallback = 'I could not put my answer into words just now. Ask "status" for where we stand.';
  assert.deepEqual(await answer('{"type": "tool_use", "name": "facilitation_stop", "input": {"reason": "x"}}'), [fallback]);
  assert.deepEqual(await answer('Thank you, PLATZHALTER-PERSON-1, noted.'), [fallback]);
  assert.deepEqual((await store.listEvents(h.db.pool, f.id, ['text_refused'])).map((e) => [e.payload['purpose'], e.payload['reason']]), [['moderation', 'tool_fragment'], ['moderation', 'placeholder']]);

  // A summary the model writes for an echo goes through the same guard.
  h.kernel.onTurn = () => '[silent]';
  const said = await h.kernel.say(conv, 'bert', 'I like the first idea');
  await h.settle();
  await h.tool('facilitation_record_contribution', { messageId: said.messageId, kind: 'position', summary: 'likes PLACEHOLDER-NAME-2\'s idea' }, { conversation: conv });
  assert.ok(!posts().some((t) => t.includes('PLACEHOLDER-')));
  assert.equal((await store.listEvents(h.db.pool, f.id, ['text_refused'])).length, 3);
  h.kernel.onTurn = () => '[silent]';
});
