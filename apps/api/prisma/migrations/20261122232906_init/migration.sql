-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "scenario" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_version" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "scenario_hash" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulation_run" (
    "id" UUID NOT NULL,
    "scenario_version_id" UUID NOT NULL,
    "seed" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "event_count" INTEGER,
    "manifest" JSONB,
    "summary" JSONB,

    CONSTRAINT "simulation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_event" (
    "run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "event_time_ms" BIGINT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "canonical_event_pkey" PRIMARY KEY ("run_id","sequence")
);

-- CreateTable
CREATE TABLE "expected_state_snapshot" (
    "run_id" UUID NOT NULL,
    "last_sequence" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "expected_state_snapshot_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scenario_name_key" ON "scenario"("name");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_version_scenario_id_version_key" ON "scenario_version"("scenario_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_version_scenario_id_scenario_hash_key" ON "scenario_version"("scenario_id", "scenario_hash");

-- CreateIndex
CREATE INDEX "simulation_run_scenario_version_id_requested_at_idx" ON "simulation_run"("scenario_version_id", "requested_at");

-- CreateIndex
CREATE INDEX "simulation_run_status_requested_at_idx" ON "simulation_run"("status", "requested_at");

-- CreateIndex
CREATE INDEX "simulation_run_requested_at_idx" ON "simulation_run"("requested_at");

-- CreateIndex
CREATE INDEX "canonical_event_run_id_type_sequence_idx" ON "canonical_event"("run_id", "type", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_event_run_id_event_id_key" ON "canonical_event"("run_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_event_run_id_aggregate_id_aggregate_version_key" ON "canonical_event"("run_id", "aggregate_id", "aggregate_version");

-- AddForeignKey
ALTER TABLE "scenario_version" ADD CONSTRAINT "scenario_version_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_run" ADD CONSTRAINT "simulation_run_scenario_version_id_fkey" FOREIGN KEY ("scenario_version_id") REFERENCES "scenario_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_event" ADD CONSTRAINT "canonical_event_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expected_state_snapshot" ADD CONSTRAINT "expected_state_snapshot_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Immutability (hand-written; Prisma does not model triggers). A scenario version and a stored canonical
-- event never change once written: a new definition is a new version, and the canonical history of a run
-- is never modified (spec 4.2). Deleting a run still removes its events (ON DELETE CASCADE).
CREATE FUNCTION "dataforge_refuse_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "scenario_version_immutable" BEFORE UPDATE ON "scenario_version"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();

CREATE TRIGGER "canonical_event_immutable" BEFORE UPDATE ON "canonical_event"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();
