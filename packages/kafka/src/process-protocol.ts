import { z } from 'zod';

/** Messages between the delivering process and a consumer process it started (Node IPC). */
export const consumerToParentSchema = z.discriminatedUnion('type', [
  /** Joined the group; the partitions assigned to it. */
  z.strictObject({ type: z.literal('ready'), partitions: z.array(z.number().int().min(0)) }),
  /** Wrote its files and is exiting with code 0. */
  z.strictObject({ type: z.literal('finished') }),
  /** Stopped because of an error; exits with code 1. */
  z.strictObject({ type: z.literal('failed'), message: z.string() }),
]);
export type ConsumerToParent = z.output<typeof consumerToParentSchema>;

export const parentToConsumerSchema = z.discriminatedUnion('type', [
  /** Lag is zero: finish the target, write the files, leave the group and exit. */
  z.strictObject({ type: z.literal('finish') }),
]);
export type ParentToConsumer = z.output<typeof parentToConsumerSchema>;
