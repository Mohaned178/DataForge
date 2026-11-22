# ADR-0005: Toolchain pins: TypeScript 6.0, CommonJS output, Jest with ts-jest

Status: Accepted (Milestone 1)

## Context

Versions available on 2026-11-22: Node 24.21 (local), pnpm 11.23, TypeScript 7.0.2 (`latest`),
Jest 30.5, ts-jest 29.4.15, typescript-eslint 8.73, ESLint 10.15, Zod 4.6.

## Decisions

- **TypeScript 6.0.3, not 7.0.** ts-jest declares `typescript >=4.3 <7` and typescript-eslint
  declares `>=4.8.4 <6.1.0`. TypeScript 6.0.3 satisfies both. Revisit when both support 7.
- **CommonJS output** (`module: nodenext` without `"type": "module"`). NestJS (Milestone 6) and Jest
  both work most reliably with CommonJS; Jest's ESM mode is still experimental. Node 24 can
  `require()` ESM-only dependencies if one is ever needed.
- **ts-jest in transpile-only mode** (`isolatedModules`). Type checking is done by `pnpm typecheck`,
  so tests stay fast and type errors are still caught.
- **Exact dependency versions** in `package.json` plus `pnpm-lock.yaml`.
- **pnpm 11 build-script policy**: every dependency install script must be explicitly allowed or
  denied in `pnpm-workspace.yaml`. `@parcel/watcher` (Jest watch mode) is denied because it ships
  prebuilt binaries for Windows and Linux.
- **Strict compiler settings**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, unused-code checks.
- **CI** on Ubuntu and Windows, so the golden-output test also checks determinism across operating
  systems.

## Consequences

One known trap: Jest runs tests in a separate VM context, so `instanceof` checks against built-ins
(`TypeError`, `Object.prototype`) fail for objects created by Node itself, such as `structuredClone`
results and `node:util` errors. The code uses shape checks and documented error codes instead.
