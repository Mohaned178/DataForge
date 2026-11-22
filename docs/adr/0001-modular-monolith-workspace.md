# ADR-0001: Modular monolith in a pnpm workspace, with a framework-free core

Status: Accepted (Milestone 1)

## Context

The specification asks for a modular monolith whose simulation engine is independent of NestJS,
Prisma, PostgreSQL, Kafka and React, and usable as a TypeScript library. The repository was empty.

## Decision

- One pnpm workspace: `packages/*` for libraries, `apps/*` for deployables.
- `@dataforge/core` depends only on `zod` and Node's built-in `crypto` (hashing only). It performs
  no I/O.
- Boundaries are enforced, not just documented: package dependencies define what can import what,
  and ESLint rules on `packages/core/src` reject I/O modules, framework imports and nondeterministic
  APIs.
- Each package has a `tsconfig.json` (type-checks `src` and `test`, no emit) and a
  `tsconfig.build.json` (emits `src` to `dist`). Jest maps `@dataforge/*` to source, so tests never
  need a build.

## Alternatives considered

- **Single package with folders**: less setup, but nothing would stop the core from importing a
  database client later.
- **TypeScript project references**: incremental builds, but more configuration than two packages
  justify today. Can be adopted later without changing code.

## Consequences

Adding a package means adding a `package.json` and two small tsconfig files. The core stays
reusable by the CLI, the API and (for schemas) the web UI.
