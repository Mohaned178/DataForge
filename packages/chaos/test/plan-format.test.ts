import { DeliveryPlanParseError, parseDeliveryPlan, planDelivery, serializeDeliveryPlan } from '../src';
import { canonicalLog, exampleProfile } from './support/fixtures';

describe('delivery-plan.jsonl', () => {
  const plan = planDelivery({ events: canonicalLog('ecommerce-small'), profile: exampleProfile('lossy'), chaosSeed: '7' });
  const text = serializeDeliveryPlan(plan.attempts);

  it('writes one canonical-JSON attempt per line with a trailing newline and no carriage returns', () => {
    const lines = text.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(plan.attempts.length);
    expect(text.includes('\r')).toBe(false);
    expect(lines[0]?.startsWith('{"aggregateId":')).toBe(true);
  });

  it('round-trips every attempt exactly', () => {
    expect(parseDeliveryPlan(text)).toEqual(plan.attempts);
    expect(serializeDeliveryPlan(parseDeliveryPlan(text))).toBe(text);
  });

  it('tolerates a byte order mark and CRLF line endings', () => {
    expect(parseDeliveryPlan(`${String.fromCharCode(0xfeff)}${text.replaceAll('\n', '\r\n')}`)).toEqual(plan.attempts);
  });

  it('names the line of an invalid attempt', () => {
    const lines = text.split('\n');
    lines[4] = lines[4]?.replace('"kind":"original"', '"kind":"bogus"') ?? '';
    expect(() => parseDeliveryPlan(lines.join('\n'))).toThrow(DeliveryPlanParseError);
    expect(() => parseDeliveryPlan(lines.join('\n'))).toThrow(/^delivery-plan\.jsonl line 5: kind: /);
  });

  it('rejects attempts that are not in delivery order', () => {
    const lines = text.split('\n');
    [lines[0], lines[1]] = [lines[1] ?? '', lines[0] ?? ''];
    expect(() => parseDeliveryPlan(lines.join('\n'))).toThrow(/line 1: deliverySequence is 2, expected 1/);
  });

  it('rejects unknown fields and blank lines', () => {
    expect(() => parseDeliveryPlan(text.replace('"kind":', '"extra":1,"kind":'))).toThrow(/line 1: .*Unrecognized key/);
    expect(() => parseDeliveryPlan(text.replace('\n', '\n\n'))).toThrow(/line 2: blank line/);
  });
});
