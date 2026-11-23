import type { DeliveryAttempt } from '@dataforge/chaos';
import { PlanDoesNotMatchLogError } from '@dataforge/targets';
import { DeliveryExecutionError, decodeDeliveryRecord, executePlan, type DeliveryRecord, type RecordSender, type SentRecord, type WallClock } from '../src';
import { EPOCH_UNIX_MS, plan, world } from './support/world';

/** A clock that only moves when the executor sleeps or a send takes time. */
class FakeClock implements WallClock {
  readonly sleeps: number[] = [];
  constructor(public time = 1_000_000) {}
  now(): number {
    return this.time;
  }
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
    return Promise.resolve();
  }
}

class RecordingSender implements RecordSender {
  readonly records: DeliveryRecord[] = [];
  readonly sentAt: number[] = [];
  constructor(
    private readonly clock: FakeClock,
    private readonly latencyMs = 0,
    private readonly failOnCall?: number,
  ) {}
  send(record: DeliveryRecord): Promise<SentRecord> {
    if (this.records.length + 1 === this.failOnCall) {
      return Promise.reject(new Error('broker went away'));
    }
    this.sentAt.push(this.clock.time);
    this.records.push(record);
    this.clock.time += this.latencyMs;
    return Promise.resolve({ partition: 0, offset: String(this.records.length - 1) });
  }
}

const simulation = world();
const flaky = plan(simulation, 'flaky-network');

function execute(attempts: readonly DeliveryAttempt[], speed: number | 'max', clock: FakeClock, sender: RecordSender) {
  return executePlan({ events: simulation.events, attempts, epochUnixMs: EPOCH_UNIX_MS, speed, sender, clock });
}

describe('plan executor', () => {
  it('stops before the next attempt once its signal is aborted (a process that is shutting down)', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const sender: RecordSender = {
      send: (record) => {
        if (decodeDeliveryRecord(record).headers.deliverySequence === 3) {
          controller.abort(new Error('the API is stopping'));
        }
        return Promise.resolve({ partition: 0, offset: '0' });
      },
    };
    const sent: number[] = [];
    const recording: RecordSender = { send: (record) => (sent.push(decodeDeliveryRecord(record).headers.deliverySequence), sender.send(record)) };
    const delivered = flaky.filter((attempt) => attempt.plannedOutcome === 'delivered').slice(0, 6);
    await expect(
      executePlan({ events: simulation.events, attempts: delivered, epochUnixMs: EPOCH_UNIX_MS, speed: 'max', sender: recording, clock, signal: controller.signal }),
    ).rejects.toThrow('the API is stopping');
    expect(sent).toEqual(delivered.slice(0, sent.length).map((attempt) => attempt.deliverySequence));
    expect(sent.at(-1)).toBe(3);
  });

  it('at speed max sends every delivered attempt once, in delivery order, without waiting', async () => {
    const clock = new FakeClock();
    const sender = new RecordingSender(clock);
    const result = await execute([...flaky].reverse(), 'max', clock, sender);
    const delivered = flaky.filter((attempt) => attempt.plannedOutcome === 'delivered');
    expect(sender.records.map((record) => decodeDeliveryRecord(record).headers.attemptId)).toEqual(delivered.map((attempt) => attempt.attemptId));
    expect(clock.sleeps).toEqual([]);
    expect(result).toMatchObject({ sent: delivered.length, plannedFailures: flaky.length - delivered.length, maxDriftMs: null });
    expect(result.log.map((entry) => entry.deliverySequence)).toEqual(flaky.map((attempt) => attempt.deliverySequence));
    expect(result.log.every((entry) => entry.dueAtMs === null && entry.driftMs === null)).toBe(true);
  });

  it('logs a planned failure without sending it, and records partition and offset of each sent record', async () => {
    const clock = new FakeClock();
    const result = await execute(flaky, 'max', clock, new RecordingSender(clock));
    const failures = result.log.filter((entry) => entry.outcome === 'planned-failure');
    expect(failures.length).toBe(flaky.filter((attempt) => attempt.plannedOutcome === 'failed').length);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((entry) => entry.partition === null && entry.offset === null && entry.ackedAtMs === null)).toBe(true);
    const sent = result.log.filter((entry) => entry.outcome === 'sent');
    expect(sent.map((entry) => entry.offset)).toEqual(sent.map((_, index) => String(index)));
  });

  it('at a numeric speed waits until each attempt is due: plan time since the first attempt, divided by the speed', async () => {
    const clock = new FakeClock();
    const sender = new RecordingSender(clock);
    const speed = 10_000;
    const result = await execute(flaky, speed, clock, sender);
    const base = flaky[0]!.scheduledDeliveryTimeMs;
    for (const entry of result.log) {
      expect(entry.dueAtMs).toBe(Math.floor((entry.scheduledDeliveryTimeMs - base) / speed));
      expect(entry.startedAtMs).toBe(entry.dueAtMs);
      expect(entry.driftMs).toBe(0);
    }
    expect(result.maxDriftMs).toBe(0);
    expect(result.durationMs).toBe(result.log[result.log.length - 1]!.dueAtMs);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(result.durationMs);
  });

  it('reports drift when sending is slower than the plan, and never sends ahead of time', async () => {
    const clock = new FakeClock();
    const sender = new RecordingSender(clock, 40);
    const result = await execute(flaky, 50_000, clock, sender);
    expect(result.maxDriftMs).toBeGreaterThan(0);
    expect(result.maxDriftMs).toBe(Math.max(...result.log.map((entry) => entry.driftMs ?? 0)));
    expect(result.log.every((entry) => (entry.driftMs ?? 0) >= 0)).toBe(true);
    const sent = result.log.filter((entry) => entry.outcome === 'sent');
    expect(sent.every((entry) => entry.ackedAtMs === entry.startedAtMs + 40)).toBe(true);
  });

  it('stops at the first failed send and reports the attempt and what was sent before it', async () => {
    const clock = new FakeClock();
    const failing = execute(flaky, 'max', clock, new RecordingSender(clock, 0, 5));
    await expect(failing).rejects.toBeInstanceOf(DeliveryExecutionError);
    const error = (await failing.catch((caught: unknown) => caught)) as DeliveryExecutionError;
    expect(error.message).toMatch(/broker went away/);
    expect(error.log.filter((entry) => entry.outcome === 'sent')).toHaveLength(4);
    expect(error.attempt.plannedOutcome).toBe('delivered');
  });

  it('rejects an invalid speed and a plan that does not belong to the log', async () => {
    const clock = new FakeClock();
    await expect(execute(flaky, 0, clock, new RecordingSender(clock))).rejects.toThrow(RangeError);
    await expect(execute(flaky, Number.NaN, clock, new RecordingSender(clock))).rejects.toThrow(RangeError);
    const foreign = [{ ...flaky[0]!, eventId: 'evt_unknown' }];
    await expect(execute(foreign, 'max', clock, new RecordingSender(clock))).rejects.toBeInstanceOf(PlanDoesNotMatchLogError);
  });
});
