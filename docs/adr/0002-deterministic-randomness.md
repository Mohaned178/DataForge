# ADR-0002: Deterministic randomness with per-entity, per-purpose streams

Status: Accepted (Milestone 1)

## Context

The same scenario, seed and engine version must produce the same output, and changing one part of
the generation must not reshuffle unrelated data. A single global PRNG fails the second requirement:
drawing one extra number anywhere shifts every later value.

## Decision

- Every random decision draws from a `RandomStream` for exactly one **(seed, purpose, entity)**, for
  example `("42", "order.lifecycle", "7")`.
- The stream state is the first 128 bits of `SHA-256("dataforge/random-stream/v1" ‖ seed ‖ purpose ‖ key)`
  (NUL-separated). SHA-256 makes collisions between streams practically impossible, which a 32-bit
  seed would not.
- The generator is **xoshiro128\*\*** (128-bit state, period 2^128 - 1). It uses only 32-bit
  integer operations, so it gives identical results on every JavaScript engine and platform. Its
  output is checked against hand-computed reference values.
- Derived values use exact integer arithmetic: unbiased bounded integers by rejection sampling
  (53-bit path for ranges above 2^32), floats from 53 random bits, Floyd's algorithm for distinct
  samples. No `Math.log`, `Math.exp` or other functions whose last bit may differ between engines.
- Each order uses three streams (`order.placement`, `order.lines`, `order.lifecycle`); customers and
  products use one each.
- `Math.random`, `crypto.randomUUID` and similar are banned from the core by ESLint.

## Consequences

- Adding an order leaves all existing orders identical; changing quantities leaves timing and
  payment outcomes identical. Both are tested.
- Stream purposes and draw order are part of the engine's output contract: changing them requires an
  `ENGINE_VERSION` bump, which the golden test enforces.
