import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DAY_MS, EventLogParseError, parseEventLog, parseUtcInstant, simTimeToIso, type CanonicalEvent } from '@dataforge/core';
import { EXIT_FAILED, EXIT_OK, UsageError, formatCount, padRight, type CliIo } from '../cli-io';
import { RUN_FILES, readManifest, readRunFile } from '../run-directory';

export const TIMELINE_USAGE = 'dataforge timeline --run <directory> --aggregate <id>   (e.g. ord_000042, cus_000007)';

export function runTimeline(args: readonly string[], io: CliIo): number {
  const { values } = parseArgs({
    args: [...args],
    options: { run: { type: 'string' }, aggregate: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (values.run === undefined || values.aggregate === undefined) {
    throw new UsageError(`Missing required option.\nUsage: ${TIMELINE_USAGE}`);
  }
  const directory = resolve(values.run);
  const manifest = readManifest(directory);
  const text = readRunFile(directory, RUN_FILES.events);
  if (text === undefined) {
    throw new UsageError(`${RUN_FILES.events} not found in ${directory}`);
  }
  let events: CanonicalEvent[];
  try {
    events = parseEventLog(text);
  } catch (error) {
    if (error instanceof EventLogParseError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const aggregateId = values.aggregate;
  const timeline = events.filter((event) => event.aggregateId === aggregateId);
  if (timeline.length === 0) {
    io.err(`No events found for aggregate "${aggregateId}".`);
    return EXIT_FAILED;
  }

  const epochUnixMs = parseUtcInstant(manifest.simulation.epoch);
  io.out(`Timeline of ${aggregateId}: ${timeline.length} event(s). Simulation epoch ${manifest.simulation.epoch}`);
  io.out(`  ${padRight('ver', 4)} ${padRight('seq', 8)} ${padRight('event time (UTC)', 25)} ${padRight('sim time', 18)} ${padRight('type', 19)} details`);
  for (const event of timeline) {
    io.out(
      `  ${padRight(String(event.aggregateVersion), 4)} ${padRight(String(event.sequence), 8)} ` +
        `${padRight(simTimeToIso(epochUnixMs, event.eventTimeMs), 25)} ${padRight(formatSimTime(event.eventTimeMs), 18)} ` +
        `${padRight(event.type, 19)} ${describeEvent(event)}`,
    );
  }
  return EXIT_OK;
}

/** "2d 03:04:05.006": days and clock time elapsed since the simulation epoch. */
export function formatSimTime(simTimeMs: number): string {
  const days = Math.floor(simTimeMs / DAY_MS);
  const rest = simTimeMs % DAY_MS;
  const hours = Math.floor(rest / 3_600_000);
  const minutes = Math.floor((rest % 3_600_000) / 60_000);
  const seconds = Math.floor((rest % 60_000) / 1_000);
  const millis = rest % 1_000;
  const two = (value: number) => String(value).padStart(2, '0');
  return `${days}d ${two(hours)}:${two(minutes)}:${two(seconds)}.${String(millis).padStart(3, '0')}`;
}

/** One line of the event's business details, for timelines and explanations. */
export function describeEvent(event: CanonicalEvent): string {
  switch (event.type) {
    case 'ProductCreated':
      return `${event.payload.sku} "${event.payload.name}" price=${event.payload.priceMinor} ${event.payload.currency}`;
    case 'CustomerRegistered':
      return `${event.payload.name} <${event.payload.email}> ${event.payload.country}`;
    case 'OrderCreated':
      return `customer=${event.payload.customerId} lines=${event.payload.lines.length} total=${formatCount(event.payload.totalMinor)} ${event.payload.currency}`;
    case 'PaymentFailed':
      return `${event.payload.paymentId} attempt=${event.payload.attempt} amount=${formatCount(event.payload.amountMinor)} reason=${event.payload.reason}`;
    case 'PaymentCompleted':
      return `${event.payload.paymentId} attempt=${event.payload.attempt} amount=${formatCount(event.payload.amountMinor)}`;
    case 'OrderCancelled':
      return `reason=${event.payload.reason}`;
    case 'ShipmentCreated':
      return `${event.payload.shipmentId} carrier=${event.payload.carrier}`;
    case 'ShipmentDelivered':
      return event.payload.shipmentId;
  }
}
