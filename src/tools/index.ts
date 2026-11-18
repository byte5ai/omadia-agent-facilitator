import type { FacilitationEngine } from '../engine/engine.js';
import { lifecycleTools } from './lifecycleTools.js';
import { processTools } from './processTools.js';
import type { ToolDefinition } from './toolkit.js';

export type { ToolDefinition } from './toolkit.js';

/** Every tool a facilitator has. */
export function buildTools(engine: FacilitationEngine): ToolDefinition[] {
  return [...lifecycleTools(engine), ...processTools(engine)];
}
