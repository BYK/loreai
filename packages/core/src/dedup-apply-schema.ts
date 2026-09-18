/**
 * Reviewed dedup apply ledger (MEM-02). Local audit/idempotency state; never
 * included in sync. Merged knowledge versions themselves stay in `knowledge`
 * (death-certificate versions), so this ledger only records WHY they merged.
 */
export const DEDUP_APPLY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS dedup_operations (
    tenant_id    TEXT    NOT NULL,
    operation_id TEXT    NOT NULL,
    project_id   TEXT    REFERENCES projects(id) ON DELETE CASCADE,
    actor        TEXT    NOT NULL,
    reviewed_at  INTEGER NOT NULL,
    payload_hash TEXT    NOT NULL,
    receipt      TEXT    CHECK(receipt IS NULL OR length(receipt) <= 4000000),
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    PRIMARY KEY (tenant_id, operation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dedup_operations_project
    ON dedup_operations(project_id, started_at);
  CREATE TABLE IF NOT EXISTS dedup_provenance (
    tenant_id          TEXT    NOT NULL,
    operation_id       TEXT    NOT NULL,
    group_index        INTEGER NOT NULL,
    keep_logical_id    TEXT    NOT NULL,
    merged_logical_id  TEXT    NOT NULL,
    merged_version_id  TEXT    NOT NULL,
    expected_revision  INTEGER NOT NULL,
    actual_revision    INTEGER NOT NULL,
    keep_expected_revision INTEGER NOT NULL,
    keep_actual_revision   INTEGER NOT NULL,
    actor              TEXT    NOT NULL,
    reviewed_at        INTEGER NOT NULL,
    applied_at         INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, operation_id, merged_logical_id),
    FOREIGN KEY (tenant_id, operation_id)
      REFERENCES dedup_operations(tenant_id, operation_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_dedup_provenance_merged
    ON dedup_provenance(merged_logical_id);
  CREATE INDEX IF NOT EXISTS idx_dedup_provenance_keep
    ON dedup_provenance(keep_logical_id);
`;
