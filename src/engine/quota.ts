import type { EngineConfig, FacilitatorLimits } from '../config.js';
import type { Facilitation } from '../model.js';

/** The limits of one facilitator: its own where the operator set them
 *  (`facilitator_limits`), otherwise the instance's defaults (spec 5.10). */
export function limitsOf(config: EngineConfig, facilitatorAgent: string): Required<FacilitatorLimits> {
  const own = config.facilitatorLimits[facilitatorAgent] ?? {};
  return {
    active: own.active ?? config.maxActivePerFacilitator,
    startsPerHour: own.startsPerHour ?? config.startsPerHourPerFacilitator,
    messages: own.messages ?? config.maxMessagesPerFacilitation,
  };
}

/** The facilitator has posted as much as one facilitation allows. */
export const messageQuotaReached = (f: Pick<Facilitation, 'messagesSent'>, max: number): boolean => f.messagesSent >= max;
