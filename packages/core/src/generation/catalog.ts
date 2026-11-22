import { productId, productSku } from '../domain/ids';
import { draftEvent, type EventDraftOf } from '../events/event-draft';
import { RandomStream } from '../random/random-stream';
import type { ScenarioConfig } from '../scenario/scenario-schema';
import { PRODUCT_ADJECTIVES, PRODUCT_MATERIALS, PRODUCT_NOUNS } from './vocabulary';

export const CATALOG_PUBLISHED_AT_MS = 0;

export interface GeneratedProduct {
  readonly productId: string;
  readonly priceMinor: number;
}

export interface GeneratedCatalog {
  readonly products: readonly GeneratedProduct[];
  readonly events: readonly EventDraftOf<'ProductCreated'>[];
}

/** The catalog exists at the simulation epoch, before any customer can place an order. */
export function generateCatalog(scenario: ScenarioConfig, seed: string): GeneratedCatalog {
  const { productCount, priceMinor, currency } = scenario.catalog;
  const products: GeneratedProduct[] = [];
  const events: EventDraftOf<'ProductCreated'>[] = [];

  for (let productNumber = 1; productNumber <= productCount; productNumber++) {
    const random = RandomStream.derive(seed, 'catalog.product', String(productNumber));
    const id = productId(productNumber);
    const name = `${random.pick(PRODUCT_ADJECTIVES)} ${random.pick(PRODUCT_MATERIALS)} ${random.pick(PRODUCT_NOUNS)}`;
    const price = random.intInRange(priceMinor);

    products.push({ productId: id, priceMinor: price });
    events.push(
      draftEvent(
        'ProductCreated',
        { aggregateId: id, aggregateVersion: 1, eventTimeMs: CATALOG_PUBLISHED_AT_MS },
        { productId: id, sku: productSku(productNumber), name, priceMinor: price, currency },
      ),
    );
  }
  return { products, events };
}
