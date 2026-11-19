// The facilitator's tools: the engine's tools and nothing else (spec 5.9).
//
// Every handler keys on the kernel's tool call context. The conversation, the
// facilitator and the caller are stated by the kernel; no tool takes them as an
// argument, and without a context a tool refuses instead of guessing which
// facilitation is meant.

import type { NativeToolCallContext, NativeToolHandler, NativeToolSpec } from '@omadia/plugin-api';

import * as store from '../db/store.js';
import type { Facilitation } from '../model.js';
import { EngineUnavailableError, Refusal } from '../engine/core.js';
import type { FacilitationEngine } from '../engine/engine.js';

export interface ToolDefinition {
  spec: NativeToolSpec;
  handler: NativeToolHandler;
}

export interface ResolvedContext {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  callerPrincipalId: string | undefined;
  /** The caller's name, from a kernel that states it with the call. */
  callerDisplayName: string | undefined;
  inboundEventId: string | undefined;
}

export const NO_CONTEXT =
  'Refused: this tool call does not say which conversation it belongs to, and a facilitation is never guessed. Nothing was done.';

/** `callerUserRef.displayName` (plugin-api 1.57.0): set when the channel
 *  stated the sender's name. Read defensively, an older kernel has no such
 *  field; then the initiator is unnamed until the roster or a message names them. */
function statedName(ref: unknown): string | undefined {
  const name = ref !== null && typeof ref === 'object' ? (ref as { displayName?: unknown }).displayName : undefined;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
}

export function resolveContext(context: NativeToolCallContext | undefined): ResolvedContext {
  if (!context?.agentSlug || !context.channelType || !context.conversationId) throw new Refusal('no_context', NO_CONTEXT);
  return {
    agentSlug: context.agentSlug,
    channelType: context.channelType,
    conversationId: context.conversationId,
    callerPrincipalId: context.callerPrincipalId,
    callerDisplayName: statedName(context.callerUserRef),
    inboundEventId: context.inboundEventId,
  };
}

/** The live facilitation of the calling turn's conversation. */
export async function liveFacilitation(engine: FacilitationEngine, ctx: ResolvedContext): Promise<Facilitation> {
  const f = await store.findLiveByConversation(engine.core.db(), ctx.channelType, ctx.conversationId);
  if (!f || f.facilitatorAgent !== ctx.agentSlug) {
    throw new Refusal('no_facilitation', 'There is no facilitation in this conversation. Start one with facilitation_start when somebody in the group asks for it.');
  }
  await requireReadable(engine, f);
  return f;
}

/** A tool never acts on a facilitation the engine cannot read: it would
 *  answer "done" while nothing reaches the group. */
export async function requireReadable(engine: FacilitationEngine, f: Facilitation): Promise<void> {
  const subscription = await engine.reconcile(f);
  if (subscription.state !== 'refused') return;
  throw new Refusal(
    'no_subscription',
    'I cannot read or post in this conversation right now. Nothing was created, opened or changed. Tell the group that facilitation is not available here right now; do not say that anything was started.',
  );
}

export function asObject(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Refusal('bad_input', `'${key}' is required and must be a non-empty string.`);
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Refusal('bad_input', `'${key}' must be a string.`);
  return value.trim();
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Refusal('bad_input', `'${key}' must be a number.`);
  return number;
}

export function stringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) throw new Refusal('bad_input', `'${key}' must be a list of non-empty strings.`);
  return (value as string[]).map((v) => v.trim());
}

export function numberList(args: Record<string, unknown>, key: string): number[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Refusal('bad_input', `'${key}' must be a list of numbers.`);
  return value as number[];
}

export function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new Refusal('bad_input', `'${key}' must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

type Run = (args: Record<string, unknown>, ctx: ResolvedContext) => Promise<string>;

/** Wrap a handler: context, refusals as answers, failures as errors. */
export function defineTool(
  engine: FacilitationEngine,
  spec: { name: string; description: string; properties?: Record<string, unknown>; required?: string[] },
  run: Run,
): ToolDefinition {
  return {
    spec: {
      name: spec.name,
      description: spec.description,
      input_schema: { type: 'object', properties: spec.properties ?? {}, ...(spec.required ? { required: spec.required } : {}) },
    },
    handler: async (input, context) => {
      try {
        const ctx = resolveContext(context);
        await engine.ensureReady();
        // No database, or one whose tables are not migrated: nothing is started on it.
        if (!engine.available()) throw new EngineUnavailableError('The facilitation engine is not available: its database is missing or not migrated (see the activation log).');
        engine.ensureAttached(ctx.agentSlug);
        return await engine.core.inToolCall(ctx.inboundEventId, () => run(asObject(input), ctx));
      } catch (err) {
        if (err instanceof Refusal) {
          if (err.code === 'no_context') return err.message;
          engine.core.noteRefusal(context?.inboundEventId, err.code);
          return `Refused (${err.code}): ${err.message}`;
        }
        if (err instanceof EngineUnavailableError) {
          // The reason is for the operator (log, status endpoint), not for the chat.
          engine.core.log(`tool ${spec.name} refused: ${err.message}`);
          return 'Not available: facilitation is not set up completely on this instance. Tell the group that facilitation is not available here right now and that an operator has to finish the setup.';
        }
        engine.core.log(`tool ${spec.name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
