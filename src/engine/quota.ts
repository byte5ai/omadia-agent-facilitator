import type { Facilitation } from '../model.js';

/** The facilitator has posted as much as one facilitation allows. */
export const messageQuotaReached = (f: Pick<Facilitation, 'messagesSent'>, max: number): boolean => f.messagesSent >= max;
