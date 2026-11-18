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
  inboundEventId: string | undefined;
}

export const NO_CONTEXT =
  'Refused: the kernel did not state which conversation this tool call belongs to. The engine never guesses a facilitation. This needs a kernel with tool call context (plugin-api >= 1.55).';

export function resolveContext(context: NativeToolCallContext | undefined): ResolvedContext {
  if (!context?.agentSlug || !context.channelType || !context.conversationId) throw new Refusal('no_context', NO_CONTEXT);
  return {
    agentSlug: context.agentSlug,
    channelType: context.channelType,
    conversationId: context.conversationId,
    callerPrincipalId: context.callerPrincipalId,
    inboundEventId: context.inboundEventId,
  };
}

/** The live facilitation of the calling turn's conversation. */
export async function liveFacilitation(engine: FacilitationEngine, ctx: ResolvedContext): Promise<Facilitation> {
  const f = await store.findLiveByConversation(engine.core.pool(), ctx.channelType, ctx.conversationId);
  if (!f || f.facilitatorAgent !== ctx.agentSlug) {
    throw new Refusal('no_facilitation', 'There is no facilitation in this conversation. Start one with facilitation_start when somebody in the group asks for it.');
  }
  return f;
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
        engine.ensureAttached(ctx.agentSlug);
        return await run(asObject(input), ctx);
      } catch (err) {
        if (err instanceof Refusal) return err.code === 'no_context' ? err.message : `Refused (${err.code}): ${err.message}`;
        if (err instanceof EngineUnavailableError) return `Not available: ${err.message} Tell the group that facilitation is not available here right now.`;
        engine.core.log(`tool ${spec.name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
