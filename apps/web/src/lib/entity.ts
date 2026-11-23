/**
 * The aggregate an entity's events live in. Orders, customers and products are aggregates of their
 * own; a payment or a shipment is an entity inside its order's aggregate, and its ID embeds the
 * order number (`pay_000018_2`, `shp_000018` belong to `ord_000018`; ADR-0004). Returns null for an
 * ID that does not follow the scheme, so a caller never links to a timeline that cannot exist.
 */
export function aggregateOfEntity(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'order':
      return /^ord_\d+$/.test(entityId) ? entityId : null;
    case 'customer':
      return /^cus_\d+$/.test(entityId) ? entityId : null;
    case 'product':
      return /^prd_\d+$/.test(entityId) ? entityId : null;
    case 'payment': {
      const match = /^pay_(\d+)_\d+$/.exec(entityId);
      return match ? `ord_${match[1] ?? ''}` : null;
    }
    case 'shipment': {
      const match = /^shp_(\d+)$/.exec(entityId);
      return match ? `ord_${match[1] ?? ''}` : null;
    }
    default:
      return null;
  }
}

const AGGREGATE_KINDS: Readonly<Record<string, string>> = { ord: 'Order', cus: 'Customer', prd: 'Product' };

/** "Order", "Customer" or "Product" from an aggregate ID, or "Aggregate" for an unknown prefix. */
export function aggregateKind(aggregateId: string): string {
  return AGGREGATE_KINDS[aggregateId.slice(0, 3)] ?? 'Aggregate';
}
