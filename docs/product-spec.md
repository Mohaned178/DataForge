<!-- Heading levels are kept exactly as the product owner wrote them. -->
<!-- markdownlint-disable MD001 MD025 -->

# DataForge — Product Specification and Implementation Instructions

> The product owner's original specification, kept verbatim. It is the source of truth for scope,
> principles and the milestone workflow. Decisions that refine it are recorded in `docs/adr/`;
> the current plan and status are in `docs/ROADMAP.md`.

## 1. Your Role

Act as a Senior Software Architect, Senior Backend Engineer, Data Engineer, and Technical Product Engineer.

You are responsible for implementing a real, maintainable developer product called **DataForge**.

Do not treat this as a tutorial project, a CRUD application, or a simple synthetic data generator.

I want you to build the actual application incrementally, with a strong engineering foundation, clear architecture, automated tests, and manual verification throughout development.

I am a solo developer working primarily with TypeScript and Node.js. I want to understand and participate in the implementation, not just receive a large amount of code.

Explain important architectural decisions and guide me through testing the application as it develops.

---

# 2. Product Overview

## Product Name: DataForge

**DataForge is a Data Pipeline Chaos Testing Platform.**

Its purpose is to help data engineers and backend engineers test whether their data pipelines can correctly handle abnormal event-delivery conditions.

Modern data systems process events from multiple sources. These events do not always arrive in the expected order or at the expected time.

For example:

- An event may arrive several minutes late.
- The same event may be delivered multiple times.
- Events may arrive in a different order than they were generated.
- An event may arrive after a processing window has already closed.
- A delivery attempt may fail and require a retry.

These conditions can produce incorrect downstream data, inconsistent business states, and difficult-to-debug pipeline failures.

DataForge should generate realistic business scenarios, produce a consistent stream of events, inject controlled delivery failures, and validate whether the target pipeline produces the expected results.

**The main product value is not generating data. It is discovering data-processing bugs through reproducible testing.**

---

# 3. Core Product Workflow

The intended workflow is:

1. Define a business scenario.
2. Generate a deterministic simulation of that business scenario.
3. Produce a canonical event log representing what actually happened in the simulated business world.
4. Produce the expected final business state.
5. Apply controlled delivery faults to the events.
6. Send the resulting event stream to Kafka.
7. Let a target consumer or data pipeline process those events.
8. Compare its actual output with the expected result.
9. Generate a report showing failures and inconsistencies.

### Example

A user creates an e-commerce scenario containing:

- 1,000 customers.
- 5,000 orders.
- Payments.
- Shipments.
- Order cancellations.

DataForge generates events such as:

- `CustomerRegistered`
- `OrderCreated`
- `PaymentCompleted`
- `PaymentFailed`
- `OrderCancelled`
- `ShipmentCreated`

It then applies a fault configuration:

- 5% delayed events.
- 3% duplicated events.
- 2% out-of-order deliveries.

The event stream is delivered through Kafka to the system being tested.

DataForge then verifies whether the target system produces the correct final state.

For example, it should detect if a duplicated `PaymentCompleted` event caused a customer to be charged twice or if an out-of-order event caused an incorrect order status.

These percentages must be configurable. They are examples, not hardcoded rules.

---

# 4. Core Architectural Principles

Follow these principles throughout development.

## 4.1 Deterministic Simulation

The same scenario configuration, seed, engine version, and supported runtime contract must produce the same simulation output.

Use seeded pseudorandom number generation.

Avoid uncontrolled sources of randomness such as `Math.random()`.

Randomness should be isolated by purpose and entity so that changing execution order does not unnecessarily change unrelated generated data.

Entity IDs and event IDs should be generated deterministically.

Do not use random UUIDs for values that affect simulation reproducibility.

Use explicit stable ordering wherever ordering matters.

Avoid relying on implicit object iteration order, database result order, or worker execution order.

Use integer representations for money and other values where floating-point precision could create inconsistent results.

## 4.2 Event-Sourced Simulation Core

The canonical business event log is the source of truth for the simulated world.

Expected database state should be derived from replaying the canonical business events through deterministic projections.

However, do not assume Event Sourcing automatically guarantees consistency.

The system must explicitly handle:

- Cross-entity business constraints.
- Event ordering.
- Duplicate event identities.
- State transitions.
- Schema versions.
- Projection replay.
- Failed delivery attempts.

Keep the canonical event log separate from the event delivery process.

**Never modify the canonical event history when injecting delivery chaos.**

## 4.3 Separate Business Events from Delivery Attempts

A business event and its delivery attempt are different concepts.

For example, one `PaymentCompleted` business event may have two delivery attempts because the first attempt was duplicated.

The duplicated delivery must preserve the original business event identity while having distinguishable delivery metadata.

The system must be able to explain:

- Which business event was generated.
- When it occurred in simulation time.
- When each delivery attempt was scheduled.
- Whether it was delayed, duplicated, or reordered.
- Whether it was successfully delivered.

## 4.4 Explicit Simulation Time

Use a controlled simulation clock.

Do not use the machine's current time as the source of business-event timestamps.

Distinguish between:

- Event time: when the business event occurred.
- Delivery time: when the event was delivered to the target.
- Processing time: when the target processed the event.

Use a stable representation such as integer milliseconds relative to a fixed simulation epoch.

Handle time zones and serialization explicitly.

## 4.5 Modular Monolith

Build a modular monolith.

Do not introduce microservices.

Keep the simulation engine independent from NestJS, Prisma, PostgreSQL, Kafka, and React.

The core simulation logic should be usable as a TypeScript library.

## 4.6 No AI in the Core

Do not introduce AI or LLM calls into the simulation engine.

Use deterministic algorithms and configurable probabilistic models where appropriate.

AI is not a requirement for this product.

---

# 5. Technology Stack

Use the following technologies unless the existing repository or a concrete technical limitation justifies a change.

You are responsible for validating the technical choices and proposing justified alternatives when necessary. Do not change the stack without explaining why.

| Area | Technology |
| --- | --- |
| Main Language | TypeScript |
| Runtime | Node.js |
| Backend API | NestJS |
| Frontend | React + TypeScript + Vite |
| Main Database | PostgreSQL |
| ORM | Prisma |
| Event Streaming | Apache Kafka |
| Kafka Client | KafkaJS |
| Validation | Zod |
| Package Manager | pnpm |
| Local Infrastructure | Docker Compose |
| Testing - Backend/Core | Jest |
| Testing - Frontend | Vitest + React Testing Library |
| End-to-End Testing | Playwright |
| Visualization | React Flow and a suitable charting library when needed |

Additional preferences:

- Use pnpm workspaces for the monorepo if the repository is greenfield.
- Enable strict TypeScript settings.
- Use environment variables for configuration.
- Maintain an `.env.example` file.
- Keep the Docker Compose environment reproducible.
- Pin dependency versions through the package manifest and lockfile.
- Use Kafka in KRaft mode for local development rather than introducing ZooKeeper.
- Do not introduce Redis without a concrete requirement.
- Do not introduce worker threads until profiling proves they are needed.
- Do not introduce DuckDB until there is a concrete analytical or export requirement.
- Do not introduce Kubernetes or microservices.

---

# 6. High-Level Architecture

Organize the application around the following logical responsibilities. You may refine the boundaries and propose additional modules when justified by the actual implementation requirements.

## Simulation Core

Responsible for:

- Scenario definitions.
- Business entities.
- Business rules.
- Simulation clock.
- Deterministic random generation.
- Event scheduling.
- Canonical event generation.
- Expected-state projection.

It must not depend on NestJS, Prisma, KafkaJS, or frontend packages.

## Persistence Layer

Responsible for:

- Simulation run metadata.
- Scenario versions.
- Seeds and engine versions.
- Canonical event log persistence.
- Expected-state snapshots.
- Test execution metadata.
- Run history.

Use PostgreSQL and Prisma.

## Event Delivery Layer

Responsible for:

- Sending events to Kafka.
- Applying delivery policies.
- Scheduling delayed events.
- Delivering duplicate events.
- Reordering deliveries.
- Recording delivery attempts and outcomes.

## Chaos Engine

Responsible for:

- Fault configuration.
- Deterministic fault selection.
- Late-event injection.
- Duplicate-event injection.
- Out-of-order delivery.
- Delivery-failure simulation.

## Validation Engine

Responsible for:

- Comparing expected and actual results.
- Detecting missing business entities.
- Detecting duplicate processing.
- Checking business invariants.
- Checking referential integrity.
- Producing structured test results.

## Backend API

NestJS will expose operations for:

- Creating scenarios.
- Managing simulation configurations.
- Starting simulation runs.
- Managing chaos configurations.
- Starting test executions.
- Retrieving reports and run history.

## Frontend

React will provide an interface for:

- Scenario configuration.
- Simulation execution.
- Chaos configuration.
- Test monitoring.
- Result exploration.
- Failure reports.

Do not implement the entire frontend before the simulation engine and testing workflow work correctly.

---

# 7. Initial Product Scope

The initial product should focus on one complete vertical use case: an e-commerce event-processing pipeline.

Support these entities:

- Customer
- Product
- Order
- Payment
- Shipment

Support a limited set of business events:

- CustomerRegistered
- OrderCreated
- PaymentCompleted
- PaymentFailed
- OrderCancelled
- ShipmentCreated
- ShipmentDelivered

Implement meaningful business constraints.

Examples:

- An order must reference an existing customer.
- An order must reference an existing product.
- A payment must reference an existing order.
- A shipment must reference an existing order.
- A shipment cannot be created for an order that has not reached the required payment state.
- An order cannot transition through invalid state transitions.

These are initial rules. Organize the rule implementation so that new rules can be added without rewriting the engine.

Initial output formats:

- Canonical event log as JSONL.
- Kafka event stream.
- PostgreSQL persistence for application data and expected-state information.

Do not initially support multiple databases, graph outputs, XML, API mocking, or arbitrary business-domain modeling.

---

# 8. Implementation Planning and Execution Strategy

**You must determine the implementation roadmap yourself. Do not follow a predefined phase breakdown or assume a fixed number of phases.**

First inspect the repository and understand its current state, architecture, dependencies, existing code, and constraints.

Then create an implementation plan based on:

- The actual repository structure.
- The product requirements in this specification.
- Technical dependencies between components.
- The complexity and risk of each capability.
- The smallest useful, independently testable increments.
- The need to validate the core product value early.

You decide how to divide the work into milestones, their order, and their scope.

For each milestone, define:

1. Its objective.
2. The functionality included.
3. The architectural decisions required.
4. Dependencies on existing components.
5. Expected code and documentation changes.
6. Automated tests.
7. Acceptance criteria.
8. Manual verification test cases.

Prefer milestones that deliver working, testable behavior rather than milestones organized only around technical layers.

For example, a complete vertical slice that generates a scenario, produces events, injects a fault, and verifies an observable result may be more valuable than implementing several disconnected infrastructure modules.

Do not over-engineer the roadmap. Keep the first milestones small enough to be implemented and verified reliably.

### Execution Rules

- Implement only one milestone at a time.
- Do not implement future milestones before the current one is verified.
- Do not generate the entire application in one response.
- Do not skip testing to move faster.
- Do not add features outside the agreed milestone.
- If implementation reveals a need to change the roadmap, explain the reason and update it.
- Keep the roadmap updated as the project evolves.

At the end of each milestone, stop implementation and wait for my manual verification results and explicit approval.

---

# 9. Testing Requirements

Testing is not optional.

Every milestone must include automated tests and manual verification.

## Automated Testing

Write appropriate tests based on the functionality being implemented:

- Unit tests for domain logic.
- Determinism tests for the simulation engine.
- Invariant tests for business rules.
- Integration tests for PostgreSQL.
- Integration tests for Kafka.
- Validation tests using intentionally incorrect target outputs.
- API tests for NestJS.
- UI tests when the frontend is introduced.

Do not create tests that only verify implementation details.

Prefer tests that verify observable behavior.

Do not claim a test passed unless you actually ran it.

If a test cannot run because required infrastructure is unavailable, state that explicitly.

## Manual Testing After Every Milestone

This requirement is extremely important.

At the end of every milestone, provide a dedicated section called:

**Manual Verification — [Milestone Name]**

I want to execute the tests myself and understand whether the feature works correctly.

For every manual test case, provide:

1. Test case ID.
2. What the test verifies.
3. Preconditions.
4. Exact commands or actions I should perform.
5. Expected output or behavior.
6. What indicates failure.

Prefer exact PowerShell commands because I primarily use Windows.

For example, instead of saying:

"Test deterministic generation."

Give me a specific procedure:

- Run the same scenario twice with the same seed.
- Save the generated outputs.
- Compare their checksums.
- Explain what identical and different checksums mean.

Manual tests should cover both normal behavior and failure scenarios.

Do not assume I know how to interpret every output. Explain what I should look for.

After providing the manual test cases:

**STOP IMPLEMENTATION AND WAIT FOR MY RESULTS.**

Do not continue to the next milestone automatically.

Do not implement future milestones while I am testing the current one.

When I report a failure:

1. Analyze the reported behavior.
2. Identify the likely cause.
3. Fix the current milestone.
4. Rerun the relevant automated tests.
5. Give me updated manual verification instructions.
6. Wait for my confirmation again.

Only proceed when I explicitly approve the completed milestone.

---

# 10. Engineering Standards

Follow these rules throughout implementation:

- Use strict TypeScript.
- Prefer explicit types and clear domain models.
- Keep modules cohesive and dependencies controlled.
- Avoid unnecessary abstractions.
- Avoid speculative features.
- Avoid premature optimization.
- Use dependency injection appropriately in NestJS.
- Validate external inputs.
- Handle errors explicitly.
- Use structured logging where useful.
- Keep configuration outside source code.
- Maintain database migrations.
- Avoid duplicated business rules.
- Do not silently swallow errors.
- Do not use `any` unless there is a clear justification.
- Avoid unnecessary code comments; prefer clear names and structure.
- Do not introduce dependencies without explaining their purpose.
- Do not refactor unrelated working code.
- Do not create fake implementations that pretend to support real Kafka, PostgreSQL, or simulation behavior.
- Keep the README and architecture documentation updated.
- Record important architectural decisions in short ADR documents.

Before adding a new abstraction, explain why it is needed.

If a design choice has multiple viable approaches, briefly compare them and choose one with a technical justification. Do not turn every implementation detail into a long discussion.

---

# 11. Scope Restrictions

Do not add these features to the initial MVP:

- AI generation.
- LLM integrations.
- Visual scenario builders.
- Multi-tenant SaaS infrastructure.
- Authentication and billing.
- Kubernetes.
- Microservices.
- Multiple database engines.
- Graph databases.
- XML and arbitrary document generation.
- General-purpose API mocking.
- Enterprise privacy features.
- Marketplace for scenarios.
- Advanced statistical learning.
- Distributed simulation across multiple machines.

These may be considered later, but they are not part of the initial implementation.

The priority is to build one reliable end-to-end testing workflow.

---

# 12. How to Start

Start by inspecting the existing repository and understanding its current state.

Do not immediately generate a large amount of code.

Your first response should contain:

1. Repository assessment.
2. Proposed project structure.
3. Architecture boundaries.
4. Identified technical risks and dependencies.
5. Your proposed implementation roadmap, with milestones you determine yourself.
6. The objective and scope of the first milestone.
7. Any actual blockers.

Explain why you chose this implementation order.

After presenting the plan, implement only the first milestone.

At its completion, provide:

- A summary of what was implemented.
- Important architectural decisions.
- Files created or modified.
- Automated test results, including commands executed.
- Acceptance criteria status.
- Manual verification test cases with exact PowerShell commands.
- Any known limitations or remaining issues.

Then stop and wait for my test results and explicit approval.

Remember:

**You determine the roadmap. We implement one milestone at a time. Automated tests first, my manual tests next, and my explicit approval before moving forward.**

The goal is not to produce the maximum amount of code quickly.

The goal is to build DataForge correctly, understand every important part, and verify each step before adding more complexity.
