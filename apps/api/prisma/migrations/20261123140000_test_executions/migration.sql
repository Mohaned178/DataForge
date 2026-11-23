-- CreateEnum
CREATE TYPE "execution_status" AS ENUM ('queued', 'running', 'awaiting_actual_state', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "verdict" AS ENUM ('PASS', 'FAIL');

-- CreateTable
CREATE TABLE "chaos_profile" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chaos_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chaos_profile_version" (
    "id" UUID NOT NULL,
    "chaos_profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "profile_hash" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chaos_profile_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_execution" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "chaos_profile_version_id" UUID NOT NULL,
    "chaos_seed" TEXT NOT NULL,
    "planner_version" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "status" "execution_status" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "attempt_count" INTEGER,
    "verdict" "verdict",
    "finding_count" INTEGER,
    "window_finding_count" INTEGER,
    "work_directory" TEXT,

    CONSTRAINT "test_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempt" (
    "execution_id" UUID NOT NULL,
    "delivery_sequence" INTEGER NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "planned_outcome" TEXT NOT NULL,
    "scheduled_delivery_time_ms" BIGINT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_time_ms" BIGINT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "derived_from" JSONB,
    "faults" JSONB NOT NULL,
    "kafka_outcome" TEXT,
    "kafka_partition" INTEGER,
    "kafka_offset" TEXT,
    "due_at_ms" INTEGER,
    "started_at_ms" INTEGER,
    "acked_at_ms" INTEGER,
    "drift_ms" INTEGER,

    CONSTRAINT "delivery_attempt_pkey" PRIMARY KEY ("execution_id","delivery_sequence")
);

-- CreateTable
CREATE TABLE "execution_file" (
    "execution_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,

    CONSTRAINT "execution_file_pkey" PRIMARY KEY ("execution_id","name")
);

-- CreateTable
CREATE TABLE "validation_report" (
    "execution_id" UUID NOT NULL,
    "verdict" "verdict" NOT NULL,
    "document" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,

    CONSTRAINT "validation_report_pkey" PRIMARY KEY ("execution_id")
);

-- CreateTable
CREATE TABLE "validation_finding" (
    "execution_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "check" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "differences" JSONB NOT NULL,
    "causes" JSONB NOT NULL,

    CONSTRAINT "validation_finding_pkey" PRIMARY KEY ("execution_id","ordinal")
);

-- CreateTable
CREATE TABLE "window_finding" (
    "execution_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "window_start_ms" BIGINT NOT NULL,
    "window_end_ms" BIGINT NOT NULL,
    "message" TEXT NOT NULL,
    "differences" JSONB NOT NULL,
    "causes" JSONB NOT NULL,

    CONSTRAINT "window_finding_pkey" PRIMARY KEY ("execution_id","ordinal")
);

-- CreateIndex
CREATE UNIQUE INDEX "chaos_profile_name_key" ON "chaos_profile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "chaos_profile_version_chaos_profile_id_version_key" ON "chaos_profile_version"("chaos_profile_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "chaos_profile_version_chaos_profile_id_profile_hash_key" ON "chaos_profile_version"("chaos_profile_id", "profile_hash");

-- CreateIndex
CREATE INDEX "test_execution_run_id_requested_at_idx" ON "test_execution"("run_id", "requested_at");

-- CreateIndex
CREATE INDEX "test_execution_chaos_profile_version_id_requested_at_idx" ON "test_execution"("chaos_profile_version_id", "requested_at");

-- CreateIndex
CREATE INDEX "test_execution_status_requested_at_idx" ON "test_execution"("status", "requested_at");

-- CreateIndex
CREATE INDEX "test_execution_requested_at_idx" ON "test_execution"("requested_at");

-- CreateIndex
CREATE INDEX "delivery_attempt_execution_id_event_id_idx" ON "delivery_attempt"("execution_id", "event_id");

-- CreateIndex
CREATE INDEX "delivery_attempt_execution_id_aggregate_id_delivery_sequenc_idx" ON "delivery_attempt"("execution_id", "aggregate_id", "delivery_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempt_execution_id_attempt_id_key" ON "delivery_attempt"("execution_id", "attempt_id");

-- CreateIndex
CREATE INDEX "validation_finding_execution_id_category_ordinal_idx" ON "validation_finding"("execution_id", "category", "ordinal");

-- CreateIndex
CREATE INDEX "validation_finding_execution_id_entity_type_entity_id_idx" ON "validation_finding"("execution_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "window_finding_execution_id_category_ordinal_idx" ON "window_finding"("execution_id", "category", "ordinal");

-- AddForeignKey
ALTER TABLE "chaos_profile_version" ADD CONSTRAINT "chaos_profile_version_chaos_profile_id_fkey" FOREIGN KEY ("chaos_profile_id") REFERENCES "chaos_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_execution" ADD CONSTRAINT "test_execution_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_execution" ADD CONSTRAINT "test_execution_chaos_profile_version_id_fkey" FOREIGN KEY ("chaos_profile_version_id") REFERENCES "chaos_profile_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "test_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_file" ADD CONSTRAINT "execution_file_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "test_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_report" ADD CONSTRAINT "validation_report_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "test_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding" ADD CONSTRAINT "validation_finding_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "test_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "window_finding" ADD CONSTRAINT "window_finding_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "test_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Immutability (hand-written; Prisma does not model triggers), with the function of the init migration.
-- A chaos profile version, a planned delivery attempt and a validation result never change once written:
-- a new profile definition is a new version, and what an execution planned, delivered and found is its
-- history. The execution row itself is not immutable: its status changes. Deleting an execution still
-- removes its rows (ON DELETE CASCADE).
CREATE TRIGGER "chaos_profile_version_immutable" BEFORE UPDATE ON "chaos_profile_version"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();

CREATE TRIGGER "delivery_attempt_immutable" BEFORE UPDATE ON "delivery_attempt"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();

CREATE TRIGGER "execution_file_immutable" BEFORE UPDATE ON "execution_file"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();

CREATE TRIGGER "validation_report_immutable" BEFORE UPDATE ON "validation_report"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();

CREATE TRIGGER "validation_finding_immutable" BEFORE UPDATE ON "validation_finding"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();

CREATE TRIGGER "window_finding_immutable" BEFORE UPDATE ON "window_finding"
    FOR EACH ROW EXECUTE FUNCTION "dataforge_refuse_update"();
