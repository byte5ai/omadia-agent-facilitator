// K1 (live E2E on Discord and Telegram, 2026-11-23): a kernel up to plugin-api
// 1.87 copies the channel's routing principal (`user:discord-user:<id>`,
// `user:telegram-chat:<id>`, `user:<e-mail>`) into `callerPrincipalId`, while a
// stored message's author is `user:<id>`. The initiator was then a second
// participant next to their own ballot, and "everyone voted" never came.
// The plugin keys the caller like a message author (omadia ADR 0032).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveContext } from '../src/tools/toolkit.js';

const base = { agentSlug: 'nora-test', channelType: 'discord', conversationId: 'c-1' };

test('K1: the caller is keyed like a message author, not by the routing principal', () => {
  assert.equal(
    resolveContext({ ...base, callerPrincipalId: 'user:discord-user:157439', callerUserRef: { kind: 'discord-user', id: '157439' } }).callerPrincipalId,
    'user:157439',
  );
  assert.equal(
    resolveContext({ ...base, channelType: 'telegram', callerPrincipalId: 'user:telegram-chat:8123', callerUserRef: { kind: 'telegram-chat', id: '8123' } }).callerPrincipalId,
    'user:8123',
  );
  assert.equal(
    resolveContext({ ...base, channelType: 'slack', callerPrincipalId: 'user:marcel@example.com', callerUserRef: { kind: 'slack-user', id: 'U07ABC' } }).callerPrincipalId,
    'user:u07abc',
  );
});

test('K1: a kernel that already states the conversation form is taken as is', () => {
  assert.equal(
    resolveContext({ ...base, channelType: 'teams', callerPrincipalId: 'user:aad-marcel', callerUserRef: { kind: 'teams-aad', id: 'AAD-Marcel' } }).callerPrincipalId,
    'user:aad-marcel',
  );
  assert.equal(resolveContext({ ...base, callerPrincipalId: 'user:157439' }).callerPrincipalId, 'user:157439');
  assert.equal(resolveContext({ ...base }).callerPrincipalId, undefined);
});
