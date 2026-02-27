---
title: "Avoid DML pitfalls that stall streaming pipelines"
impact: "CRITICAL"
impactDescription: "Prevent cluster-wide stalls from large DELETE/UPDATE operations and downstream write amplification"
tags: ["dml", "delete", "insert", "update", "write-amplification", "primary-key", "rate-limit", "backpressure", "upsert", "pk-conflict"]
---

## Problem Statement

Large DML operations (especially DELETE and UPDATE) on tables with downstream materialized views are a leading cause of cluster-wide streaming stalls in production RisingWave deployments. The core issue is not the DML type itself, but **how many rows are touched** and **how many downstream MVs amplify each change**. A single `DELETE FROM table WHERE user_id = ?` can match thousands of rows if the primary key includes a timestamp dimension, and each affected row propagates retractions through all downstream MVs — potentially stalling barriers for hours.

## The Write Amplification Problem

Every row change (INSERT, UPDATE, or DELETE) on a table propagates through **all downstream materialized views**. The total cost is:

```
Total downstream writes = (rows affected) × (number of downstream MVs) × (fanout per MV)
```

- A **DELETE** on a matched row produces a retraction (−) message that propagates downstream
- An **UPDATE** produces a retraction (−) for the old value plus an insertion (+) for the new value
- An **INSERT** with PK conflict (OVERWRITE mode) also produces a retraction + insertion

The operation type matters less than the **number of rows touched**: per row, an UPDATE usually causes more downstream churn than a DELETE because it emits both a retraction and an insertion, but in practice the dominant risk comes from how many rows are affected and how many downstream MVs fan out each change.

### Example: Multi-version PK amplifies DML scope

```sql
-- This table accumulates one row per user per day due to snapshot_date in PK
CREATE TABLE user_scores (
  team_id VARCHAR,
  user_id VARCHAR,
  snapshot_date DATE,
  score FLOAT,
  PRIMARY KEY (team_id, user_id, snapshot_date)
);

-- DANGEROUS: deletes ALL historical snapshots for this user across ALL teams
-- If the user has 365 days × 50 teams = 18,250 rows, all get deleted
DELETE FROM user_scores WHERE user_id = '12345';
-- Each of the 18,250 deletions propagates through every downstream MV
```

## Anti-Pattern: Primary Key Design That Accumulates Versions

Including a monotonically increasing column (timestamp, snapshot date, version number) in the primary key causes rows to accumulate rather than being overwritten. This makes every DML operation on the logical entity (e.g., a user) touch far more rows than expected.

```sql
-- BAD: snapshot_date in PK causes row accumulation
-- 1 user × 365 days × 50 teams = 18,250 rows per user
CREATE TABLE user_scores (
  team_id VARCHAR,
  user_id VARCHAR,
  snapshot_date DATE,
  score FLOAT,
  PRIMARY KEY (team_id, user_id, snapshot_date)
);

-- GOOD: PK reflects logical identity only — latest value overwrites previous
-- 1 user × 50 teams = 50 rows per user (regardless of how many days pass)
CREATE TABLE user_scores_current (
  team_id VARCHAR,
  user_id VARCHAR,
  score FLOAT,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (team_id, user_id)
  -- Default ON CONFLICT OVERWRITE: new INSERT replaces old row
);
```

**Guideline:**
- **Include** in PK: columns that define the logical identity of the row
- **Exclude** from PK: timestamps, snapshot dates, version numbers, or any monotonically increasing column — unless you genuinely need multi-version history in RisingWave
- If you need historical snapshots, keep only the latest version in RisingWave and sink the stream to an append-only store (Iceberg, ClickHouse) for history

## Best Practice: Soft Delete Instead of Physical Delete

When you need to logically remove data, consider **updating a status column** or **overwriting with neutral values** instead of deleting the row. This way:

- Only the rows you explicitly touch are affected (no multi-version PK amplification)
- Downstream MVs see an update, not a removal — which may be cheaper if downstream aggregations handle zero/null values gracefully

```sql
-- Instead of deleting all scores for a user (touching many rows):
DELETE FROM user_scores WHERE user_id = '12345';

-- Update a flag or set score to zero on the current-version table:
UPDATE user_scores_current SET score = 0, updated_at = NOW()
WHERE user_id = '12345';
-- Only touches 50 rows (one per team) instead of 18,250
```

This requires **application-level cooperation**: downstream MVs and queries must treat `score = 0` or `is_active = false` as logically deleted. This is not always possible, but when it is, it dramatically reduces write amplification.

## Best Practice: DML Rate Limiting

Use `dml_rate_limit` as a safety net to prevent any DML from overwhelming the streaming pipeline:

```sql
-- Set DML rate limit on tables with many downstream MVs
ALTER TABLE user_scores SET dml_rate_limit TO 500;  -- rows per second

-- Remove rate limit when done
ALTER TABLE user_scores SET dml_rate_limit TO DEFAULT;
```

**When to apply:**
- Before running any batch DML that affects > 1,000 rows
- Permanently on tables that receive bursty external writes and have many downstream MVs
- On dimension/parameter tables where application-triggered updates can cascade widely

## Best Practice: Batch Large DML Operations

When you must touch many rows, break the operation into small batches:

```sql
-- BAD: unbounded delete touching potentially millions of rows
DELETE FROM event_log WHERE status = 'expired';

-- BETTER: scope to a narrow range and repeat
DELETE FROM event_log
WHERE status = 'expired'
  AND created_at < '2025-01-01'
  AND created_at >= '2024-12-01';
-- Wait for barrier latency to return to normal, then delete the next month
```

**Operational guidelines:**
- Monitor barrier latency between batches — wait for it to drop below 10 seconds before proceeding
- Notify the team before running any DML affecting > 1,000 rows on tables with downstream MVs
- Schedule large DML during low-traffic windows
- Consider setting `dml_rate_limit` before starting the batch

## Best Practice: Dimension Table Updates

Dimension/parameter tables (small tables that many MVs join against) are especially sensitive to DML — a single row change can trigger recalculation across many downstream MVs.

```sql
-- Changing one parameter row may trigger recalculation across all downstream MVs
UPDATE product_parameters SET discount_rate = 0.15 WHERE category = 'electronics';
```

**Guidelines for dimension table DML:**
- Prefer a single `UPDATE` over client-side `DELETE` + `INSERT` — both result in a retraction + insertion in downstream MVs, but `UPDATE` executes as one DML statement and avoids two separate client operations
- Apply `dml_rate_limit` on dimension tables permanently
- Announce changes to the team before updating dimension tables in production
- If updating many rows in a dimension table, batch the updates and monitor barrier latency between batches

## PK Conflict Behavior Reference

RisingWave supports three conflict resolution modes on tables with primary keys, configured via `ON CONFLICT`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `OVERWRITE` (default) | Replaces the entire row | Upsert / latest-wins pattern |
| `DO NOTHING` | Silently discards the duplicate | Deduplication at ingestion |
| `DO UPDATE IF NOT NULL` | Only overwrites non-NULL incoming columns | Partial updates from sparse sources |

```sql
CREATE TABLE my_table (
  id VARCHAR PRIMARY KEY,
  name VARCHAR,
  score INT
) ON CONFLICT OVERWRITE;            -- default: full row replacement

CREATE TABLE my_table (
  id VARCHAR PRIMARY KEY,
  name VARCHAR,
  score INT
) ON CONFLICT DO NOTHING;            -- discard duplicates

CREATE TABLE my_table (
  id VARCHAR PRIMARY KEY,
  name VARCHAR,
  score INT
) ON CONFLICT DO UPDATE IF NOT NULL;  -- partial update
```

### Version column for ordering

Both `OVERWRITE` and `DO UPDATE IF NOT NULL` support an optional version column. An insert only takes effect if the new row's version is >= the existing row's version:

```sql
CREATE TABLE my_table (
  id VARCHAR PRIMARY KEY,
  data VARCHAR,
  version BIGINT
) ON CONFLICT OVERWRITE WITH VERSION COLUMN(version);
-- Only overwrites if new version >= existing version
```

## Diagnosis: Identifying DML-Caused Stalls

```sql
-- Step 1: Check if a DML is currently running
SHOW PROCESSLIST;
-- Look for INSERT/UPDATE/DELETE statements with long duration

-- Step 2: Kill the problematic DML if needed
KILL '<process_id>';

-- Step 3: Check barrier latency
-- In Grafana: Streaming > Barrier Latency
-- If latency spiked right after a DML operation, the DML is the cause

-- Step 4: Check state table sizes for write amplification evidence
SELECT t.id, r.name, t.total_key_count,
       round((t.total_key_size + t.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats t
JOIN rw_catalog.rw_relations r ON t.id = r.id
ORDER BY t.total_key_count DESC
LIMIT 20;
```

## Emergency: DML Stalled the Cluster

1. **Kill the DML process**: `SHOW PROCESSLIST;` then `KILL '<pid>';`
2. **If propagation is already in-flight** (barrier stuck but DML already committed): killing the connection will not stop downstream propagation
3. **Pause source ingestion** to free resources: `ALTER SOURCE my_source SET source_rate_limit = 0;`
4. **Wait for barrier latency to drop** — monitor the Grafana barrier latency panel
5. **If the cluster cannot recover**: see [perf-barrier-stuck](./perf-barrier-stuck.md) for emergency actions including `pause_on_next_bootstrap`

## Source Ingestion and Write Amplification

Tables ingested via connectors (Kafka, Kinesis, CDC) are subject to the same write amplification as manual DML. Bursty source writes have the same downstream fanout effect — every row ingested propagates through all downstream MVs.

### Unnecessary Column Updates from Sources

A common hidden cause of excessive downstream churn is **semantically identical rows being treated as updates**. This happens when the upstream data producer sends values that are logically equivalent but differ in serialization:

- **Array element reordering**: `["a", "b"]` vs `["b", "a"]` — RisingWave treats these as different values, triggering a retraction + insertion
- **JSON key ordering**: `{"x":1, "y":2}` vs `{"y":2, "x":1}` — different serialization = perceived row change
- **Floating-point precision**: `0.1 + 0.2` producing `0.30000000000000004` vs `0.3`
- **Timestamp formatting differences**: microsecond vs millisecond precision changes

Each such "phantom update" generates a full retraction + insertion cycle through every downstream MV, even though the logical data hasn't changed.

**Mitigation:**
- Coordinate with upstream data producers to normalize serialization order (sort array elements, use canonical JSON, consistent precision)
- If normalization isn't possible, consider `DO NOTHING` conflict mode to discard duplicates (only works if the PK matches exactly)
- Use `source_rate_limit` on tables with high-frequency phantom updates to cap the downstream damage: `ALTER TABLE my_table SET source_rate_limit = 1000;`

## Additional Context

- DML cost is fundamentally about **rows touched × downstream fanout**, not about DELETE vs UPDATE vs INSERT
- Even a single-row UPDATE on a dimension table can be expensive if dozens of MVs depend on it
- Consider sinking historical data to external stores (Iceberg, ClickHouse) and keeping only the latest version in RisingWave

## Reference

- [RisingWave PK Conflict Behavior](https://docs.risingwave.com/sql/commands/sql-create-table#pk-conflict-behavior)
- [RisingWave DELETE](https://docs.risingwave.com/sql/commands/sql-delete)
- [RisingWave UPDATE](https://docs.risingwave.com/sql/commands/sql-update)
- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/performance-best-practices)
