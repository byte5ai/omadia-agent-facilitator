import type { FacilitationEngine } from '../engine/engine.js';
import { cardTools } from './cardTools.js';
import { followupTools } from './followupTools.js';
import { lifecycleTools } from './lifecycleTools.js';
import { processTools } from './processTools.js';
import { transparencyTools } from './transparencyTools.js';
import { sessionTools } from './sessionTools.js';
import type { ToolDefinition } from './toolkit.js';

export type { ToolDefinition } from './toolkit.js';

/** Every tool a facilitator has. */
export function buildTools(engine: FacilitationEngine): ToolDefinition[] {
  return [...lifecycleTools(engine), ...processTools(engine), ...transparencyTools(engine), ...sessionTools(engine), ...followupTools(engine), ...cardTools(engine)];
}
