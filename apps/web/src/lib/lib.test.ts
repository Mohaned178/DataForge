import { describe, expect, test } from 'vitest';
import type { Attempt } from '../api/schemas';
import { aggregateKind, aggregateOfEntity } from './entity';
import { describeAttempt, describeFault } from './faults';
import { formatCount, formatDuration, formatMoney, formatPercent, formatSimTime, formatSpan, formatTimestamp, shortId } from './format';
import { offsetOf, paramOf, wholeParamOf, withParams } from './query';

describe('formatting', () => {
  test('counts get thousands separators and percentages one decimal, whatever the locale', () => {
    expect(formatCount(486)).toBe('486');
    expect(formatCount(2525664)).toBe('2,525,664');
    expect(formatPercent(0.05)).toBe('5.0%');
    expect(formatPercent(0.0183)).toBe('1.8%');
  });

  test('durations read at the scale of the value', () => {
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(2500)).toBe('2.5 s');
    expect(formatDuration(65_000)).toBe('1 min 5 s');
    expect(formatDuration(600_000)).toBe('10 min');
    expect(formatDuration(11_295_521)).toBe('3 h 8 min');
    expect(formatDuration(90_000_000)).toBe('1 d 1 h');
  });

  test('simulation time is time since the scenario epoch, with days only when there are some', () => {
    expect(formatSimTime(0)).toBe('T+00:00:00.000');
    expect(formatSimTime(27_656_934)).toBe('T+07:40:56.934');
    expect(formatSimTime(143_866_347)).toBe('T+1d 15:57:46.347');
  });

  test('timestamps are always UTC and a missing one is a dash', () => {
    expect(formatTimestamp('2026-11-23T12:18:11.728Z')).toBe('2026-11-23 12:18:11 UTC');
    expect(formatTimestamp(null)).toBe('—');
    expect(formatSpan('2026-11-23T12:18:11.728Z', '2026-11-23T12:18:11.900Z')).toBe('172 ms');
    expect(formatSpan('2026-11-23T12:18:11.728Z', null)).toBe('—');
  });

  test('money is shown from integer minor units without floating point', () => {
    expect(formatMoney(6310, 'USD')).toBe('63.10 USD');
    expect(formatMoney(5, 'EUR')).toBe('0.05 EUR');
    expect(formatMoney(2525664)).toBe('25,256.64 USD');
  });

  test('a UUID is shortened to its distinguishing end', () => {
    expect(shortId('01a2085b-c4dc-74dc-8d2e-a0f38e136f8b')).toBe('8e136f8b');
    expect(shortId('ord_1')).toBe('ord_1');
  });
});

describe('entity to aggregate', () => {
  test('orders, customers and products are their own aggregates', () => {
    expect(aggregateOfEntity('order', 'ord_000018')).toBe('ord_000018');
    expect(aggregateOfEntity('customer', 'cus_000009')).toBe('cus_000009');
    expect(aggregateOfEntity('product', 'prd_000003')).toBe('prd_000003');
  });

  test('a payment and a shipment live in their order aggregate', () => {
    expect(aggregateOfEntity('payment', 'pay_000018_2')).toBe('ord_000018');
    expect(aggregateOfEntity('shipment', 'shp_000018')).toBe('ord_000018');
  });

  test('an ID that does not follow the scheme has no timeline to link to', () => {
    expect(aggregateOfEntity('order', 'ord_x')).toBeNull();
    expect(aggregateOfEntity('payment', 'pay_000018')).toBeNull();
    expect(aggregateOfEntity('shipment', 'ord_000018')).toBeNull();
    expect(aggregateOfEntity('warehouse', 'wh_1')).toBeNull();
  });

  test('aggregate IDs name their kind', () => {
    expect(aggregateKind('ord_000018')).toBe('Order');
    expect(aggregateKind('cus_000009')).toBe('Customer');
    expect(aggregateKind('prd_000003')).toBe('Product');
    expect(aggregateKind('zzz_1')).toBe('Aggregate');
  });
});

describe('fault descriptions', () => {
  test('each fault says what it did, with the numbers behind it', () => {
    expect(describeFault({ type: 'delay', delayMs: 217_626 })).toBe('Delayed by 3 min 38 s');
    expect(describeFault({ type: 'reorder', behindEventId: 'evt_ord_000088_3', distance: 1, shiftMs: 11_295_521 })).toBe(
      'Reordered behind evt_ord_000088_3, the next event of its aggregate, 3 h 8 min later',
    );
    expect(describeFault({ type: 'reorder', behindEventId: 'evt_a_3', distance: 2, shiftMs: 0 })).toContain('a delay already put it there');
    expect(describeFault({ type: 'late', windowCloseMs: 54_600_000, behindEventId: 'evt_ord_000012_3', shiftMs: 1_129_355 })).toBe(
      'Late: held until after its window closed, behind evt_ord_000012_3, 18 min 49 s later',
    );
    expect(describeFault({ type: 'transientFailure', failure: 2, failures: 3 })).toBe('Delivery failure 2 of 3');
    expect(describeFault({ type: 'duplicate', copy: 1, copies: 1 })).toBe('Extra copy 1 of 1');
  });

  test('a retry or a duplicate also says which attempt it follows', () => {
    const duplicate = {
      kind: 'duplicate',
      derivedFrom: { attemptId: 'att_ord_000018_3_1', offsetMs: 26_360 },
      faults: [{ type: 'duplicate', copy: 1, copies: 1 }],
    } as unknown as Attempt;
    expect(describeAttempt(duplicate)).toEqual(['Extra copy 1 of 1', 'Redelivered 26.4 s after att_ord_000018_3_1']);
    const retry = { kind: 'retry', derivedFrom: { attemptId: 'att_x_3_1', offsetMs: 27_069 }, faults: [] } as unknown as Attempt;
    expect(describeAttempt(retry)).toEqual(['Retry 27.1 s after att_x_3_1']);
    const original = { kind: 'original', derivedFrom: null, faults: [] } as unknown as Attempt;
    expect(describeAttempt(original)).toEqual([]);
  });
});

describe('query parameters', () => {
  test('the offset is a whole number from the URL, 0 when absent or invalid', () => {
    expect(offsetOf(new URLSearchParams('offset=50'))).toBe(50);
    expect(offsetOf(new URLSearchParams(''))).toBe(0);
    expect(offsetOf(new URLSearchParams('offset=-3'))).toBe(0);
    expect(offsetOf(new URLSearchParams('offset=abc'))).toBe(0);
  });

  test('changing a filter returns to the first page, and an empty value removes the filter', () => {
    const current = new URLSearchParams('status=failed&offset=50');
    expect(withParams(current, { verdict: 'FAIL' }).toString()).toBe('status=failed&verdict=FAIL');
    expect(withParams(current, { status: undefined }).toString()).toBe('');
    expect(withParams(current, { offset: '75' }).toString()).toBe('status=failed&offset=75');
  });

  test('a page with two lists pages and filters each without disturbing the other', () => {
    const current = new URLSearchParams('offset=50&wcategory=window-undercount&woffset=25');
    expect(withParams(current, { woffset: '50' }, 'woffset').toString()).toBe('offset=50&wcategory=window-undercount&woffset=50');
    expect(withParams(current, { wcategory: undefined }, 'woffset').toString()).toBe('offset=50');
    expect(withParams(current, { category: 'status-mismatch' }).toString()).toBe('wcategory=window-undercount&woffset=25&category=status-mismatch');
  });

  test('parameters read as text or as an ordinal', () => {
    const params = new URLSearchParams('event=evt_a_1&finding=0&open=x1&empty=');
    expect(paramOf(params, 'event')).toBe('evt_a_1');
    expect(paramOf(params, 'empty')).toBeUndefined();
    expect(wholeParamOf(params, 'finding')).toBe(0);
    expect(wholeParamOf(params, 'open')).toBeUndefined();
    expect(wholeParamOf(params, 'missing')).toBeUndefined();
  });
});
