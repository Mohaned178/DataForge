import type { ConsumerGroupDescription, GroupLag } from '@dataforge/kafka';
import { externalPipelineProblem } from '../src/external-group';

const ACTIVE: ConsumerGroupDescription = { groupId: 'pipeline', state: 'Stable', members: [{ clientId: 'shop', topics: ['orders'] }] };
const CAUGHT_UP: GroupLag = { total: 0, partitions: [{ partition: 0, endOffset: '0', committedOffset: null, lag: 0 }] };

const check = (overrides: Partial<Parameters<typeof externalPipelineProblem>[0]>) =>
  externalPipelineProblem({ topic: 'orders', groupId: 'pipeline', partitions: 1, group: ACTIVE, lag: CAUGHT_UP, ...overrides });

describe('the checks before an external execution produces its first record', () => {
  it('accept an active group on the topic that has consumed everything in it', () => {
    expect(check({})).toBeUndefined();
    expect(check({ group: { ...ACTIVE, state: 'PreparingRebalance' } })).toBeUndefined();
  });

  it('refuse a topic that does not exist', () => {
    expect(check({ partitions: undefined, lag: undefined })).toBe(
      'Topic "orders" does not exist. An external execution produces to your pipeline\'s topic: create it, and start your pipeline on it, before the execution.',
    );
  });

  it('refuse a group without an active member: its lag would never reach zero', () => {
    expect(check({ group: { groupId: 'pipeline', state: 'Dead', members: [] } })).toBe(
      'Consumer group "pipeline" has no active member (group state Dead). Start your pipeline, consuming "orders" with group "pipeline", ' +
        'before the execution: without an active member the group\'s lag never reaches zero.',
    );
  });

  it('refuse a group whose members subscribe to other topics, and accept one whose subscription cannot be read', () => {
    expect(check({ group: { ...ACTIVE, members: [{ clientId: 'a', topics: ['payments', 'customers'] }] } })).toBe(
      'No member of consumer group "pipeline" subscribes to "orders" (the group subscribes to "customers", "payments").',
    );
    expect(check({ group: { ...ACTIVE, members: [{ clientId: 'a', topics: undefined }] } })).toBeUndefined();
  });

  it('refuse a group with records it has not consumed yet: they could not be told from the execution', () => {
    const lag: GroupLag = { total: 3, partitions: [{ partition: 0, endOffset: '3', committedOffset: null, lag: 3 }] };
    expect(check({ lag })).toMatch(/^Consumer group "pipeline" has 3 records of "orders" it has not consumed yet\./);
  });
});
