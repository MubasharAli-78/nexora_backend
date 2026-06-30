/** BullMQ queue names (doc 05 §9) and the shared job envelope. */
export const QUEUES = {
  CONNECTOR_SYNC: 'connector.sync',
  ANALYTICS_ROLLUP: 'analytics.rollup',
  PREDICTIONS_RUN: 'predictions.run',
  EMAIL_SEND: 'email.send',
  OUTBOX_PUBLISH: 'outbox.publish',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Every job carries the tenant scope so processors can rebuild a RequestContext. */
export interface JobEnvelope<T = Record<string, unknown>> {
  tenantId: string;
  userId?: string;
  membershipId?: string;
  storeId?: string;
  correlationId?: string;
  payload: T;
}
