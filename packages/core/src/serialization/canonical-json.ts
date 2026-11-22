/**
 * Deterministic JSON: object keys are sorted by UTF-16 code unit at every level, so the serialized
 * bytes never depend on the order in which object properties were assigned.
 */
export function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(canonicalize(value, '$'), null, indent);
}

/** Total, locale-independent string ordering (the same order Array.prototype.sort() uses). */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function canonicalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot serialize non-finite number at ${path}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => {
      if (item === undefined) {
        throw new TypeError(`Cannot serialize undefined array element at ${path}[${index}]`);
      }
      return canonicalize(item, `${path}[${index}]`);
    });
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new TypeError(`Cannot serialize non-plain object at ${path}`);
    }
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = canonicalize(item, `${path}.${key}`);
      }
    }
    return sorted;
  }
  throw new TypeError(`Cannot serialize value of type ${typeof value} at ${path}`);
}

/**
 * True for object literals and null-prototype objects. Compares prototype shape rather than
 * identity with Object.prototype, so objects from another realm (structuredClone results inside
 * a vm context, as under Jest) are still recognised. Maps, Dates and class instances are not.
 */
function isPlainObject(value: object): boolean {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
