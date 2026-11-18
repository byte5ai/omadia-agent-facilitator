// One guard for every text the engine sends.
//
// Whatever goes to a chat or a private message passes through here, whether
// the engine wrote it, a model did, or it quotes what a person said. It
// refuses what must never be shown to a group: fragments of tool calls, raw
// JSON, placeholder tokens of the privacy shield that were not restored, and
// anything carrying the "say nothing" marker.

export type GuardReason = 'empty' | 'silent' | 'tool_fragment' | 'placeholder';
export type GuardVerdict = { ok: true; text: string } | { ok: false; reason: GuardReason };

const SILENT = /\[\s*silent\s*\]|\bno_reply\b/i;
// Tokens the privacy shield puts in place of personal data, e.g.
// PLATZHALTER-PERSON-3. One that reaches an answer was not restored.
const PLACEHOLDER = /\b(?:PLATZHALTER|PLACEHOLDER)-[A-Z0-9_]+-\d+\b/;
const TOOL_MARKUP = /<\/?(?:function_calls|invoke|parameter|tool_use|tool_result|tool_call)\b[^>]*>/i;
const TOOL_JSON = /"type"\s*:\s*"tool_(?:use|result|call)"|"tool_calls"\s*:|"(?:name|tool)"\s*:\s*"[^"]*"\s*,\s*"(?:input|arguments|parameters)"\s*:/;
const FENCED_JSON = /```(?:json)?\s*[\[{][\s\S]*```/i;

function isJson(text: string): boolean {
  const first = text[0];
  const last = text[text.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

export function guardOutgoing(raw: string): GuardVerdict {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (SILENT.test(text)) return { ok: false, reason: 'silent' };
  if (PLACEHOLDER.test(text)) return { ok: false, reason: 'placeholder' };
  if (isJson(text) || TOOL_MARKUP.test(text) || TOOL_JSON.test(text) || FENCED_JSON.test(text)) return { ok: false, reason: 'tool_fragment' };
  return { ok: true, text };
}

/** A model that has nothing to say answers with the marker, anywhere. */
export const isSilent = (text: string): boolean => text.trim() === '' || SILENT.test(text);
