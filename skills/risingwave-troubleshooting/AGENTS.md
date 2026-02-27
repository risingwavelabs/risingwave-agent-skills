# Agent References

> This file is auto-generated. Do not edit directly. Run `npm run build` to regenerate.

## Performance & Memory (CRITICAL)

### Diagnose and resolve barrier stuck issues

**Impact:** CRITICAL - Restore streaming pipeline within minutes, prevent data lag accumulation

**Tags:** barrier, streaming, stuck, backpressure, performance

## Problem Statement

Barrier stuck is one of the most critical issues in RisingWave. When barriers are stuck (latency > 1 minute), the entire streaming pipeline halts, causing data lag to accumulate. This affects memory management, LRU caches, and can eventually lead to OOM.

## Diagnosis Steps

### Step 1: Check Barrier Latency in Grafana

Navigate to `risingwave_dashboard` > `Streaming` > `Barrier Latency`. Look for:
- Latency > 1 minute indicates barrier stuck
- Gaps in the latency curve suggest the system was stuck

### Step 2: Use Await-Tree to Find Bottleneck

The await-tree provides async stack traces to identify where barriers are stuck:

```sql
-- Access via the meta dashboard or risectl
-- Look for the fragment/actor that is blocking
```

Common bottleneck patterns in await-tree output:
- `store_flush` - Storage/compaction backpressure
- `sink_*` - Sink is blocking (not decoupled)
- `udf_*` - Python UDF causing bottleneck
- `hummock_require_memory` - Shared buffer full

### Step 3: Check Backpressure Panel

Navigate to Grafana > `Streaming` > `Actor Output Blocking Time Ratio (Backpressure)`. High values indicate upstream actors are being blocked by downstream bottlenecks.

## Common Causes and Solutions

### Cause 1: Python UDF Bottleneck

```sql
-- Problem: MV with Python UDF is single-threaded and slow
CREATE MATERIALIZED VIEW slow_mv AS
SELECT python_udf(col) FROM source_table;
```

**Solution**: Decouple the UDF MV from the main stream:
```sql
-- Create a sink from the source to intermediate storage
CREATE SINK s FROM source_table WITH (...);
-- Create a new source from intermediate storage
CREATE SOURCE t FROM ...;
-- Create MV on the new source
CREATE MATERIALIZED VIEW mv AS SELECT python_udf(col) FROM t;
```

**Quick fix**: Drop the problematic MV if it's blocking critical pipelines.

### Cause 2: Sink Not Decoupled

```sql
-- Check if sinks are decoupled
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a JOIN rw_sinks b ON a.sink_id = b.id;
```

**Solution**: Enable sink decoupling:
```sql
SET sink_decouple = true;
-- Or for existing sinks, recreate with decoupling enabled
```

When decoupled, data is written to internal logstore first, and barrier doesn't wait for external system commit.

### Cause 3: Storage Backpressure (store_flush)

See [storage-l0-compaction-stuck](./storage-l0-compaction-stuck.md) for detailed guidance.

**Quick check**:
```sql
SELECT compaction_group_id, level_id, count(*) AS file_count
FROM rw_hummock_sstables
WHERE level_id = 0
GROUP BY compaction_group_id, level_id;
```

If L0 file count is high (> 100), compaction is falling behind.

### Cause 4: Compaction Write Stop

Check Grafana `Write Stop Compaction Groups` - non-zero indicates write stop is active.

**Solution**: See [storage-l0-compaction-stuck](./storage-l0-compaction-stuck.md).

## Emergency Actions

### Immediately Unblock Stream Graph

```sql
-- Option 1: Drop the blocking MV (if identifiable)
DROP MATERIALIZED VIEW blocking_mv;

-- Option 2: If can't drop due to barrier stuck, pause source first
ALTER SOURCE my_source SET source_rate_limit = 0;
-- Then drop
DROP MATERIALIZED VIEW blocking_mv;

-- Option 3: Force drop during recovery
-- For dirty MVs that can't be dropped normally
-- See: Drop created, but dirty MVs (drop during recovery)
```

### Progressive Source Pause and Recovery

When barrier is stuck due to overwhelming ingestion (high-throughput sources, bursty connector writes), use this progressive approach to stabilize the cluster:

**Step 1: Pause all high-throughput sources**

```sql
-- Pause all sources that might be contributing to the overload
ALTER SOURCE source_a SET source_rate_limit = 0;
ALTER SOURCE source_b SET source_rate_limit = 0;
ALTER SOURCE source_c SET source_rate_limit = 0;
-- For tables with connectors:
ALTER TABLE table_with_connector SET source_rate_limit = 0;
```

**Step 2: Trigger recovery** (requires superuser)

```sql
RECOVER;
-- Forces a clean restart of the streaming graph
-- Wait for barrier latency to drop to normal (< 10s)
```

**Step 3: Re-enable sources one at a time with throttling**

```sql
-- Start with a conservative rate limit
ALTER SOURCE source_a SET source_rate_limit = 500;
-- Monitor barrier latency in Grafana for 2-3 minutes
-- If stable, re-enable next source
ALTER SOURCE source_b SET source_rate_limit = 500;
-- Continue monitoring...

-- Once all sources are stable, gradually increase or remove limits
ALTER SOURCE source_a SET source_rate_limit = DEFAULT;
```

**Key points:**
- Re-enable sources **one at a time** — if you re-enable all at once, the accumulated backlog may stall barriers again
- Monitor barrier latency between each re-enablement — wait for it to stabilize below 10 seconds
- Rate limits are **per parallelism unit** — total throughput = parallelism × rate_limit
- `RECOVER` requires superuser privileges

### Pause System for Recovery

```sql
-- Pause on next bootstrap to allow manual intervention
ALTER SYSTEM SET pause_on_next_bootstrap = true;
-- Restart meta node to trigger recovery
-- All streams will be paused, allowing you to drop problematic MVs
```

Note: `pause_on_next_bootstrap` automatically resets after meta restarts.

## Additional Context

- Barrier latency affects memory management - LRU caches rely on barriers for eviction
- Prolonged barrier stuck often leads to OOM as memory cannot be reclaimed
- Check `rw_event_logs` for related events: `SELECT * FROM rw_event_logs ORDER BY timestamp DESC`

## Reference

- [RisingWave Troubleshooting Overview](https://docs.risingwave.com/troubleshoot/overview)
- [Diagnose High Latency / Barrier Stuck](https://docs.risingwave.com/performance/troubleshoot-high-latency#diagnosis)

---

### Diagnose and resolve Compute Node OOM

**Impact:** CRITICAL - Prevent cluster instability, restore normal operations

**Tags:** oom, memory, compute-node, crash, performance

## Problem Statement

Compute Node OOM (Out of Memory) causes pod restarts and service disruption. Memory issues can cascade across the cluster, affecting all streaming jobs. Early detection and proper diagnosis are essential for stable operations.

## Observations

1. **Grafana Memory Metrics**: Memory increases unbounded, beyond the `total_memory` limit set for CN
2. **Kubernetes Exit Code**: OOM Killed (137) - check with `kubectl describe pod xxx`
3. **No Panic Logs**: OOM typically doesn't produce panic logs before crash

## Quick Solutions

### Solution 1: Wait for Auto-Recovery

If OOM disappears after a few restarts, the system may self-heal. Monitor for stability.

### Solution 2: Reduce Channel Buffer Size

```toml
# Requires compute node restart
[streaming.developer]
stream_exchange_initial_permits = 512
```

### Solution 3: Drop Problematic MV

Usually the newly created MV is the culprit:

```sql
-- If you can identify the problematic MV
DROP MATERIALIZED VIEW problematic_mv;
```

### Solution 4: Pause System for Intervention

If OOM happens too fast to drop MV:

```sql
-- Set pause flag before recovery
ALTER SYSTEM SET pause_on_next_bootstrap = true;
-- Restart meta node - streams will be paused
-- Now you can safely drop the problematic MV
```

### Solution 5: Enable Flow Control

```sql
-- Set backfill rate limit before creating MV (limits backfill speed)
SET backfill_rate_limit = 10000;  -- records per second per parallelism
CREATE MATERIALIZED VIEW mv AS ...;

-- Or set source rate limit to slow down ingestion
SET source_rate_limit = 10000;  -- records per second per source parallelism
```

Note: Rate limit must be larger than `stream_chunk_size` (default 256).

### Solution 6: Reduce Parallelism

```sql
-- Reduce parallelism for complex MVs
SET streaming_parallelism = 4;  -- default 0 = all CPU cores
CREATE MATERIALIZED VIEW mv AS ...;
```

## Root Cause Investigation

### Check 1: Was Barrier Stuck?

Barrier stuck > 1 minute often precedes OOM because memory management relies on barriers.

```
# In Grafana: Check barrier latency panel
# Gaps or spikes > 1 minute indicate barrier issues
```

If barrier was stuck, investigate barrier issues first (see [perf-barrier-stuck](./perf-barrier-stuck.md)).

### Check 2: LRU Watermark

Navigate to Grafana > Memory Management > LRU Watermark:

- If `now - watermark_epoch` decreased to near zero: LRU worked correctly, something else consumed memory
- If diff is not zero: LRU memory controller didn't work properly, this may indicate a bug - consider filing an issue

### Check 3: Memory Profiling

When LRU is working but OOM still occurs, run memory profiling:

```bash
# Inside the compute node pod
cd /risingwave/cache
ls -laht  # Check for heap dump files

# Analyze heap dump
jeprof --collapsed /risingwave/bin/risingwave HEAP_FILE > heap.collapsed

# Download and visualize with https://www.speedscope.app/
# Click "Left Heavy" to merge shared calling stacks
```

Heap dumps are automatically generated when memory hits threshold. If missing:
- Jemalloc profiling not enabled (`MALLOC_CONF="prof:true"`)
- Folder not mounted (deleted after restart)
- Memory never hit threshold
- Files already scraped to S3

## Memory Configuration

Check CN boot logs for "Memory outline" to see current memory settings:

```bash
cat .risingwave/log/* | grep -o 'chunk_size: [0-9]*'
```

## Common OOM Causes

1. **Join Amplification**: Many-to-many joins can explode memory
2. **Large State Tables**: Check state table sizes in Grafana
3. **High Parallelism**: Too many actors consuming memory
4. **Barrier Stuck**: Memory cannot be reclaimed without barriers
5. **Memory Leaks**: Rare but possible, check heap profiles

## Additional Context

- OOM is a general problem without uniform cause - always investigate
- Don't just increase memory without understanding the root cause
- Consider cluster sizing if workload legitimately needs more memory

## Reference

- [Memory (Heap) Profiling Guide](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/benchmark-and-profile/memory-profiling.md)
- [RisingWave Troubleshooting](https://docs.risingwave.com/troubleshoot/overview)

---

### Manage background DDL and MV creation

**Impact:** HIGH - Control DDL execution, prevent cluster overload from concurrent backfills

**Tags:** ddl, materialized-view, background, backfill, creation, timeout, cancel, recover, running-queries, flush

## Problem Statement

Creating materialized views triggers backfilling from upstream tables, which can overload the cluster when multiple MVs are created concurrently. Background DDL allows non-blocking creation but can cause issues if too many jobs run simultaneously. Foreground DDL blocks the session but provides natural queuing.

## Background vs Foreground DDL

### Foreground DDL (Default)
```sql
-- Session blocks until backfill completes
CREATE MATERIALIZED VIEW my_mv AS SELECT ...;
-- Returns only when MV is fully backfilled
```

### Background DDL
```sql
-- Enable background DDL
SET background_ddl = true;

-- Returns immediately, backfill runs asynchronously
CREATE MATERIALIZED VIEW my_mv AS SELECT ...;

-- Check progress
SELECT * FROM rw_catalog.rw_ddl_progress;
```

## Common Issues and Solutions

### Issue 1: Multiple Background DDL Causing Barrier Stuck

**Symptoms**:
- High barrier latency after creating multiple MVs
- Backfill progress very slow for all jobs
- Cluster appears stuck or unresponsive

**Cause**: Multiple concurrent backfills compete for resources, overwhelming storage and compute.

**Diagnosis**:
```sql
-- Check running background DDL jobs
SELECT ddl_id, ddl_statement, progress, initialized_at
FROM rw_catalog.rw_ddl_progress
ORDER BY initialized_at;
```

**Solutions**:

1. **Use foreground DDL for natural queuing**:
```sql
SET background_ddl = false;
-- Jobs will queue automatically
CREATE MATERIALIZED VIEW mv1 AS ...;  -- Waits until complete
CREATE MATERIALIZED VIEW mv2 AS ...;  -- Starts after mv1 done
```

2. **Rate limit backfilling**:
```sql
-- Cluster-wide rate limit
ALTER SYSTEM SET backfill_rate_limit TO 200;
-- Limits to 200 rows/s per parallelism

-- Per-job rate limit
SET backfill_rate_limit = 100;
CREATE MATERIALIZED VIEW my_mv AS ...;
```

3. **Set bounded parallelism for new jobs**:
```sql
ALTER SYSTEM SET adaptive_parallelism_strategy TO 'Bounded8';
```

### Issue 2: DDL Appears Stuck (High Barrier Latency)

**Symptoms**:
- `CREATE MATERIALIZED VIEW` hangs for hours
- No progress visible
- Barrier latency in Grafana is high

**Cause**: New DDL waits for checkpoint to complete. If barriers are stuck (due to sink issues, compaction, etc.), DDL cannot proceed.

**Diagnosis**:
```sql
-- Check barrier status in Grafana
-- Streaming > Barrier Latency

-- Check for blocked DDLs
SELECT * FROM rw_catalog.rw_ddl_progress;
```

**Solution**: Fix the underlying barrier issue first (see barrier-stuck troubleshooting).

```sql
-- If caused by sink, drop problematic sink
DROP SINK blocking_sink;

-- Or pause source to reduce pressure
ALTER SOURCE my_source SET source_rate_limit = 0;
```

### Issue 3: Background DDL MV Disappears

**Symptoms**: Creating MV with background DDL, but MV is not visible after session ends.

**Cause**: Background DDL wasn't enabled when creating the MV.

**Verification**:
```sql
-- Check if background_ddl is enabled
SHOW background_ddl;

-- Must be 'true' before CREATE statement
SET background_ddl = true;
CREATE MATERIALIZED VIEW ...;
```

### Issue 4: Client Connection Timeout During Foreground DDL

**Symptoms**: Connection closes before large MV creation completes.

**Solutions**:

1. **Use background DDL**:
```sql
SET background_ddl = true;
CREATE MATERIALIZED VIEW ...;
```

2. **Use CLI with longer timeout**:
```bash
psql -h hostname -p 4566 -d dev -c "CREATE MATERIALIZED VIEW ..."
# psql has longer default timeout than cloud portal
```

3. **Note**: Client timeout doesn't kill the job if cluster doesn't recover.

## DDL Progress Monitoring

```sql
-- Check all background DDL progress
SELECT
  ddl_id,
  ddl_statement,
  create_type,
  progress,
  initialized_at
FROM rw_catalog.rw_ddl_progress
ORDER BY initialized_at;

-- Example output:
-- ddl_id | create_type | progress       | initialized_at
-- 262    | BACKGROUND  | 23.01%         | 2026-01-22 05:12:19
```

## Best Practices for Large MV Creation

### 1. Check Table Stats First
```sql
-- Estimate backfill size
SELECT count(*) FROM source_table;
```

### 2. Start with Small Parallelism
```sql
SET streaming_parallelism = 4;
SET backfill_rate_limit = 500;
CREATE MATERIALIZED VIEW ...;
```

### 3. Create MVs Sequentially
```sql
-- Use foreground DDL for automatic queuing
SET background_ddl = false;
CREATE MATERIALIZED VIEW mv1 AS ...;
CREATE MATERIALIZED VIEW mv2 AS ...;
```

### 4. Monitor During Creation
```sql
-- Check progress
SELECT * FROM rw_catalog.rw_ddl_progress;

-- Watch Grafana panels:
-- - Barrier Latency
-- - Backfill Throughput
-- - Memory Usage
```

## Snapshot Backfill: Isolate Backfill from Upstream

By default, RisingWave uses snapshot backfill (`streaming_use_snapshot_backfill = true`), which decouples the backfill phase from upstream streaming operators. This prevents new MV backfill from backpressuring existing streaming jobs.

| Aspect | Arrangement Backfill | Snapshot Backfill (default) |
|--------|---------------------|-----------------------------|
| Approach | Consumes upstream streaming data and table snapshot simultaneously | Consumes a fixed snapshot first, then catches up epoch by epoch |
| Upstream impact | Can backpressure upstream, slowing existing jobs | Minimal impact on upstream operators |
| Checkpointing | Coupled between upstream and downstream | Decoupled |

```sql
-- Explicitly enable/disable (default is true)
SET streaming_use_snapshot_backfill = true;
CREATE MATERIALIZED VIEW my_mv AS SELECT ...;
```

## Backfill Order: Control Upstream Table Sequence

When creating an MV that joins multiple tables, RisingWave backfills all upstream tables concurrently by default. This can cause **join amplification** — backfilling a large fact table first against empty dimension tables produces failed lookups and intermediate results that must be retracted later.

Use `backfill_order` to ensure dimension tables are fully backfilled before the fact table:

```sql
-- Dimension tables backfill before fact table
CREATE MATERIALIZED VIEW order_enriched
WITH (backfill_order = FIXED(customers -> orders, products -> orders))
AS
SELECT o.*, c.name, p.category
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id;
```

The `->` operator means: left side must complete backfill before right side begins.

**Note:** This is a technical preview feature (v2.5+). The ordering does not persist across background DDL restarts.

### Visualize backfill order

```sql
-- Text format
EXPLAIN (BACKFILL) CREATE MATERIALIZED VIEW ...
WITH (backfill_order = FIXED(dim -> fact)) AS SELECT ...;

-- Graphviz DOT format (paste output into a DOT renderer)
EXPLAIN (BACKFILL, FORMAT DOT) CREATE MATERIALIZED VIEW ...
WITH (backfill_order = FIXED(dim -> fact)) AS SELECT ...;
```

## Backfill Visibility and Data Completeness

Understanding when a newly created MV starts serving complete data:

### Foreground DDL (default)

The `CREATE MATERIALIZED VIEW` statement blocks until backfill is complete. Once it returns, the MV contains all historical data and begins serving real-time updates.

```sql
CREATE MATERIALIZED VIEW my_mv AS SELECT ...;
-- Blocks for minutes/hours depending on upstream table size
-- Once this returns, my_mv is fully populated
SELECT count(*) FROM my_mv;  -- Returns complete count
```

### Background DDL

The `CREATE` returns immediately, but the MV serves **partial data** during backfill. Queries against the MV will return incomplete results until backfill finishes.

```sql
SET background_ddl = true;
CREATE MATERIALIZED VIEW my_mv AS SELECT ...;
-- Returns immediately

-- MV data is incomplete during backfill
SELECT count(*) FROM my_mv;  -- May return fewer rows than expected

-- Check backfill progress
SELECT progress FROM rw_catalog.rw_ddl_progress WHERE ddl_statement LIKE '%my_mv%';
-- e.g., "45.2%" means backfill is roughly half done
```

**Important**: Sinks also backfill — a newly created sink must backfill all upstream historical data before it is considered "created". With foreground DDL, the `CREATE SINK` blocks until backfill completes.

### Estimating Backfill Completion Time

```sql
-- Check current progress and when it started
SELECT ddl_id, progress, initialized_at,
  NOW() - initialized_at AS elapsed
FROM rw_catalog.rw_ddl_progress;
```

Rough estimate: if backfill is at 25% after 1 hour, expect ~4 hours total (assumes linear progress, which is approximate — joins and aggregations may cause non-linear progress).

## Canceling Background DDL Jobs

```sql
-- View running jobs
SELECT * FROM rw_catalog.rw_ddl_progress;

-- Cancel specific jobs by ID
CANCEL JOBS '262, 273, 286';

-- Or cancel all
-- (Currently requires listing all IDs)
```

## Job Lifecycle Management

### View All Active Streaming Jobs

```sql
-- Show all active creation jobs (MVs, indexes, tables, sinks being created)
SHOW JOBS;

-- Filter by name pattern
SHOW JOBS LIKE 'mv_%';
```

Output includes job ID, DDL statement, and progress percentage.

### Cancel Running Jobs

```sql
-- Cancel specific jobs by ID
CANCEL JOBS '262, 273, 286';
```

Cancellation is not immediate — it takes effect at the next checkpoint. If barrier latency is high, cancellation may be delayed.

### Monitor Running Queries

```sql
-- Show currently executing batch queries
SHOW PROCESSLIST;
```

Useful for identifying long-running queries that may be consuming resources.

### Force Flush Pending Writes

```sql
-- Force all pending writes to be flushed to storage
FLUSH;
```

Use after DML operations (INSERT/UPDATE/DELETE) when you need results to be immediately visible for subsequent queries.

## Recovery After DDL Issues

If cluster is stuck due to DDL overload:

```sql
-- 1. Pause all sources to reduce load
ALTER SOURCE source1 SET source_rate_limit = 0;

-- 2. Cancel running background DDLs (if accessible)
CANCEL JOBS '...';

-- 3. If inaccessible, trigger recovery
-- Via cloud console or:
ALTER SYSTEM SET pause_on_next_bootstrap = true;
-- Restart meta node

-- 4. After recovery, resume sources
ALTER SOURCE source1 SET source_rate_limit = default;
```

### Manual Cluster Recovery

When the cluster is in a degraded state (high barrier latency, stuck jobs, pending DROP/CANCEL):

```sql
-- Trigger an ad-hoc recovery operation
-- Requires superuser privileges
RECOVER;
```

This forces a recovery cycle, which:
- Reschedules all streaming actors
- Applies any pending DEFERRED parallelism changes
- Makes pending DROP/CANCEL commands take effect immediately
- Resets barrier state

Use sparingly — recovery causes a brief interruption to all streaming jobs.

## Reference

- [Background DDL](https://docs.risingwave.com/sql/commands/sql-create-mv)
- [View DDL Progress](https://docs.risingwave.com/sql/commands/sql-show-jobs)
- [Backfill Rate Limit](https://docs.risingwave.com/operate/view-configure-runtime-parameters)
- [Backfill Order Control (blog)](https://risingwave.com/blog/risingwave-backfill-order-control/)

---

### Avoid DML pitfalls that stall streaming pipelines

**Impact:** CRITICAL - Prevent cluster-wide stalls from large DELETE/UPDATE operations and downstream write amplification

**Tags:** dml, delete, insert, update, write-amplification, primary-key, rate-limit, backpressure, upsert, pk-conflict

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

---

### Manage indexes for query acceleration

**Impact:** HIGH - Speed up point lookups 10-100x, reduce batch query latency

**Tags:** index, performance, query, lookup, distribution, include

## Problem Statement

RisingWave indexes are specialized materialized views sorted by the index key columns. They accelerate batch (point/range) queries but add streaming state overhead. Understanding when to create indexes, how to inspect them, and when to remove them is key to balancing query performance against resource usage.

## When to Create an Index

Create an index when:
- Batch queries filter on columns that are **not** the MV's primary key
- Point lookups on a table/MV are slow (full scan visible in EXPLAIN)
- Range scans need a different sort order than the MV arrangement key

Do **not** create an index when:
- The query already uses the MV's primary key for lookup
- The table is small enough that full scans are acceptable
- The additional streaming state cost outweighs the query benefit

## Creating Indexes

### Basic index (includes all columns by default)

```sql
-- Includes ALL columns from the source table/MV
CREATE INDEX idx_orders_customer ON orders(customer_id);
```

### Narrow index with INCLUDE

```sql
-- Only stores the indexed column plus explicitly included columns
CREATE INDEX idx_orders_customer ON orders(customer_id) INCLUDE (id, amount, created_at);
```

Use `INCLUDE` to reduce index state size when queries only need specific columns.

### Index with custom distribution

```sql
-- Override the default distribution key (first index column)
CREATE INDEX idx_orders_region ON orders(region, customer_id) DISTRIBUTED BY (region);
```

If queries filter primarily by `region`, distributing by `region` enables vnode-targeted lookups.

## Inspecting Existing Indexes

### List all indexes on a table

```sql
-- View index names, key columns, included columns, and distribution
SELECT * FROM rw_indexes WHERE primary_table_id = (
  SELECT id FROM rw_tables WHERE name = 'my_table'
);

-- Or use SHOW CREATE INDEX for the full DDL
SHOW CREATE INDEX idx_orders_customer;
```

### Check index structure

```sql
-- Describe index columns and types
DESCRIBE idx_orders_customer;
```

### Check index state size

```sql
-- Index state tables appear in rw_table_stats like any MV
SELECT s.id, s.total_key_count,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_table_stats s
JOIN rw_indexes i ON s.id = i.id
ORDER BY size_mb DESC;
```

## Verifying Index Usage

```sql
-- Check if a query uses the index
EXPLAIN SELECT * FROM orders WHERE customer_id = 123;
```

Look for `BatchLookupJoin` or `BatchScan` referencing the index name. If the optimizer chooses a full scan instead, the query pattern may not match the index key.

## Dropping Unused Indexes

Indexes consume streaming resources (actors, state storage, checkpoint I/O) even when no batch queries use them.

```sql
-- Drop an index
DROP INDEX idx_orders_customer;

-- Drop only if it exists (avoids error)
DROP INDEX IF EXISTS idx_orders_customer;

-- Drop with CASCADE if other objects depend on it
DROP INDEX idx_orders_customer CASCADE;
```

### Finding potentially unused indexes

There is no built-in usage tracking for indexes. Review indexes periodically:

```sql
-- List all indexes with their sizes
SELECT i.name AS index_name, t.name AS table_name,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_indexes i
JOIN rw_tables t ON i.primary_table_id = t.id
LEFT JOIN rw_table_stats s ON i.id = s.id
ORDER BY size_mb DESC;
```

Large indexes that are not used by any active query pattern should be dropped to reclaim resources.

## Index vs Materialized View

| Use Case | Recommendation |
|----------|---------------|
| Accelerate point lookups on existing table/MV | `CREATE INDEX` |
| Need different sort order for range scans | `CREATE INDEX` |
| Need complex transforms, aggregations, or joins | Separate MV |
| Need different output columns than the source | Separate MV selecting only needed columns |

For detailed MV design guidance, see [perf-mv-design-patterns](./perf-mv-design-patterns.md).

## Reference

- [RisingWave Indexes](https://docs.risingwave.com/processing/indexes)
- [CREATE INDEX](https://docs.risingwave.com/sql/commands/sql-create-index)

---

### Optimize streaming join performance and avoid common pitfalls

**Impact:** CRITICAL - Prevent OOMs, barrier stalls, and 10-100x latency spikes from join anti-patterns

**Tags:** join, streaming, performance, temporal-join, hash-join, state, amplification

## Problem Statement

Joins are the #1 source of latency spikes, OOMs, and barrier stalls in RisingWave streaming pipelines. Understanding join types, their state costs, and common anti-patterns is essential for building stable, performant pipelines.

## Join Types and Their Cost

### Regular (hash) joins — most expensive

Both sides are stateful. RisingWave maintains left/right state tables plus degree tables. Every update on either side probes the other side's state.

```sql
-- Hash join: 4 state tables (left, right, left degree, right degree)
-- Use only when both sides genuinely need to react to each other's changes
SELECT a.*, b.*
FROM stream_a a
JOIN stream_b b ON a.id = b.id;
```

**Parallelism tip:** Start with low parallelism for complex joins and increase only if CPU is underutilized. High parallelism on join-heavy MVs multiplies memory usage proportionally.

### Process-time temporal joins — cheapest for dimension lookups

Use `FOR SYSTEM_TIME AS OF PROCTIME()` to join a stream against a dimension table or MV. The stream side maintains **zero state** in the append-only variant — the dimension table IS the state.

```sql
-- Temporal join: zero state on stream side (append-only variant)
SELECT s.*, d.category_name
FROM stream_table s
LEFT JOIN dimension_table FOR SYSTEM_TIME AS OF PROCTIME() AS d
  ON s.dim_id = d.id;
```

**Requirements:**
- The left (stream) side must be append-only for the stateless variant
- The join condition must include the primary key of the right (dimension) table
- Non-append-only temporal joins are supported but maintain internal state

**Critical behavior:** Temporal joins are **asymmetric** — they use process-time (`PROCTIME()`) semantics, meaning the right side is a point-in-time snapshot lookup, not a reactive join. This has two important consequences:
1. Only changes on the **left (stream) side** trigger a lookup and produce output. Updates to the right (dimension) side alone do NOT produce new output — they just update the reference data for future lookups.
2. Updates to the dimension table do NOT retroactively affect previous join outputs. Once a row is joined, the result is final.

This applies to **both** append-only and non-append-only temporal join variants. The non-append-only variant only adds the ability to retract previously emitted results when the left side sends updates/deletes — it does not make the join reactive to right-side changes.

**Testing pitfall:** INSERT-based testing on the lookup (right) table side will produce 0 rows. This is expected behavior, not a bug. To test a temporal join, drive data from the stream (left) side.

**Optimization:** Create an index on the dimension table and join against the index for faster lookups.

### ASOF joins — for nearest-record matching (v2.1+ streaming, v2.3+ batch)

Avoids the state explosion of traditional range joins when matching by time or ordered properties.

```sql
SELECT *
FROM events e
ASOF LEFT JOIN prices p
  ON e.symbol = p.symbol AND e.event_time >= p.price_time;
```

**Requirements:** At least one equality condition + one inequality condition.

### Window joins and interval joins

Segment data into time windows before joining. Both require watermark-based conditions.

**Caveat:** State cleaning for interval joins is triggered only when upstream messages arrive at the join key granularity. If a particular join key stops receiving messages, its state may be retained indefinitely. Monitor for inactive keys retaining stale state.

## Choosing the Right Join Type

| Scenario | Recommended Join | Why |
|----------|-----------------|-----|
| Stream enrichment from dimension table | Temporal join | Zero state on stream side |
| Both sides are streams that must react to each other | Hash join | Only option for bi-directional reactivity |
| Nearest-match by time/ordered column | ASOF join | Avoids range join state explosion |
| Time-bounded correlation between streams | Interval/window join | Bounded state via watermarks |
| Building wide table from many sources | `SINK INTO TABLE` | Avoids multi-way join state explosion |

**Rule of thumb:** If you're using a hash join for a dimension lookup, switch to a temporal join. Check `EXPLAIN CREATE` for `StreamHashJoin` where `StreamTemporalJoin` would suffice.

## Anti-Pattern: Join amplification on low-cardinality columns

Joining on columns with few distinct values causes exponential row output.

```sql
-- BAD: low-cardinality join key causes amplification
SELECT * FROM orders o
JOIN products p ON o.category = p.category;  -- 'category' has few distinct values

-- GOOD: join on high-cardinality key
SELECT * FROM orders o
JOIN products p ON o.product_id = p.id;
```

**Diagnosis:** Check Grafana's **Streaming > Join Executor Matched Rows** panel. High matched rows indicate amplification. Also check join state table sizes:

```sql
-- Check for unexpectedly large state tables indicating join amplification
SELECT id, total_key_count,
       round((total_key_size + total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats
ORDER BY size_mb DESC
LIMIT 20;
```

## Anti-Pattern: FULL OUTER JOIN NULL amplification

With FULL OUTER JOINs on shared primary keys, intermediate NULL results multiply exponentially with the number of joins. This is distinct from low-cardinality amplification — even unique keys cause it when multiple tables are chained with outer joins.

## Anti-Pattern: Cross joins / joins without equality predicates

RisingWave disables these by default. Every new row on one side scans all rows on the other, stalling the barrier mechanism cluster-wide. If unavoidable, add a dummy equality column.

## Anti-Pattern: Dummy-column joins causing periodic batch spikes

```sql
-- BAD: dummy column join causes full table rescan on time boundaries
SELECT *
FROM fact_table f
LEFT JOIN current_day_snapshot s ON f.dummy_column = s.dummy_column;

-- GOOD: use event time or processing time for continuous processing
SELECT *
FROM fact_table f
LEFT JOIN dimension_table FOR SYSTEM_TIME AS OF PROCTIME() AS d
  ON f.dim_id = d.id;
```

Patterns like `JOIN ON dummy = dummy` cause a full update of the left table at time boundaries (e.g., start of each new day), producing barrier latency spikes and OOMs. **What to do instead:** Process data continuously using event time or processing time rather than attaching a timestamp via a dummy join.

## Best Practice: Filter before join, not after

RisingWave's optimizer may or may not push filters down. The `streaming_force_filter_inside_join` cluster setting forces filter pushdown inside the join operator in streaming mode. Always check `EXPLAIN CREATE` to verify predicates land where you expect.

```sql
-- BAD: filter after join — optimizer may not push it down
SELECT * FROM orders o
JOIN products p ON o.product_id = p.id
WHERE o.status = 'active';

-- GOOD: pre-filter in subquery to guarantee pushdown
SELECT * FROM (
  SELECT * FROM orders WHERE status = 'active'
) o
JOIN products p ON o.product_id = p.id;
```

Also ensure join inputs are **deduplicated** before joining. Large join state from un-deduped tables is a common production issue. Materialize the dedup step in an intermediate MV rather than a VIEW.

## Best Practice: Use INNER JOIN instead of LEFT JOIN when possible

`LEFT JOIN` preserves all rows from the left side even without matches, requiring more state. If your query logic doesn't need unmatched rows, use `INNER JOIN` for reduced state and better performance.

## Best Practice: Separate stable vs. unstable columns

Only include rarely-changing columns in large joined MVs. Every update to any joined column triggers a full downstream update. Defer frequently-updating columns (e.g., `current_balance`, `last_updated_at`) to a smaller downstream MV.

## Best Practice: Only select needed columns

Avoid `SELECT *` in joins. Pulling all columns when you only need a few causes unnecessary updates to propagate downstream. Use appropriate data types — smaller types mean faster comparisons and less memory.

```sql
-- BAD: selecting all columns through a join
SELECT * FROM orders o JOIN products p ON o.product_id = p.id;

-- GOOD: select only what's needed
SELECT o.order_id, o.quantity, p.name, p.price
FROM orders o JOIN products p ON o.product_id = p.id;
```

## Best Practice: Wide table with table sinks instead of multi-way LEFT JOIN

For building denormalized tables with many source columns, use `SINK INTO TABLE` to merge updates from multiple streams into a single wide table. This avoids the state explosion of a single MV with many joins.

## Best Practice: Declare append-only tables

Use `CREATE TABLE ... APPEND ONLY` for data that is never updated or deleted. This enables:
- **Temporal joins:** Stream side maintains zero state (most impactful benefit)
- **Over-window functions:** Simplified state management
- **Aggregations:** RW only needs a single data point for functions like `max(timestamp)` instead of maintaining full state for potential retractions

## Advanced: Consecutive joins optimization

RisingWave has a `streaming_separate_consecutive_join` cluster setting that inserts no-shuffle exchanges between consecutive `StreamHashJoin` operators, which can improve parallelism. When possible, restructure queries to reduce join chains instead.

## Advanced: Unaligned joins for high-amplification scenarios (v2.5+)

The `streaming_enable_unaligned_join` cluster setting buffers join output and allows checkpoint barriers to pass through immediately. This improves stability at the cost of increased latency. Useful when join amplification causes barrier stalls.

## Additional Context

- Always verify join behavior with `EXPLAIN CREATE` before deploying — look for `StreamHashJoin` vs `StreamTemporalJoin`
- For multi-way joins, use `backfill_order = FIXED(dim -> fact)` to backfill dimension tables before fact tables — see [perf-ddl-background-management](./perf-ddl-background-management.md) for syntax and details
- If barrier stuck is caused by joins, see [perf-barrier-stuck](./perf-barrier-stuck.md) for emergency actions
- If join amplification causes OOM, see [perf-compute-node-oom](./perf-compute-node-oom.md) for diagnosis
- Create indexes on dimension tables used in temporal joins for faster lookups

## Reference

- [RisingWave Joins Documentation](https://docs.risingwave.com/processing/sql/joins)
- [Maintain Wide Table with Table Sinks](https://docs.risingwave.com/processing/maintain-wide-table-with-table-sinks)
- [Understanding Streaming Joins in RisingWave](https://risingwave.com/blog/understanding-streaming-joins-in-risingwave/)

---

### Design materialized views for efficient streaming and serving

**Impact:** HIGH - Reduce state storage, improve query latency, and prevent backfill bottlenecks through proper MV design

**Tags:** materialized-view, design, index, distribution, column-selection, layering, backfill

## Problem Statement

Materialized view design directly impacts state storage size, streaming throughput, batch query latency, and backfill time. Poor column selection, missing indexes, wrong distribution keys, and monolithic MV definitions cause excessive state, slow lookups, and long recovery times. This guide covers MV design patterns for both streaming efficiency and serving performance.

## Column Selection: Avoid SELECT *

Every column in an MV becomes part of the state table stored in Hummock (RisingWave's LSM-tree state store). Unnecessary columns waste storage and increase I/O for every state read/write.

```sql
-- BAD: stores all columns even if only a few are queried
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM orders JOIN customers ON orders.customer_id = customers.id;

-- GOOD: select only the columns needed by downstream consumers
CREATE MATERIALIZED VIEW mv AS
SELECT o.id, o.amount, o.created_at, c.name, c.tier
FROM orders o JOIN customers c ON o.customer_id = c.id;
```

**Note:** Intermediate operator state (join state, aggregation state) only stores columns referenced by the query. The final MV state table stores all output columns. So narrowing the column list reduces the final MV state and any indexes built on it.

## MV Layering: Decompose Complex Pipelines

Decomposing a complex MV with many CTEs/subqueries into multiple independent MVs has two key benefits:

1. **No additional computation cost** — decomposition does not increase computational overhead, only storage (typically negligible with cloud object storage)
2. **Reduced backfill contention** — during initial backfill or recovery, independent MVs can backfill in parallel without competing for the same resources

```sql
-- Instead of one monolithic MV:
CREATE MATERIALIZED VIEW final AS
WITH enriched AS (
  SELECT ... FROM orders JOIN customers ON ...
),
aggregated AS (
  SELECT ... FROM enriched GROUP BY ...
)
SELECT ... FROM aggregated JOIN products ON ...;

-- Decompose into layers:
CREATE MATERIALIZED VIEW enriched_orders AS
SELECT ... FROM orders JOIN customers ON ...;

CREATE MATERIALIZED VIEW order_stats AS
SELECT ... FROM enriched_orders GROUP BY ...;

CREATE MATERIALIZED VIEW final AS
SELECT ... FROM order_stats JOIN products ON ...;
```

**When to decompose:**
- The MV has multiple joins followed by aggregations
- Multiple downstream MVs share the same intermediate computation
- Backfill of the monolithic MV takes too long or causes memory pressure
- You need to inspect intermediate results for debugging

**When NOT to decompose:**
- The query is simple (single scan + filter + project)
- No downstream MVs share intermediate state
- The added storage is a concern (rare with object storage)

## Indexes: When and How

In RisingWave, an index is a specialized MV sorted by the index key columns. Key differences from PostgreSQL:

### Default behavior: all columns included

By default, `CREATE INDEX` includes **all columns** of the source table/MV — not just the indexed columns. This eliminates primary table lookups (which are slow in cloud environments) but increases storage.

```sql
-- Includes ALL columns from orders (wide index)
CREATE INDEX idx_orders_customer ON orders(customer_id);

-- Narrow index: only includes columns needed for the query
CREATE INDEX idx_orders_customer ON orders(customer_id) INCLUDE (id, amount);
```

Use `INCLUDE` to limit which columns are stored in the index when you know the query pattern.

### Distribution key for indexes

The default distribution key is the first index column. Override with `DISTRIBUTED BY` when query patterns provide different filter columns:

```sql
-- Queries filter by region, then customer_id
CREATE INDEX idx ON orders(region, customer_id) DISTRIBUTED BY (region);
```

If a query only provides a prefix of the distribution key, RisingWave cannot target specific vnodes and must scan all of them.

### CREATE INDEX vs separate MV

| Use Case | Recommendation |
|----------|---------------|
| Accelerate point lookups on existing table/MV | `CREATE INDEX` |
| Need different sort order for range scans | `CREATE INDEX` |
| Need complex transforms, aggregations, or joins | Separate MV |
| Need different output columns than the source | Separate MV |

## Distribution and Data Skew

Data is distributed across vnodes via consistent hashing on the distribution key. Skewed distribution causes hot vnodes and uneven parallelism.

### How distribution keys are chosen

| Object | Default Distribution Key |
|--------|------------------------|
| Table (with PK) | Primary key columns |
| Table (without PK) | Hidden `_row_id` column |
| MV with GROUP BY | GROUP BY columns (HashAgg shuffles by group key) |
| MV without GROUP BY | Derived from upstream stream key |
| Index | First index column (override with `DISTRIBUTED BY`) |

### Diagnosing skew

```sql
-- Check vnode distribution for a table (WARNING: full table scan)
SELECT rw_vnode(distribution_key_column) AS vnode, COUNT(*)
FROM my_table
GROUP BY vnode
ORDER BY count DESC
LIMIT 20;
```

If a few vnodes have significantly more rows than others, the distribution key has poor cardinality or skewed values. Consider using a higher-cardinality column or a composite key.

For parallelism tuning guidance, see [perf-streaming-tuning](./perf-streaming-tuning.md).

## Stream Key and Arrangement Key

Understanding these internal concepts helps interpret EXPLAIN output and diagnose state issues.

### Stream key

The unique key derived bottom-up through the operator tree. It guarantees that INSERT and DELETE operations with the same stream key alternate (no duplicate inserts, no phantom deletes). The stream key is:
- **Table scan**: table's primary key
- **Aggregation**: GROUP BY columns
- **Join**: combination of both sides' primary keys
- **Filter/Project**: preserves upstream stream key

### Arrangement key (pk_columns)

The primary key of the final state table. Determines physical sort order in the LSM tree. Visible in EXPLAIN output:

```
StreamMaterialize { columns: [...], stream_key: [order_id], pk_columns: [order_id], pk_conflict: NoCheck }
```

For joins, the state table uses the **join key as prefix** of the arrangement key. For example, joining on `customer_id` produces state table PK `[customer_id, order_id]`, enabling efficient prefix scans during join lookups.

## Verifying MV Design with EXPLAIN

For a comprehensive guide to all EXPLAIN variants, reading streaming plans, and runtime analysis, see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md).

Key MV design elements to verify in EXPLAIN output:
- `StreamMaterialize { pk_columns: [...] }` — the arrangement key (see Stream Key and Arrangement Key above)
- `StreamExchange { dist: HashShard(...) }` — data shuffle boundaries indicating distribution key
- For join operators (`StreamHashJoin` vs `StreamTemporalJoin`), see [perf-join-optimization](./perf-join-optimization.md)
- For `StreamGroupTopN` vs `StreamOverWindow`, see [perf-window-and-aggregation](./perf-window-and-aggregation.md)
- For `StreamDynamicFilter` / `StreamNow` (temporal filters), see [perf-temporal-filters-and-state](./perf-temporal-filters-and-state.md)

## Reference

- [RisingWave Indexes](https://docs.risingwave.com/processing/indexes)
- [RisingWave CREATE MATERIALIZED VIEW](https://docs.risingwave.com/sql/commands/sql-create-mv)
- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/performance-best-practices)
- [RisingWave DESCRIBE](https://docs.risingwave.com/sql/commands/sql-describe)

---

### Refactor and optimize existing MV pipelines

**Impact:** HIGH - Reduce pipeline latency 30-60% by eliminating redundant MVs, unnecessary joins, and wasted state

**Tags:** materialized-view, pipeline, refactoring, optimization, dependency-graph, collapse, correctness, swap, zero-downtime

## Problem Statement

Existing streaming pipelines often accumulate redundant MVs over time — wrapper MVs that only rename columns, CROSS JOINs that produce no useful output, unused aggregation layers, and unnecessary intermediate steps. Refactoring these pipelines requires systematic analysis: mapping the dependency graph, identifying safe collapses, proving correctness after each change, and measuring the impact of each optimization independently.

This skill covers **refactoring an existing pipeline**, not writing new MVs from scratch. For MV design guidance, see [perf-mv-design-patterns](./perf-mv-design-patterns.md).

## Step 1: Map the MV Dependency Graph

Before optimizing, understand the full pipeline topology.

### Query the dependency graph

```sql
-- Get all MV-to-MV dependencies
SELECT
  parent.name AS upstream_name,
  child.name AS downstream_name,
  child.definition
FROM rw_catalog.rw_depend d
JOIN rw_catalog.rw_materialized_views child ON d.objid = child.id
JOIN rw_catalog.rw_relations parent ON d.refobjid = parent.id
ORDER BY parent.name, child.name;
```

For finding all downstream dependents of a specific table or MV, see [diag-essential-queries](./diag-essential-queries.md).

### Identify the pipeline structure

Draw or list the MV layers: source tables at the bottom, final serving MVs at the top. For each MV, note:
- **Input sources** — which tables or MVs it reads from
- **Transformation** — what it computes (filter, join, aggregate, passthrough)
- **Consumers** — which downstream MVs or sinks read from it
- **State size** — query `rw_table_stats` to see how much storage it uses

```sql
-- Check state size for all MVs
SELECT m.name, s.total_key_count,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats s
JOIN rw_catalog.rw_materialized_views m ON s.id = m.id
ORDER BY size_mb DESC;
```

### Identify the critical path

The critical path is the longest chain of MVs from source to final output. Barrier latency is bounded by the slowest operator on this path. Use `EXPLAIN ANALYZE` to find bottleneck operators — see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md).

## Step 2: Identify Optimization Candidates

### Pattern 1: Wrapper MVs (passthrough / rename-only)

MVs that simply SELECT columns from an upstream MV without filtering, joining, or aggregating.

```sql
-- Wrapper MV: just renames columns
CREATE MATERIALIZED VIEW mv_wrapper AS
SELECT user_id AS uid, order_total AS total, created_at AS ts
FROM mv_base;
```

**Why it's wasteful:** Adds an extra layer of state storage, an extra streaming operator, and an extra barrier checkpoint. Every update to `mv_base` propagates through `mv_wrapper` unchanged.

**Safe to collapse when:** All downstream consumers can be rewritten to reference `mv_base` directly (with column aliases in their own SELECT lists).

### Pattern 2: CROSS JOIN for zero-fill that is a no-op

A common pattern is CROSS JOINing a dimension (e.g., all time slots or categories) to produce zero-filled rows. If every downstream consumer has a `GROUP BY` that re-aggregates these rows, the zero-fill produces no net effect.

```sql
-- Zero-fill MV: CROSS JOIN produces all combinations
CREATE MATERIALIZED VIEW mv_zero_filled AS
SELECT d.date_slot, c.category, COALESCE(f.value, 0) AS value
FROM date_dimension d
CROSS JOIN category_dimension c
LEFT JOIN fact_table f ON f.date = d.date_slot AND f.category = c.category;

-- Downstream: GROUP BY collapses the zero-fill anyway
CREATE MATERIALIZED VIEW mv_daily_totals AS
SELECT date_slot, SUM(value) AS total
FROM mv_zero_filled
GROUP BY date_slot;
```

**Why it's wasteful:** The CROSS JOIN materializes `|dates| x |categories|` rows in state. If the downstream GROUP BY doesn't need zero-filled rows (only non-zero aggregates), this is wasted compute and memory.

**Safe to collapse when:** The downstream GROUP BY produces the same result whether or not zero rows are included. Test by comparing output with and without the zero-fill layer.

**Impact:** Removing unnecessary CROSS JOINs is often the single largest optimization, commonly yielding 50%+ latency reduction.

### Pattern 3: Redundant aggregation layers

An MV that pre-aggregates data, followed by another MV that re-aggregates. If the second aggregation could operate directly on the source data, the intermediate step is unnecessary.

```sql
-- Redundant: two-step aggregation where one step suffices
CREATE MATERIALIZED VIEW mv_hourly AS
SELECT date_trunc('hour', ts) AS hour, category, SUM(amount) AS total
FROM events GROUP BY 1, 2;

CREATE MATERIALIZED VIEW mv_daily AS
SELECT date_trunc('day', hour) AS day, category, SUM(total) AS daily_total
FROM mv_hourly GROUP BY 1, 2;
```

**When the intermediate layer is justified:**
- Multiple downstream MVs consume the same intermediate aggregation (shared computation)
- You need the intermediate result for debugging or serving
- The intermediate layer reduces join amplification downstream (pre-aggregate before join)

**When it's redundant:** Only one downstream consumer exists, and it could compute the same result directly from the source.

### Pattern 4: Unused columns in wide intermediate MVs

An intermediate MV selects many columns, but downstream consumers only use a subset.

```sql
-- Wide intermediate MV
CREATE MATERIALIZED VIEW mv_enriched AS
SELECT o.*, p.name, p.category, p.weight, p.supplier, p.warehouse_location
FROM orders o JOIN products p ON o.product_id = p.id;

-- Downstream only uses name and category
CREATE MATERIALIZED VIEW mv_summary AS
SELECT o.order_id, o.name, o.category, o.amount
FROM mv_enriched o;
```

**Fix:** Narrow the intermediate MV to only include columns actually used downstream. This reduces state size and update propagation. For column selection guidance, see [perf-mv-design-patterns](./perf-mv-design-patterns.md).

## Step 3: Variable Isolation — One Change at a Time

When refactoring a pipeline, **never apply all optimizations simultaneously**. Each optimization should be tested independently to:
1. Verify correctness (output matches before and after)
2. Measure the specific impact (latency, throughput, state size)
3. Identify which changes help and which are neutral or harmful

### Methodology

1. **Establish baseline metrics** — Record current barrier latency, throughput, and state sizes for all MVs in the pipeline
2. **Create one variant** — Apply a single optimization (e.g., collapse one wrapper MV)
3. **Verify correctness** — Compare output of the optimized pipeline against the baseline (see Step 4)
4. **Measure impact** — Record the same metrics and compare
5. **Build a comparison matrix** — Track each optimization's individual contribution

```
| Variant      | Change                    | Barrier Lat | Throughput | State Size |
|-------------|---------------------------|-------------|------------|------------|
| Baseline     | (none)                    | 2.4s        | 5K rps     | 12 GB      |
| V1           | Collapse wrapper MV       | 2.2s        | 5.2K rps   | 10 GB      |
| V2           | Remove CROSS JOIN zero-fill| 1.1s       | 9K rps     | 4 GB       |
| V3           | Narrow wide intermediate  | 2.0s        | 5.5K rps   | 8 GB       |
| V1+V2+V3     | All combined              | 0.9s        | 10K rps    | 3 GB       |
```

### Prioritize by expected impact

Estimate the impact of each optimization before implementing:
- **CROSS JOIN removal** — Highest impact when downstream re-aggregates (typically 50%+ latency reduction)
- **Wrapper MV collapse** — Moderate impact (reduces pipeline depth by 1 layer per collapse)
- **Column narrowing** — Moderate impact proportional to the number of removed columns
- **Redundant aggregation collapse** — Impact depends on intermediate state size

**Focus on the single biggest lever first.** In most cases, unnecessary joins (CROSS JOIN, hash join where temporal join suffices) dominate over other inefficiencies.

## Step 4: Correctness Verification

After each change, verify the optimized pipeline produces identical output.

### Method 1: Output comparison via EXCEPT

```sql
-- Compare two MVs for equivalence
-- Should return 0 rows if identical
(SELECT * FROM mv_optimized EXCEPT SELECT * FROM mv_original)
UNION ALL
(SELECT * FROM mv_original EXCEPT SELECT * FROM mv_optimized);
```

**Important:** This compares point-in-time snapshots. For streaming pipelines, pause sources (set `source_rate_limit = 0`) before comparing to ensure both MVs have processed the same data.

### Method 2: Row count sanity check

```sql
-- Quick sanity check (not a full correctness proof — use Method 1 for that)
SELECT 'original' AS source, count(*) AS row_count FROM mv_original
UNION ALL
SELECT 'optimized', count(*) FROM mv_optimized;
```

### Method 3: Downstream validation

If the MV being collapsed has downstream consumers, verify those consumers produce the same output after the upstream change.

### Verification checklist

- Row counts match between original and optimized
- Output comparison (EXCEPT) returns zero rows
- All downstream MVs produce unchanged output
- No new errors in `rw_event_logs`
- State size is equal or smaller (never larger for a valid collapse)

## Step 5: Safe Collapse Procedure

### Collapsing a wrapper MV

1. Identify all downstream consumers of the wrapper MV
2. Rewrite each downstream consumer to reference the wrapper's upstream source directly
3. Create the new downstream MVs (with `background_ddl` if needed)
4. Verify correctness (Step 4)
5. Drop the old downstream MVs
6. Drop the wrapper MV

**Important:** You cannot ALTER a running MV's definition. Collapsing always requires creating new MVs and dropping old ones. Plan for backfill time — see [perf-ddl-background-management](./perf-ddl-background-management.md).

### Collapsing an intermediate aggregation

1. Rewrite the downstream MV to compute the aggregation directly from the source
2. Verify the new SQL produces equivalent results using batch queries before creating the streaming MV
3. Create the new MV and verify output matches
4. Drop the old downstream MV and intermediate aggregation MV

### Removing a CROSS JOIN zero-fill layer

1. Verify the downstream GROUP BY produces the same result without zero-filled rows
2. Rewrite the downstream MV to read directly from the fact table (skip the CROSS JOIN layer)
3. Run correctness verification
4. Drop the old downstream MV and zero-fill MV

## Step 6: Monitor After Deployment

After deploying the optimized pipeline:

```sql
-- Check barrier latency in Grafana: Streaming > Barrier Latency

-- Verify state sizes decreased
SELECT m.name, s.total_key_count,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats s
JOIN rw_catalog.rw_materialized_views m ON s.id = m.id
ORDER BY size_mb DESC;

-- Check for any system events/errors
SELECT * FROM rw_event_logs ORDER BY timestamp DESC LIMIT 20;
```

Use `EXPLAIN ANALYZE` on the optimized pipeline to verify the bottleneck has shifted — see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md).

## Zero-Downtime MV Migration with SWAP

When refactoring an MV, downstream consumers may reference it by name. Dropping and recreating creates a gap. Use `ALTER MATERIALIZED VIEW ... SWAP WITH ...` to atomically swap two MVs' names.

### Swap Procedure

```sql
-- 1. Create the optimized replacement MV with a temporary name
SET background_ddl = true;
CREATE MATERIALIZED VIEW mv_optimized_v2 AS
SELECT ... ;  -- improved definition

-- 2. Wait for backfill to complete
SELECT * FROM rw_catalog.rw_ddl_progress;

-- 3. Verify correctness (pause sources first for exact comparison)
ALTER SOURCE my_source SET source_rate_limit = 0;
(SELECT * FROM mv_optimized_v2 EXCEPT SELECT * FROM mv_original)
UNION ALL
(SELECT * FROM mv_original EXCEPT SELECT * FROM mv_optimized_v2);
ALTER SOURCE my_source SET source_rate_limit = default;

-- 4. Atomically swap names (mv_original becomes mv_optimized_v2 and vice versa)
ALTER MATERIALIZED VIEW mv_original SWAP WITH mv_optimized_v2;

-- 5. Drop the old version (now named mv_optimized_v2)
DROP MATERIALIZED VIEW mv_optimized_v2;
```

### Requirements and Limitations

- Both MVs must have the **same output schema** (same column names, types, and order)
- The swap is **atomic** — no window where the name is missing
- Downstream MVs that reference by name are **not** automatically updated (they reference by internal ID, which doesn't change). The swap only affects the name-to-ID mapping for new queries and new DDL.
- Existing downstream MVs continue reading from the **same internal ID** they were created with. To fully migrate a pipeline, you need to recreate downstream MVs after the swap.

### When to Use SWAP vs Drop-and-Recreate

| Scenario | Approach |
|----------|----------|
| Leaf MV (no downstream dependents) served by batch queries | SWAP — zero-downtime for batch queries using the MV name |
| MV with downstream streaming dependents | Drop-and-recreate downstream first, then swap or drop the old MV |
| Schema change (different output columns) | Drop-and-recreate — SWAP requires identical schemas |

## Common Pitfalls

### Pitfall 1: Testing with single events

Single-event tests (INSERT one row, check output) are insufficient for validating streaming pipeline changes. Aggregation operators, window functions, and temporal filters behave differently under volume. Always test with representative data volumes. See [diag-benchmark-environment-guide](./diag-benchmark-environment-guide.md).

### Pitfall 2: Forgetting to account for backfill time

Collapsing MVs requires creating new ones, which triggers backfill. Factor in backfill time when planning the migration, especially for large source tables.

### Pitfall 3: Dropping MVs with dependents

You cannot drop an MV that has downstream dependents. Use `CASCADE` cautiously — it drops all dependents too. Instead, follow the bottom-up approach: recreate dependents first, then drop in reverse dependency order.

```sql
-- Check what depends on an MV before dropping
SELECT child.name AS dependent_name, child.definition
FROM rw_catalog.rw_depend d
JOIN rw_catalog.rw_materialized_views child ON d.objid = child.id
WHERE d.refobjid = (SELECT id FROM rw_materialized_views WHERE name = 'my_mv');
```

### Pitfall 4: Assuming column removal is free

Removing columns from an intermediate MV means recreating it and all its dependents. This is a pipeline-wide change, not a local edit.

## Additional Context

- For MV design patterns (column selection, layering, indexes, distribution), see [perf-mv-design-patterns](./perf-mv-design-patterns.md)
- For join type selection (hash join vs temporal join), see [perf-join-optimization](./perf-join-optimization.md)
- For window function and aggregation optimization, see [perf-window-and-aggregation](./perf-window-and-aggregation.md)
- For EXPLAIN plan analysis, see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md)
- For background DDL and backfill management during migration, see [perf-ddl-background-management](./perf-ddl-background-management.md)

## Reference

- [RisingWave DROP MATERIALIZED VIEW](https://docs.risingwave.com/sql/commands/sql-drop-mv)
- [RisingWave System Catalogs](https://docs.risingwave.com/sql/system-catalogs/overview)
- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/performance-best-practices)

---

### Manage streaming job parallelism and adaptive scaling

**Impact:** HIGH - Optimize resource usage, prevent scaling-related failures

**Tags:** parallelism, scaling, adaptive, actors, fragments, performance

## Problem Statement

RisingWave's adaptive parallelism can lead to resource exhaustion when running many streaming jobs. By default, new jobs inherit the cluster's total core count as parallelism (e.g., three 48-core nodes = 144 parallelism). With many MVs, this creates too many actors, leading to memory pressure, high barrier latency, and potential OOM.

## Understanding Parallelism

### Key Concepts

- **Parallelism**: Number of parallel execution units for a streaming job
- **Fragment**: A unit of the streaming execution plan
- **Actor**: An instance of a fragment running on a compute node
- **Total actors** = Number of fragments × Parallelism

### Default Behavior

```sql
-- Check default parallelism strategy (look for adaptive_parallelism_strategy in output)
SHOW PARAMETERS;

-- Default: parallelism = total cores across all compute nodes
-- e.g., 3 nodes × 48 cores = 144 default parallelism
```

## Common Issues and Solutions

### Issue 1: Too Many Actors Causing High Memory/Barrier Latency

**Symptoms**:
- High barrier latency (> 1 minute)
- Memory pressure on compute nodes
- Actor count in thousands or tens of thousands

**Diagnosis**:
```sql
-- Check actor count per worker
SELECT worker_id, count(*) AS actor_count
FROM rw_actors
GROUP BY worker_id
ORDER BY actor_count DESC;

-- Check total actors in cluster
SELECT count(*) FROM rw_actors;

-- Recommended: < 400 actors per core
-- Example: 48-core node should have < 19,200 actors
```

**Solution**: Set bounded adaptive parallelism strategy
```sql
-- Limit new jobs to max 32 parallelism
ALTER SYSTEM SET adaptive_parallelism_strategy TO 'Bounded32';

-- Other valid values: 'Bounded8', 'Bounded16', 'Bounded64'
-- Or use 'Auto' for full adaptive (default)

-- Note: If barrier latency is high, restart meta to force the change
```

### Issue 2: Scaling Operation Causes Crash Loop

**Symptoms**:
- Cluster enters recovery loop after scale-in
- `worker not found` errors
- Jobs fail to reschedule

**Cause**: Corner case in RisingWave 2.6 scheduling where old and new scheduling paths interact during scaling.

**Solution** (v2.6.x):
```sql
-- 1. Disable automatic parallelism control
ALTER SYSTEM SET disable_automatic_parallelism_control = true;

-- 2. Restart meta node to apply
-- 3. Wait for recovery to complete

-- 4. Record current parallelism settings
SELECT * FROM rw_streaming_parallelism;

-- 5. For jobs with fixed parallelism, temporarily set to 1
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = 1 DEFERRED;

-- 6. Re-enable automatic control
ALTER SYSTEM SET disable_automatic_parallelism_control = false;

-- 7. Restart meta and wait for recovery
-- 8. Restore original parallelism values
```

**Prevention**: Upgrade to v2.6.3 or later which fixes this corner case.

### Issue 3: Fixed Parallelism Jobs Blocking Scaling

**Symptoms**: Some jobs don't scale with cluster, causing uneven load distribution.

**Diagnosis**:
```sql
-- Check jobs with fixed vs adaptive parallelism
SELECT name, parallelism, max_parallelism
FROM rw_streaming_parallelism
WHERE parallelism != max_parallelism;
```

**Solution**: Convert to adaptive parallelism
```sql
-- Set to adaptive (will use bounded strategy if configured)
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = ADAPTIVE;
```

## Parallelism Configuration

### For New Jobs

```sql
-- Set session-level parallelism before creating job
SET streaming_parallelism = 8;
CREATE MATERIALIZED VIEW my_mv AS ...;

-- Or set cluster-wide default
ALTER SYSTEM SET adaptive_parallelism_strategy TO 'Bounded8';
```

### For Existing Jobs

```sql
-- Change parallelism (takes effect on next recovery)
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = 16;

-- Or use DEFERRED to avoid immediate reschedule
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = 16 DEFERRED;

-- Trigger recovery to apply DEFERRED changes
RECOVER CLUSTER;
```

### Recommended Settings by Cluster Size

| Cluster Size | Recommended Strategy | Notes |
|--------------|---------------------|-------|
| Small (< 16 cores) | Bounded8 | Prevent resource exhaustion |
| Medium (16-64 cores) | Bounded16 or Bounded32 | Balance throughput and overhead |
| Large (> 64 cores) | Bounded32 or Bounded64 | Allow high throughput jobs |

## Calculating Optimal Parallelism

```sql
-- Check plan complexity
EXPLAIN DISTSQL CREATE MATERIALIZED VIEW my_mv AS ...;
-- Count fragments in output

-- Formula: actors = fragments × parallelism
-- Rule: actors per core < 400 (empirical)

-- Example: 5 fragments, 32 parallelism = 160 actors per job
-- On 48-core node: ~120 jobs before hitting 400 actors/core
```

## Background DDL and Parallelism

When running multiple background DDL jobs concurrently:

```sql
-- Rate limit backfilling to prevent overload
ALTER SYSTEM SET backfill_rate_limit TO 200;
-- This limits backfill to 200 rows/s per parallelism
-- With parallelism=8: 1,600 rows/s total

-- Reset to unlimited after backfill completes
ALTER SYSTEM SET backfill_rate_limit TO DEFAULT;
```

## Monitoring

```sql
-- Check current parallelism settings
SELECT name, parallelism, max_parallelism, status
FROM rw_streaming_parallelism;

-- In Grafana:
-- - Actor Output Blocking Time Ratio (backpressure indicator)
-- - Memory usage per compute node
-- - Barrier latency
```

## Prevention

1. **Set bounded strategy early**: Configure before creating many jobs
2. **Monitor actor counts**: Set alerts for actors per core > 300
3. **Test scaling**: Verify scale-up/down before production
4. **Use DEFERRED for bulk changes**: Avoid multiple immediate reschedules

## Reference

- [Manage a Large Number of Streaming Jobs](https://docs.risingwave.com/operate/manage-a-large-number-of-streaming-jobs)
- [Configure Adaptive Parallelism Strategy](https://docs.risingwave.com/operate/manage-a-large-number-of-streaming-jobs#configure-adaptive-parallelism-strategy)
- [View and Configure System Parameters](https://docs.risingwave.com/operate/view-configure-system-parameters)

---

### Streaming performance tuning and optimization

**Impact:** HIGH - Improve throughput by 2-10x, reduce resource consumption

**Tags:** streaming, performance, tuning, parallelism, rate-limit

## Problem Statement

Streaming jobs may underperform due to suboptimal configuration, causing high latency, excessive resource usage, or poor throughput. Proper tuning can significantly improve performance without hardware changes.

## Key Metrics to Monitor

### Throughput Metrics
- Source rows consumed per second
- Sink rows written per second
- Backfill progress percentage

### Latency Metrics
- Barrier latency (target: < 10 seconds)
- End-to-end latency from source to sink

### Resource Metrics
- CPU utilization per node
- Memory usage vs limits
- Storage I/O and compaction rate

## Tuning Parameters

### 1. Streaming Parallelism

Control how many actors process a streaming job:

```sql
-- Check current parallelism
SELECT * FROM rw_streaming_parallelism;

-- Set before creating MV (0 = use all CPU cores)
SET streaming_parallelism = 8;
CREATE MATERIALIZED VIEW mv AS ...;

-- Modify existing job parallelism (requires recovery)
ALTER MATERIALIZED VIEW mv SET PARALLELISM = 8;

-- Force parallelism change (skips barrier, applies at recovery)
ALTER MATERIALIZED VIEW mv SET PARALLELISM = 8 DEFERRED;
```

**Guidelines**:
- High parallelism = more throughput but more memory
- Check actor distribution: `SELECT worker_id, count(*) FROM rw_actors GROUP BY worker_id`
- For join-specific parallelism guidance, see [perf-join-optimization](./perf-join-optimization.md)

### 2. Rate Limiting

Control ingestion rate to prevent overwhelming the system:

```sql
-- Set source rate limit on existing source (rows per second per parallelism)
ALTER SOURCE my_source SET source_rate_limit = 10000;
-- Also works with tables that have connectors
ALTER TABLE my_table SET source_rate_limit = 10000;

-- Set backfill rate limit before MV creation (limits historical data catch-up)
SET backfill_rate_limit = 5000;
CREATE MATERIALIZED VIEW mv AS ...;

-- Set source rate limit as session variable (only affects NEW sources created in this session)
SET source_rate_limit = 5000;

-- Pause ingestion completely
ALTER SOURCE my_source SET source_rate_limit = 0;

-- Reset to unlimited
ALTER SOURCE my_source SET source_rate_limit = default;
```

**Rate limit is per-parallelism**: the total ingestion throughput for a source is `parallelism × rate_limit`. For example, a Kafka source with 10 partitions (parallelism=10) and `rate_limit = 100` ingests up to 1,000 rows/second total.

**Rate limit types**:
- `source_rate_limit`: Limits ingestion from sources (Kafka, CDC, etc.)
- `backfill_rate_limit`: Limits backfill speed for MVs, sinks, and indexes
- `sink_rate_limit`: Limits output rate to external sinks
- `dml_rate_limit`: Limits DML operations on tables

**Important distinctions**:
- `SET source_rate_limit = N` (session variable) only affects **new** sources/tables created in that session — it does not change existing sources
- `ALTER SOURCE ... SET source_rate_limit = N` changes an **existing** source immediately
- `SOURCE_RATE_LIMIT` does **not** affect backfill. MV backfill on sources with historical data runs at full speed regardless. Use `backfill_rate_limit` separately to control backfill speed
- Both `TO` and `=` are valid syntax: `SET source_rate_limit TO 100` and `SET source_rate_limit = 100` are equivalent
- If the cluster is under high latency when you set a rate limit, it may not take effect until the next barrier. Run `RECOVER;` (requires superuser) in a separate session to force it

**When to re-evaluate rate limits**:
- When upstream data producers change their throughput (e.g., crawlers increase frequency, ETL pipelines reconfigured)
- If rate limit is lower than upstream production rate, upstream queue lag (Kinesis iterator age, Kafka consumer lag) grows indefinitely — and data may be lost when upstream retention expires
- After adding or removing downstream MVs that change the amplification factor

**Use cases**:
- Backfill causing OOM: set `backfill_rate_limit` before creating MV
- CDC lag building up: use `ALTER SOURCE ... SET source_rate_limit`
- New MV catching up: set `backfill_rate_limit` to prevent overwhelming
- Emergency source pause: `ALTER SOURCE ... SET source_rate_limit = 0;` then `RECOVER;`

### 3. Channel Buffer Size

Control memory used for inter-actor communication:

```toml
# In compute node config (requires restart)
[streaming.developer]
stream_exchange_initial_permits = 512  # default: 2048
```

Lower values reduce memory but may reduce throughput.

### 4. Sink Decoupling

Decouple sinks to prevent external systems from blocking barriers:

```sql
-- Enable globally for new sinks
SET sink_decouple = true;

-- Check current status
SELECT sink_id, is_decouple, name FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id;
```

**Trade-off**: Decoupled sinks use internal logstore, adding storage overhead.

### 5. Checkpoint Interval

Adjust how frequently barriers are issued:

```sql
-- Increase interval for high-throughput, lower-latency-requirement workloads
ALTER SYSTEM SET barrier_interval_ms = 1000;  -- default: 250
```

**Trade-off**: Longer intervals reduce overhead but increase recovery time.

## Performance Analysis Workflow

### Step 1: Identify Bottleneck Type

```sql
-- Check if barrier is the bottleneck
-- High barrier latency suggests streaming/storage issues
```

Grafana panels to check:
- `Barrier Latency`: > 10s indicates problems
- `Actor Output Blocking Time Ratio`: High = backpressure
- `CPU Usage`: Low CPU + slow performance = I/O or memory bound

### Step 2: Find Bottleneck Job

```sql
-- Get fragment info for slow actors
SELECT m.name, f.fragment_id, count(*) as actor_count
FROM rw_actors a
JOIN rw_fragments f ON a.fragment_id = f.fragment_id
JOIN rw_materialized_views m ON f.table_id = m.id
GROUP BY m.name, f.fragment_id
ORDER BY actor_count DESC;
```

Use await-tree to identify which fragment is blocking.

### Step 3: Check Data Distribution

Uneven data distribution causes some actors to be overloaded. For vnode distribution diagnosis queries and guidance on choosing distribution keys, see [perf-mv-design-patterns](./perf-mv-design-patterns.md).

### Step 4: Optimize Query

For join optimization patterns (join type selection, filter pushdown, column pruning, temporal joins, etc.), see [perf-join-optimization](./perf-join-optimization.md).

## Data Visibility and Consistency

RisingWave MVs reflect **barrier-committed** state. Data inserted via DML or ingested from sources becomes visible to MV queries only after the next barrier checkpoint completes.

### Visibility Mode

Control what data batch queries can see:

```sql
-- Check current setting
SHOW visibility_mode;

-- Options:
SET visibility_mode = 'default';     -- use frontend config (default)
SET visibility_mode = 'checkpoint';  -- only see checkpoint-committed data (most consistent)
SET visibility_mode = 'all';         -- see in-flight data (less consistent, lower latency)
```

- `default`: defers to the frontend's `enable_barrier_read` config, which defaults to `false` — in practice behaves like `checkpoint` in most deployments
- `checkpoint`: queries only see data that has been checkpointed — consistent but may be up to one barrier interval behind
- `all`: queries see uncommitted/in-flight data — useful for debugging freshness issues, but reads may not be repeatable

### Immediate DML Visibility

By default, `INSERT`/`UPDATE`/`DELETE` returns immediately without waiting for downstream MVs to reflect the change. Two mechanisms force immediate visibility:

```sql
-- Option 1: One-time flush after DML
INSERT INTO my_table VALUES (...);
FLUSH;
-- All MVs now reflect the insert

-- Option 2: Session-level automatic flush (blocks on every DML)
SET implicit_flush = true;
INSERT INTO my_table VALUES (...);
-- Blocks until all downstream MVs are updated
-- Useful for testing, expensive for production bulk loads
```

**Note**: `implicit_flush` adds latency to every DML statement (waits for full dataflow refresh). Only use for interactive testing or when applications require read-after-write consistency.

## Additional Context

- Performance tuning is iterative - change one parameter at a time
- Monitor for 10-15 minutes after changes to see steady-state behavior
- Some changes require recovery to take effect

## Reference

- [RisingWave Performance Guide](https://docs.risingwave.com/performance/overview)
- [Cluster Scaling and Parallelism](https://docs.risingwave.com/deploy/k8s-cluster-scaling)

---

### Use temporal filters and watermarks correctly for state management

**Impact:** CRITICAL - Prevent unbounded state growth, avoid OOMs and periodic latency spikes

**Tags:** temporal-filter, now, watermark, state, ttl, proctime, streaming

## Problem Statement

Unbounded state is the primary cause of OOMs in long-running streaming jobs. RisingWave uses temporal filters and watermarks to clean old state, but incorrect usage of `NOW()`, `DATE_TRUNC`, and temporal filter placement can cause severe barrier latency spikes and cascading cluster issues. Every long-running MV should have a state cleanup strategy.

## NOW() / CURRENT_TIMESTAMP Behavior

`NOW()` and `CURRENT_TIMESTAMP` are identical in RisingWave. They tick once per `barrier_interval_ms` (default 1s), not continuously.

### Where NOW() is allowed and disallowed

| Allowed | Disallowed |
|---------|------------|
| `WHERE` clause | `SELECT` clause |
| `HAVING` clause | `GROUP BY` clause |
| `ON` clause (join conditions) | `AGGREGATE FILTER` clause |
| `FROM` clause (e.g., `GENERATE_SERIES` and temporal filter subquery patterns) | Generated columns (use `proctime()` instead) |

## Common Error: NOW() in SELECT is rejected

```sql
-- ERROR: RisingWave rejects this at creation time
CREATE MATERIALIZED VIEW mv AS
SELECT *, NOW() AS current_time FROM my_table;
-- Error: For streaming queries, `NOW()` function is only allowed in `WHERE`, `HAVING`, `ON` and `FROM`.

-- GOOD: use proctime() as a generated column on the source table/source
CREATE TABLE my_table (
  id INT,
  data VARCHAR,
  ts TIMESTAMPTZ AS proctime()  -- generated column, set once at insert time
) ...;
```

RisingWave's binder prevents `NOW()` in `SELECT` for streaming queries. If you need a processing-time column, use `proctime()` as a generated column on `CREATE TABLE` / `CREATE SOURCE` instead. The `proctime()` value is set once at ingestion time and does not change.

**Note:** `proctime()` is only valid in table/source definitions, not in arbitrary queries.

## Anti-Pattern: DATE_TRUNC with temporal filters causes batch spikes

```sql
-- BAD: batches all expirations at day boundaries → barrier pile-up
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM events
WHERE event_time > DATE_TRUNC('DAY', CURRENT_TIMESTAMP) - INTERVAL '1 DAY';

-- GOOD: distributes expirations continuously over time
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM events
WHERE event_time > CURRENT_TIMESTAMP - INTERVAL '90 DAY';
```

**Why this happens:** When `DATE_TRUNC` is used, large amounts of data expire simultaneously at day/hour boundaries. The `DynamicFilterExecutor` can't keep up with `NowExecutor` ticks, causing barriers to pile up and creating cascading latency spikes across the cluster. Continuous ranges ensure data expires gradually.

## Anti-Pattern: Temporal filter pushdown is NOT guaranteed

The optimizer cannot reliably push temporal filters down to sources. To guarantee early evaluation, wrap the source + temporal filter in a subquery in the `FROM` clause:

```sql
-- GOOD: temporal filter in subquery, guaranteed to apply early
SELECT * FROM (
  SELECT * FROM my_source
  WHERE event_time > NOW() - INTERVAL '1 hour'
) sub
JOIN other_table ON ...;

-- RISKY: optimizer may not push this down
SELECT * FROM my_source
JOIN other_table ON ...
WHERE my_source.event_time > NOW() - INTERVAL '1 hour';
```

In the risky pattern, the temporal filter may be evaluated after the join, meaning all historical data enters the join first — causing massive state and potential OOM.

## Temporal Filter OR Restrictions

Temporal filter conditions CANNOT be disjoined with each other via `OR`. They CAN be combined with `AND`, and CAN be ORed with non-temporal conditions.

```sql
-- OK: AND combination
WHERE ts > NOW() - INTERVAL '1 hour' AND ts2 > NOW() - INTERVAL '2 hours'

-- OK: OR with non-temporal condition
WHERE ts > NOW() - INTERVAL '1 hour' OR status = 'active'

-- NOT OK: OR between temporal conditions (will error or produce wrong results)
WHERE ts > NOW() - INTERVAL '1 hour' OR ts > NOW() - INTERVAL '2 hours'
```

## State Cleaning with Watermarks

### How watermark-based state cleaning works

Temporal filters with `NOW()` generate watermarks that propagate through the operator tree. When a watermark advances past old data, RisingWave removes that data from join state tables and aggregation groups. This is the primary mechanism for bounding state in long-running MVs.

### TTL on watermarks — state cleanup without retractions

If you want state cleanup but do NOT need to send deletion/retraction messages downstream, use `WITH TTL` on watermarks instead of temporal filters. This avoids the downstream update cascade while still bounding state size.

**Use temporal filters when:** Downstream consumers need to know that rows expired (retractions are important).

**Use TTL watermarks when:** You only need to bound state size and don't care about downstream retractions (lighter weight).

### Interval join state caveat

State cleaning for interval joins is triggered only when upstream messages arrive at the join key granularity. If a particular join key stops receiving messages, its state may be retained indefinitely. Monitor for inactive keys retaining stale state.

## Key Rule: Every Long-Running MV Needs a State Cleanup Strategy

Without a temporal filter or TTL watermark, state grows indefinitely and will eventually cause OOM. For every MV that runs continuously, choose one:

| Strategy | State Cleanup | Sends Retractions | Use When |
|----------|--------------|-------------------|----------|
| Temporal filter (`WHERE ts > NOW() - INTERVAL '...'`) | Yes | Yes | Downstream needs to see expirations |
| TTL watermark (`WITH TTL`) | Yes | No | Only need to bound state size |
| Neither | No | N/A | Short-lived MVs or bounded input only |

## Diagnosis: Detecting Missing State Cleanup

```sql
-- Check for large state tables that may indicate unbounded state growth
SELECT id, total_key_count,
       round((total_key_size + total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats
ORDER BY size_mb DESC
LIMIT 20;
```

In `EXPLAIN CREATE` output, look for:
- `StreamDynamicFilter` without corresponding state cleanup — indicates a temporal filter that may not clean state
- `StreamNow` present — confirms `NOW()` is used in a temporal filter

## Additional Context

- Process data continuously, not in daily batches — use event time or processing time rather than attaching timestamps via dummy joins
- Temporal filter behavior interacts with barrier interval — shorter `barrier_interval_ms` means more frequent `NOW()` ticks
- If temporal filter batch spikes cause barrier stuck, see [perf-barrier-stuck](./perf-barrier-stuck.md) for emergency actions
- If unbounded state causes OOM, see [perf-compute-node-oom](./perf-compute-node-oom.md) for diagnosis

## Reference

- [RisingWave Temporal Filters](https://docs.risingwave.com/processing/sql/temporal-filters)
- [RisingWave Watermarks](https://docs.risingwave.com/processing/watermarks)
- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/overview)

---

### Optimize window functions and aggregations for streaming

**Impact:** HIGH - Reduce state size by 10-100x with TopN pattern, avoid OOM from unbounded aggregation state

**Tags:** window, aggregation, topn, row_number, count-distinct, union, streaming, state

## Problem Statement

Window functions and aggregations are the most common sources of excessive state in streaming jobs. An `OverWindow` executor storing all partition rows, a `COUNT(DISTINCT ...)` on a high-cardinality column, or an accidental `UNION` instead of `UNION ALL` can each cause unbounded state growth and eventual OOM. Understanding the state cost of each pattern is critical for building sustainable streaming pipelines.

## Top-N Queries: Always Add the Rank Filter

This is the single most impactful optimization for window functions. When using `ROW_NUMBER()` or `RANK()` in a subquery, always add a `WHERE rank <= N` filter in the outer query.

```sql
-- BAD: StreamOverWindow — stores ALL rows per partition in state
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders
);

-- GOOD: StreamGroupTopN — stores only top N rows per partition
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
  FROM orders
) WHERE rn <= 10;
```

**Why this matters:** Without the rank filter, RisingWave uses the `StreamOverWindow` executor, which maintains **every row** in state for each partition. With the filter, the optimizer converts to `StreamGroupTopN`, which only stores the top N rows. For partitions with thousands of rows, this is a 100x+ state reduction.

**Verify in EXPLAIN:** Run `EXPLAIN CREATE MATERIALIZED VIEW ...` and look for `StreamGroupTopN` (efficient) vs `StreamOverWindow` (expensive).

**Constraint:** The `rn` column cannot appear in the outer SELECT column list — it is only for filtering.

## Aggregation State Cost Awareness

Different aggregate functions have fundamentally different state costs in streaming:

| Aggregate | State Type | State Cost | Notes |
|-----------|-----------|------------|-------|
| `SUM`, `COUNT`, `AVG` | Value (scalar) | Very low | Stores only the running result |
| `MIN`, `MAX` (append-only input) | Value (scalar) | Very low | No retractions needed |
| `MIN`, `MAX` (non-append-only input) | MaterializedInput | High | Must store ALL input values in sorted order to handle retractions |
| `COUNT(DISTINCT col)` | Distinct dedup state | High | Stores every unique value seen per group |
| `string_agg`, `array_agg` | MaterializedInput | High | Stores all input rows |
| `first_value`, `last_value` | MaterializedInput | High | Needs access to input history |

### Why MIN/MAX is expensive on non-append-only streams

When a retraction (DELETE/UPDATE) arrives for the current MIN or MAX value, RisingWave needs the **next** MIN/MAX from remaining values. This requires storing all values in sorted order. On append-only streams, retractions never occur, so a simple scalar value suffices.

**Tip:** If your source is inherently append-only (e.g., event logs, sensor data), declare it as append-only to enable lightweight MIN/MAX state:

```sql
CREATE TABLE events (...) APPEND ONLY;
```

## COUNT DISTINCT: Use approx_count_distinct for High Cardinality

`COUNT(DISTINCT col)` stores every unique value it has ever seen (per group) in a state table. For high-cardinality columns (e.g., user IDs, session IDs), this state grows indefinitely.

```sql
-- EXPENSIVE: stores every distinct user_id per category
CREATE MATERIALIZED VIEW mv AS
SELECT category, COUNT(DISTINCT user_id) AS unique_users
FROM events
GROUP BY category;

-- CHEAPER: HyperLogLog approximation (append-only streams only)
CREATE MATERIALIZED VIEW mv AS
SELECT category, approx_count_distinct(user_id) AS approx_unique_users
FROM events
GROUP BY category;
```

**Limitations of `approx_count_distinct`:**
- Only works on **append-only** streams (no UPDATE/DELETE)
- Returns an approximate count (HyperLogLog, typical error ~2%)
- Tech preview feature (introduced in v2.5.0)

If exact counts are required on non-append-only streams, combine with a temporal filter to bound the state window.

## UNION vs UNION ALL

```sql
-- BAD: UNION requires dedup state — stores all seen rows
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM source_a
UNION
SELECT * FROM source_b;

-- GOOD: UNION ALL is stateless — just merges streams
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM source_a
UNION ALL
SELECT * FROM source_b;
```

`UNION` (without ALL) removes duplicates, which requires maintaining state to track every unique row across all inputs. `UNION ALL` simply merges the streams with zero state overhead. Always use `UNION ALL` unless deduplication is explicitly required.

## EMIT ON WINDOW CLOSE for Time-Windowed Aggregations

When using time-window aggregations with watermarks available, use `EMIT ON WINDOW CLOSE` to produce append-only output with better performance:

```sql
CREATE MATERIALIZED VIEW hourly_stats AS
SELECT
  window_start, window_end,
  category,
  COUNT(*) AS event_count,
  SUM(amount) AS total_amount
FROM TUMBLE(events, event_time, INTERVAL '1 hour')
GROUP BY window_start, window_end, category
EMIT ON WINDOW CLOSE;
```

**Benefits:**
- Calculates results only once per window (when the window closes), not incrementally on every row
- Output is append-only — no retractions sent downstream
- Requires watermarks on the source to determine when windows can close

## Multi-Granularity Aggregation: MV-on-MV Pattern

For aggregations at multiple time granularities, build a layered MV pipeline instead of computing each granularity independently from the source:

```sql
-- Layer 1: minute-level aggregation from source
CREATE MATERIALIZED VIEW stats_1min AS
SELECT date_trunc('minute', event_time) AS ts, category, COUNT(*) AS cnt
FROM events
WHERE event_time > NOW() - INTERVAL '7 days'
GROUP BY date_trunc('minute', event_time), category;

-- Layer 2: hour-level from minute-level (cheaper than re-reading source)
CREATE MATERIALIZED VIEW stats_1hour AS
SELECT date_trunc('hour', ts) AS ts, category, SUM(cnt) AS cnt
FROM stats_1min
GROUP BY date_trunc('hour', ts), category;
```

This works well for decomposable aggregates (`SUM`, `COUNT`, `MIN`, `MAX`). It does **not** work for non-decomposable aggregates like `AVG`, `COUNT(DISTINCT ...)`, or `percentile`.

## Diagnosis: Identifying Expensive Aggregation State

```sql
-- Find the largest state tables (potential unbounded aggregation state)
SELECT id, total_key_count,
       round((total_key_size + total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats
ORDER BY size_mb DESC
LIMIT 20;
```

In `EXPLAIN CREATE MATERIALIZED VIEW` output, look for:
- `StreamOverWindow` — check if a rank filter could convert it to `StreamGroupTopN`
- `StreamHashAgg` — check what aggregates are used and their state cost
- `StreamAppendOnlyHashAgg` — more efficient variant used when input is append-only

## Reference

- [RisingWave Window Functions](https://docs.risingwave.com/sql/functions/window-functions)
- [RisingWave Top-N by Group](https://docs.risingwave.com/processing/sql/top-n-by-group)
- [RisingWave Aggregate Functions](https://docs.risingwave.com/sql/functions/aggregate)
- [RisingWave Time Windows](https://docs.risingwave.com/processing/sql/time-windows)
- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/performance-best-practices)

---

## Storage & Compaction (CRITICAL)

### Configure compaction groups and storage settings

**Impact:** HIGH - Optimize storage performance, prevent write stops

**Tags:** storage, compaction, config, hummock, tuning, capacity, state-table, meta-snapshot

## Problem Statement

Compaction configuration significantly impacts storage performance. Misconfigured settings can lead to write stops, slow queries, or excessive resource usage. Understanding and tuning these settings is essential for production workloads.

## View Current Configuration

```sql
-- Check all compaction group configs
SELECT * FROM rw_catalog.rw_hummock_compaction_group_configs ORDER BY id;

-- Check specific metrics
SELECT id,
       compaction_config->>'level0StopWriteThresholdSubLevelNumber' AS write_stop_threshold,
       compaction_config->>'maxBytesForLevelBase' AS level_base_bytes,
       compaction_config->>'maxCompactionBytes' AS max_compaction_bytes
FROM rw_hummock_compaction_group_configs;
```

## Key Configuration Parameters

### Write Stop Threshold

Controls when write stop triggers:

```bash
# Increase threshold to delay write stop (use when compaction is catching up)
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --level0-stop-write-threshold-sub-level-number 300
```

Default: ~200. Increase if premature write stops occur.

### Emergency Picker

Enable aggressive L0 compaction when backlogged:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --enable-emergency-picker true
```

### Max Compact File Number

Control how many files per compaction task:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --level0-max-compact-file-number 50
```

Higher values = larger compaction tasks = more memory but faster L0 drain.

### Tombstone Reclaim

Control aggressiveness of reclaiming deleted data:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --tombstone-reclaim-ratio 40
```

Higher values = more aggressive deletion but more CPU usage.

### Level Base Size

Control when levels trigger compaction:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --max-bytes-for-level-base 536870912  # 512MB
```

## Common Tuning Scenarios

### Scenario 1: Write-Heavy Workload

Optimize for high write throughput:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --enable-emergency-picker true \
  --level0-stop-write-threshold-sub-level-number 400 \
  --level0-max-compact-file-number 100
```

### Scenario 2: Read-Heavy Workload

Optimize for query performance (fewer L0 files):

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --level0-stop-write-threshold-sub-level-number 100 \
  --level0-max-compact-file-number 30
```

Lower thresholds keep L0 smaller but may cause more write stops.

### Scenario 3: High Delete/Update Ratio

When source data has many updates/deletes:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --tombstone-reclaim-ratio 60
```

## Inspect Storage State

### Check Table Physical Size

```sql
SELECT id, total_key_count, total_key_size, total_value_size
FROM rw_catalog.rw_table_stats
ORDER BY total_key_size + total_value_size DESC
LIMIT 20;
```

### Check SST Distribution

```sql
SELECT compaction_group_id,
       level_id,
       count(*) AS file_count,
       round(sum(file_size)/1024/1024) AS size_mb
FROM rw_hummock_sstables
GROUP BY compaction_group_id, level_id
ORDER BY compaction_group_id, level_id;
```

### Check Vnode Distribution

For diagnosing hot spots:

```sql
-- For a specific table
WITH tmp AS (
  SELECT sstable_id,
         substr(key_range_left::text, 11, 4) AS start_vnode,
         substr(key_range_right::text, 11, 4) AS end_vnode,
         round(file_size/1024/1024) AS size_mb,
         jsonb_array_elements_text(table_ids) AS tid
  FROM rw_hummock_sstables
  WHERE level_id > 0
)
SELECT tid, start_vnode, end_vnode, sum(size_mb) AS total_mb
FROM tmp
WHERE tid = '<TABLE_ID>'
GROUP BY tid, start_vnode, end_vnode
ORDER BY total_mb DESC;
```

## Advanced Storage Diagnostics

### Compaction Group Summary

Get an overview of all compaction groups with storage usage:

```sql
-- Summary: total SST counts, sizes, and member table counts per group
SELECT id,
       jsonb_array_length(member_tables) AS table_count,
       compaction_config->>'level0StopWriteThresholdSubLevelNumber' AS write_stop_threshold
FROM rw_hummock_compaction_group_configs
ORDER BY id;
```

### Find Large State Tables in a Compaction Group

Identify storage hotspots for capacity planning:

```sql
-- Find the largest state tables in a specific compaction group
WITH members AS (
  SELECT jsonb_array_elements(member_tables)::int AS tid
  FROM rw_hummock_compaction_group_configs
  WHERE id = <COMPACTION_GROUP_ID>
)
SELECT m.tid, s.total_key_count,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM members m
JOIN rw_table_stats s ON m.tid = s.id
ORDER BY size_mb DESC
LIMIT 20;
```

### SST Delete Ratio Analysis

High delete ratios in SSTs slow compaction and table scans, affecting backfill and batch queries:

```sql
-- Find SSTs with high delete ratios for a specific table
WITH sst_info AS (
  SELECT sstable_id, compaction_group_id, level_id,
         stale_key_count * 1.0 / NULLIF(total_key_count, 0) AS delete_ratio,
         jsonb_array_elements_text(table_ids) AS tid
  FROM rw_hummock_sstables
  WHERE total_key_count > 0
)
SELECT tid, level_id, count(*) AS sst_count,
       round(avg(delete_ratio)::numeric, 3) AS avg_delete_ratio
FROM sst_info
WHERE delete_ratio > 0.5
GROUP BY tid, level_id
ORDER BY avg_delete_ratio DESC;
```

If a table has consistently high delete ratios, increase its `tombstone_reclaim_ratio`.

### L0 Per-Group Statistics

Check L0 sub-level distribution for a specific compaction group:

```sql
SELECT compaction_group_id, sub_level_id,
       count(*) AS file_count,
       round(sum(file_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_hummock_sstables
WHERE level_id = 0 AND compaction_group_id = <GROUP_ID>
GROUP BY compaction_group_id, sub_level_id
ORDER BY sub_level_id DESC;
```

### Find Streaming Jobs in a Compaction Group

Useful for impact analysis when investigating compaction issues:

```sql
WITH members AS (
  SELECT jsonb_array_elements(member_tables)::int AS tid
  FROM rw_hummock_compaction_group_configs
  WHERE id = <COMPACTION_GROUP_ID>
),
frags AS (
  SELECT DISTINCT table_id
  FROM rw_fragments, unnest(state_table_ids) AS stid
  WHERE stid = ANY(SELECT tid FROM members)
)
SELECT n.id, n.name, n.kind
FROM frags f
JOIN (
  SELECT id, name, 'MV' AS kind FROM rw_materialized_views UNION
  SELECT id, name, 'TABLE' FROM rw_tables UNION
  SELECT id, name, 'SINK' FROM rw_sinks UNION
  SELECT id, name, 'SOURCE' FROM rw_sources
) n ON f.table_id = n.id;
```

### Meta Snapshot Information

Track metadata snapshots for recovery and point-in-time restore:

```sql
-- View meta snapshots (used for cluster recovery)
SELECT * FROM rw_meta_snapshot ORDER BY snapshot_id DESC;
```

## Additional Context

- Configuration changes take effect immediately for new compaction tasks
- Existing compaction tasks continue with old config
- Monitor for 10-15 minutes after changes to see impact
- Each compaction group can have different settings

## Reference

- [RisingWave System Parameters](https://docs.risingwave.com/operate/view-configure-system-parameters)
- [Node-Specific Configurations](https://docs.risingwave.com/deploy/node-specific-configurations)

---

### Resolve L0 file accumulation and compaction stuck

**Impact:** CRITICAL - Restore write throughput, prevent system-wide write stops

**Tags:** storage, compaction, l0, hummock, write-stop, lsm

## Problem Statement

RisingWave uses an LSM-tree based storage engine (Hummock). Each compute node flushes L0 files per checkpoint, and background compaction reduces L0 file count. Without sufficient compaction, L0 files accumulate, degrading read performance and eventually triggering "write stop" which halts all streaming.

## Observations

Symptoms of L0 accumulation:
- Increasing barrier latency
- Degraded query performance
- Write stop triggered (system halts)
- Compaction tasks timing out

## Diagnosis

### Step 1: Check LSM Layout

```sql
SELECT compaction_group_id,
       level_id,
       level_type,
       sub_level_id,
       count(*) AS total_file_count,
       round(sum(file_size) / 1024.0) AS total_file_size_kb
FROM rw_catalog.rw_hummock_sstables
GROUP BY compaction_group_id, level_type, level_id, sub_level_id
ORDER BY compaction_group_id, level_id, sub_level_id DESC;
```

**Red flags**:
- L0 (level_id = 0) file count > 100
- Many sub-levels in L0
- Total L0 size growing continuously

### Step 2: Check Write Stop Status

```sql
-- Check compaction group configs including write stop threshold
SELECT * FROM rw_catalog.rw_hummock_compaction_group_configs ORDER BY id;
```

In Grafana: Check `Write Stop Compaction Groups` panel - non-zero indicates write stop active.

### Step 3: Check Compaction Progress

In Grafana:
- `Compaction Task Count`: Tasks pending vs completed
- `Compaction Throughput`: Bytes compacted per second
- `L0 File Count`: Trend over time

## Solutions

### Solution 1: Scale Up Compactors

Increase compactor resources to process L0 files faster:

```bash
# Scale compactor replicas
kubectl scale deployment compactor --replicas=3

# Or increase compactor memory/CPU
# Edit deployment resources
```

### Solution 2: Adjust Compaction Config

Lower thresholds to trigger more aggressive compaction:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --enable-emergency-picker true \
  --level0-stop-write-threshold-sub-level-number 300 \
  --tombstone-reclaim-ratio 40 \
  --level0-max-compact-file-number 50
```

Parameters explained:
- `enable-emergency-picker`: Prioritize L0 compaction when backlogged
- `level0-stop-write-threshold-sub-level-number`: When to trigger write stop (increase if premature)
- `tombstone-reclaim-ratio`: Aggressiveness of deleting tombstones
- `level0-max-compact-file-number`: Max files per compaction task

### Solution 3: Identify Heavy State Tables

Find which tables are causing most L0 files:

```sql
-- Find state tables in a compaction group
WITH m AS (
  SELECT jsonb_array_elements(member_tables)::int AS tid
  FROM rw_hummock_compaction_group_configs
  WHERE id = <COMPACTION_GROUP_ID>
),
f AS (
  SELECT table_id, unnest(state_table_ids) AS stid
  FROM rw_fragments
),
t AS (
  SELECT DISTINCT f.table_id AS tid
  FROM m JOIN f ON m.tid = f.stid
)
SELECT n.id, n.name, n.ident
FROM t JOIN (
  SELECT id, name, 'MV' AS ident FROM rw_materialized_views UNION
  SELECT id, name, 'TABLE' FROM rw_tables UNION
  SELECT id, name, 'SINK' FROM rw_sinks
) n ON t.tid = n.id;
```

Consider optimizing or dropping heavy jobs.

### Solution 4: Check for Delete Ratio

High delete ratio in SSTs slows compaction and queries:

```sql
WITH sst_delete_ratio AS (
  SELECT sstable_id,
         compaction_group_id,
         level_id,
         stale_key_count * 1.0 / total_key_count AS delete_ratio,
         jsonb_array_elements_text(table_ids) AS tid
  FROM rw_catalog.rw_hummock_sstables
  WHERE total_key_count > 0
)
SELECT * FROM sst_delete_ratio
WHERE delete_ratio > 0.5
ORDER BY delete_ratio DESC
LIMIT 20;
```

High delete ratio indicates:
- Lots of updates/deletes in source data
- Consider tuning tombstone reclaim settings

## Compaction Write Stop Details

When write stop triggers:
1. LSM shape is marked as abnormal in metadata
2. During store flush, system checks LSM shape
3. If abnormal, store flush blocks
4. This manifests as `store_flush` in await-tree

**Recovery**: Once compaction catches up and LSM shape normalizes, writes resume automatically.

## Monitoring After Fix

After applying fixes, monitor:

```sql
-- Run periodically to check L0 trend
SELECT compaction_group_id, count(*) AS l0_count
FROM rw_hummock_sstables
WHERE level_id = 0
GROUP BY compaction_group_id;
```

L0 count should decrease over time. If not, apply more aggressive fixes.

## Additional Context

- L0 files overlap with each other, requiring merge-sort on reads
- Write stop is a safety mechanism to prevent unbounded L0 growth
- Consider cluster sizing if workload consistently overwhelms compaction

## Reference

- [RisingWave Storage Overview](https://docs.risingwave.com/store/overview)
- [Hummock LSM Storage](https://github.com/risingwavelabs/risingwave/tree/main/src/storage)

---

## Sources (HIGH)

### Troubleshoot Kafka source SSL/TLS connection issues

**Impact:** HIGH - Restore Kafka connectivity, enable secure data ingestion

**Tags:** kafka, source, ssl, tls, certificate, sasl, schema-registry

## Problem Statement

Kafka sources using SSL/TLS can fail to connect due to certificate issues, file path problems, or authentication errors. Common scenarios include missing CA certificates, self-signed certificates in schema registry, and SASL authentication bugs.

## Common Issues and Solutions

### Issue 1: CA Certificate File Not Found

**Symptoms**:
```
ssl.ca.location failed: error:05880002:x509 certificate routines::system lib
ERROR librdkafka: SSL: error:80000002:system library::No such file or directory
```

**Cause**: The CA certificate file path specified in `properties.ssl.ca.location` doesn't exist or isn't mounted in the container.

**Solutions**:

1. **Verify certificate file exists and is mounted**:
```bash
# Check if the file exists in the compute node container
kubectl exec -it compute-node-0 -- ls -la /rwcert/
```

2. **Correct the source definition**:
```sql
CREATE SOURCE my_kafka_source (...)
WITH (
  connector = 'kafka',
  topic = 'my-topic',
  properties.bootstrap.server = 'kafka-broker:9093',
  properties.security.protocol = 'SASL_SSL',
  properties.sasl.mechanism = 'PLAIN',
  properties.sasl.username = '...',
  properties.sasl.password = SECRET my_password,
  -- Ensure this path matches the mounted volume
  properties.ssl.ca.location = '/rwcert/ca.crt'
) FORMAT PLAIN ENCODE JSON;
```

3. **For Kubernetes deployments**: Verify the volume mount in your deployment config:
```yaml
volumeMounts:
  - name: certs
    mountPath: /rwcert
    readOnly: true
volumes:
  - name: certs
    secret:
      secretName: kafka-ca-cert
```

### Issue 2: Schema Registry SSL Certificate Error

**Symptoms**:
```
connector error: all request confluent registry all timeout
error sending request for url https://...
client error Connect: error:0A000086:SSL routines:
tls_post_process_server_certificate:certificate verify failed
self-signed certificate in certificate chain
```

**Cause**: Schema registry uses a self-signed or private CA certificate that isn't trusted.

**Solutions**:

1. **Use the `schema.registry.ssl.ca.location` option** (if supported in your version):
```sql
CREATE SOURCE my_source (...)
WITH (
  connector = 'kafka',
  topic = 'my-topic',
  properties.bootstrap.server = 'kafka:9092',
  ...
) FORMAT PLAIN ENCODE AVRO (
  schema.registry = 'https://schema-registry:8081',
  schema.registry.username = '...',
  schema.registry.password = SECRET sr_password,
  schema.registry.ssl.ca.location = '/rwcert/ca.crt'
);
```

2. **Do NOT disable certificate validation (`schema.registry.ca = 'ignore'`)**:

   Disabling TLS certificate checks for the schema registry (for example by setting
   `schema.registry.ca = 'ignore'`) exposes clients to man-in-the-middle attacks and
   credential interception. This option must **never** be used in production and is
   strongly discouraged even in test environments.

   If your schema registry uses a self-signed or private CA certificate, the recommended
   fix is to:

   - Configure the correct CA bundle via `schema.registry.ssl.ca.location` (see example above), or
   - Upgrade to a RisingWave version that supports `schema.registry.ssl.ca.location`, or
   - Terminate TLS in a trusted proxy that presents a certificate signed by a trusted CA.

**Note**: The `schema.registry.ssl.ca.location` option was added in a later version. Check your RisingWave version for support.

### Issue 3: All Brokers Down Error

**Symptoms**:
```
librdkafka: Global error: AllBrokersDown Local: All broker connections are down: 4/4 brokers are down
```

**Cause**: Various connectivity issues including:
- Network unreachable
- Incorrect `advertised.listeners` configuration in Kafka
- SSL/SASL authentication failures
- Firewall blocking connections

**Diagnosis**:

1. **Check Kafka broker advertised addresses**:
   - The count (e.g., "4/4") includes bootstrap brokers + discovered brokers
   - May show more brokers than your cluster due to metadata discovery

2. **Verify network connectivity**:
```bash
# From compute node
kubectl exec -it compute-node-0 -- nc -zv kafka-broker 9093
```

3. **Check Kafka `advertised.listeners`**:
   - Ensure advertised addresses are reachable from RisingWave pods
   - May need to use internal Kubernetes DNS names

**Solutions**:

1. **Use PrivateLink for cloud deployments**:
```sql
CREATE SOURCE my_source (...)
WITH (
  connector = 'kafka',
  topic = 'my-topic',
  properties.bootstrap.server = 'private-endpoint:9092',
  privatelink.targets = '[{"port": 9092}]',
  privatelink.endpoint = 'vpce-xxxx'
);
```

2. **Enable detailed Kafka logging**:
```bash
# Set rust log level in meta node
rustLog=INFO,librdkafka=debug
```

### Issue 4: SASL/SCRAM Authentication Bug

**Symptoms**: Authentication fails with SASL_SSL and SCRAM mechanism on Kafka 3.8.1+.

**Cause**: Bug in librdkafka fixed in v2.6.1 where client-side nonce was incorrectly concatenated.

**Solution**: Upgrade to RisingWave v2.6.1 or later.

**Reference**: [librdkafka PR #4895](https://github.com/confluentinc/librdkafka/pull/4895)

## Source Parallelism and Partitions

**Best Practice**: Match source parallelism to Kafka topic partition count for optimal performance.

```sql
-- Check current parallelism
SELECT * FROM rw_streaming_parallelism WHERE name = 'my_source';

-- Source throughput is limited by partition count
-- If parallelism > partition count, some executors will be idle
```

## Diagnosis Queries

```sql
-- Check source status
SELECT * FROM rw_sources WHERE name = 'my_source';

-- Check source throughput in Grafana
-- Panel: Source Throughput (rows/s and bytes/s)

-- Check for connection errors in logs
-- Meta node log: source_manager::worker errors
```

## Prevention

1. **Test connectivity before creating source**: Verify CA certs, network, and authentication
2. **Use secrets for credentials**: Don't hardcode passwords in source definitions
3. **Monitor source throughput**: Set alerts for throughput drops
4. **Document certificate paths**: Ensure ops team knows where certs are mounted

## Reference

- [Kafka Source Configuration](https://docs.risingwave.com/ingestion/sources/kafka)
- [Kafka Configuration Options](https://docs.risingwave.com/ingestion/sources/kafka-config)
- [PrivateLink Configuration](https://docs.risingwave.com/ingestion/sources/kafka-config#privatelink-configuration)

---

## Sinks (HIGH)

### Troubleshoot Iceberg sink issues

**Impact:** MEDIUM - Restore Iceberg data delivery, fix permission and configuration errors

**Tags:** iceberg, sink, s3, permission, parquet, databricks, vacuum, time-travel, snapshot

## Problem Statement

Iceberg sinks can fail due to S3 permission issues, commit latency, small file problems, and catalog configuration. These issues often manifest as "PermissionDenied" errors when writing parquet files or slow sink performance.

## Common Issues and Solutions

### Issue 1: S3 Permission Denied When Writing Parquet

**Symptoms**:
```
Iceberg error: Unexpected = Failed to close parquet writer
source: PermissionDenied persistent at Writer::write
S3Error code: AccessDenied, message: Access Denied
```

**Causes**:
1. IAM role/policy doesn't have write permission to S3 path
2. S3 bucket policy restricts writes
3. Temporary credentials expired
4. Cross-account access not configured

**Diagnosis**:
```sql
-- Check sink definition for S3 paths
SELECT definition FROM rw_sinks WHERE name = 'my_iceberg_sink';

-- Look at the S3 path in error:
-- uri: https://s3.../metastore/.../tables/.../xxx.parquet
```

**Solutions**:

1. **Verify IAM permissions**:
```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:ListBucket"
  ],
  "Resource": [
    "arn:aws:s3:::your-bucket/*",
    "arn:aws:s3:::your-bucket"
  ]
}
```

2. **Check Unity Catalog / Databricks permissions**:
   - Ensure RisingWave has write access to the external location
   - Verify the table's storage credential

3. **For cross-account S3 access**: Configure bucket policy and IAM trust relationship

### Issue 2: Sink Decoupling and Error Handling

**Note**: When sink decoupling is enabled, Iceberg sink errors don't immediately block the pipeline:
```
reset log reader stream successfully after sink error
```

This means:
- Data is being written to logstore
- Iceberg writes are failing
- Errors are contained to the affected parallelism

**Diagnosis**:
```sql
-- Check if sink is decoupled
SELECT sink_id, is_decouple, name
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id
WHERE connector = 'iceberg';
```

**Solution**: Fix the underlying permission issue; logstore will drain once fixed.

### Issue 3: Small Files Problem

**Symptoms**:
- Too many small parquet files in Iceberg table
- Read performance degradation
- High metadata overhead

**Cause**: Default commit interval is 60 seconds, but high-frequency writes can still create many files.

**Solutions**:

1. **Tune commit checkpoint interval**:
```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  ...
  commit_checkpoint_interval = 300,  -- 5 minutes between commits
);
```

2. **Enable compaction**:
```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  ...
  enable_compaction = true,
  compaction_interval_sec = 10800,  -- 3 hours
);
```

3. **Enable snapshot expiration**:
```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  ...
  enable_snapshot_expiration = true,
  snapshot_expiration_max_age_millis = 3600000,  -- 1 hour
  snapshot_expiration_retain_last = 12,
);
```

### Issue 4: Iceberg Sink Commit Latency

**Symptoms**:
- Barrier latency increasing
- Sink appears slow or stuck

**Cause**: Iceberg commits to S3/catalog can be slow, especially for large transactions.

**Solutions**:

1. **Enable sink decoupling**:
```sql
SET sink_decouple = true;
CREATE SINK my_sink FROM my_mv WITH (...);
```

2. **Increase barrier interval** (if decoupling not possible):
```sql
ALTER SYSTEM SET barrier_interval_ms = 10000;
```

3. **Monitor commit latency in Grafana**:
   - Panel: Sink Commit Latency
   - Alert if consistently > barrier interval

### Issue 5: Iceberg Time Travel Query Errors

**Symptoms**: Unable to query historical snapshots.

**Diagnosis**:
```sql
-- Check available snapshots
SELECT * FROM rw_iceberg_snapshots('my_iceberg_source');

-- Query at specific snapshot
SELECT * FROM my_iceberg_source
FOR SYSTEM_VERSION AS OF 12345678;

-- Query at specific time
SELECT * FROM my_iceberg_source
FOR SYSTEM_TIME AS OF '2025-01-01 12:00:00';
```

**Common issues**:
- Snapshot expired (check expiration settings)
- Time format incorrect
- Snapshot ID doesn't exist

### Issue 6: Iceberg Table Bloat and Storage Growth

**Symptoms**:
- S3 storage costs increasing faster than expected
- Many small data files accumulating
- Slow metadata operations

**Diagnosis**:
```sql
-- Inspect snapshot history to understand commit frequency
SELECT * FROM rw_iceberg_snapshots('my_iceberg_source');

-- Check data file inventory (file count, sizes, record counts)
SELECT * FROM rw_iceberg_files('my_iceberg_source');

-- Check manifest files (metadata overhead)
SELECT * FROM rw_iceberg_manifests('my_iceberg_source');

-- Check table evolution history (schema changes, operations)
SELECT * FROM rw_iceberg_history('my_iceberg_source');
```

**Solutions**:

Note: The diagnostic functions above (`rw_iceberg_snapshots`, `rw_iceberg_files`, etc.) take the RisingWave **source** name as argument. The `VACUUM` commands below operate on the RisingWave **table or sink** name that writes to Iceberg.

1. **Expire old snapshots** (removes outdated versions without rewriting data):
```sql
VACUUM my_iceberg_sink;
```

2. **Full compaction** (rewrites data files then expires snapshots):
```sql
-- WARNING: requires temporary extra disk space
VACUUM FULL my_iceberg_sink;
```

3. **Configure automatic maintenance on the sink** (see Iceberg Sink Configuration Reference below for all options).

### Issue 7: Full-Reload Iceberg Source Refresh Stalled

**Symptoms**: Iceberg source using full reload mode shows stale data.

**Diagnosis**:
```sql
-- Check refresh state for all Iceberg sources using full reload
SELECT * FROM rw_iceberg_refresh_state();
```

If a refresh is stuck, check connectivity and permissions to the upstream Iceberg catalog.

## Iceberg Sink Configuration Reference

```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  type = 'upsert',  -- or 'append-only'
  primary_key = 'id',  -- required for upsert

  -- Catalog configuration
  catalog.type = 'storage',  -- or 'rest', 'glue', 'hive'
  warehouse.path = 's3://bucket/warehouse',
  database.name = 'my_db',
  table.name = 'my_table',

  -- S3 configuration
  s3.region = 'us-east-1',
  s3.access.key = 'xxx',  -- or use IAM role
  s3.secret.key = SECRET my_s3_secret,

  -- Performance tuning
  commit_checkpoint_interval = 60,

  -- Compaction (optional)
  enable_compaction = true,
  compaction_interval_sec = 10800,

  -- Snapshot management (optional)
  enable_snapshot_expiration = true,
  snapshot_expiration_max_age_millis = 3600000,
  snapshot_expiration_retain_last = 12,

  -- Create table if not exists
  create_table_if_not_exists = true
);
```

## Monitoring Iceberg Sinks

```sql
-- Check sink status
SELECT * FROM rw_sinks WHERE name = 'my_iceberg_sink';

-- Check for sink errors in event logs
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SINK%'
ORDER BY timestamp DESC;

-- Check logstore lag (for decoupled sinks)
-- See: cdc-sink-decouple.md for query
```

## Reference

- [Sink to Iceberg](https://docs.risingwave.com/iceberg/deliver-to-iceberg)
- [Iceberg Configuration Options](https://docs.risingwave.com/iceberg/deliver-to-iceberg#configuration-parameters)
- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)

---

### Troubleshoot JDBC sink connection issues

**Impact:** HIGH - Restore sink connectivity, prevent data delivery failures

**Tags:** jdbc, sink, postgres, mysql, connection, timeout, keepalive

## Problem Statement

JDBC sinks can experience connection issues including "Timer already cancelled" errors, connection timeouts, and connection closures. These issues are often caused by idle connection timeouts from managed database services (like AWS RDS) or network configurations that drop idle connections.

## Common Issues and Solutions

### Issue 1: Timer Already Cancelled Error

**Symptoms**:
```
java.lang.IllegalStateException: Timer already cancelled
at java.base/java.util.Timer.sched(Timer.java:409)
at org.postgresql.jdbc.PgConnection.addTimerTask(...)
```

Followed by:
```
org.postgresql.util.PSQLException: This connection has been closed
```

**Cause**: The JDBC connection was closed by the database or network due to idle timeout, but the sink tries to use a stale connection.

**Solution** (RisingWave >= 2.7):

Configure TCP keepalive parameters for MySQL/MariaDB sinks:
```sql
CREATE SINK my_jdbc_sink FROM my_mv WITH (
  connector = 'jdbc',
  jdbc.url = 'jdbc:mysql://...',
  -- Enable TCP keepalive (default: true)
  'jdbc.tcp.keep.alive' = 'true',
  -- Keepalive time in milliseconds (e.g., 5 minutes)
  'jdbc.tcp.keep.alive.time.ms' = '300000',
  -- Keepalive interval in milliseconds
  'jdbc.tcp.keep.alive.interval.ms' = '30000',
  -- Keepalive probe count
  'jdbc.tcp.keep.alive.count' = '3',
  ...
);
```

**Note**: These TCP keepalive options are only supported for MySQL and MariaDB JDBC sinks as of the PR introducing them.

**Workaround for PostgreSQL JDBC**:

Consider using the native PostgreSQL sink instead of JDBC sink:
```sql
CREATE SINK my_pg_sink FROM my_mv WITH (
  connector = 'postgres',
  host = '...',
  port = '5432',
  ...
);
```

### Issue 2: Connection Timeout During Write

**Symptoms**:
```
timeout error when writing to downstream PG
```

**Cause**: Downstream database is overloaded, network latency, or connection pool exhaustion.

**Solutions**:

1. **Adjust query timeout**:
```sql
CREATE SINK my_sink FROM my_mv WITH (
  connector = 'jdbc',
  'jdbc.query.timeout' = '60',  -- seconds, default is 60
  ...
);
```

2. **Check downstream database health**:
   - Monitor CPU, memory, and connection count
   - Check for long-running queries or locks
   - Verify network connectivity

3. **Enable sink decoupling** to prevent connection issues from blocking the pipeline:
```sql
SET sink_decouple = true;
CREATE SINK my_sink FROM my_mv WITH (...);
```

### Issue 3: Deadlock Detected in Downstream Database

**Symptoms**:
```
ERROR: deadlock detected
Process X waits for ShareLock on transaction Y blocked by process Z
```

**Cause**: Multiple sink parallelism writing to the same rows causing downstream database deadlocks.

**Solutions**:

1. **Reduce sink parallelism**:
```sql
-- Set parallelism before creating sink
SET streaming_parallelism = 1;
CREATE SINK my_sink FROM my_mv WITH (...);
```

2. **Ensure proper primary key ordering**:
   - The sink's write order should align with the downstream table's primary key
   - Consider partitioning writes to avoid conflicts

3. **Add retry logic** (handled automatically by RisingWave with logstore rewind)

### Issue 4: Sink Rate Limit Data Loss (v2.6.0)

**Symptoms**: Missing rows in downstream database when sink rate limit is set.

**Cause**: Known corner case in v2.6.0 where sink rate limit can cause data loss.

**Solution**: Upgrade to v2.6.1 or later.

**Workaround to re-sink missing rows**:
```sql
-- Issue UPDATE on missing rows to trigger re-sink
UPDATE my_table SET some_column = some_column WHERE id IN (...);
```

## Native PostgreSQL Sink vs JDBC Sink

| Aspect | Native PG Sink | JDBC Sink |
|--------|---------------|-----------|
| Performance | Generally better | Standard |
| Keepalive | OS-level | Configurable (MySQL/MariaDB only) |
| Foreign Keys | May have issues | Supported |
| Maturity | Some edge case bugs | More tested |

**Recommendation**: Start with native PG sink for PostgreSQL, fall back to JDBC if you encounter issues with foreign key constraints or specific edge cases.

## Diagnosis Queries

```sql
-- Check sink status
SELECT * FROM rw_sinks WHERE name = 'my_sink';

-- Check sink-related events
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SINK%'
ORDER BY timestamp DESC;

-- Check if sink is decoupled
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id;
```

## Prevention

1. **Enable sink decoupling** for production sinks to external databases
2. **Monitor downstream database** health and connection counts
3. **Set appropriate timeouts** based on your network latency
4. **Test failover scenarios** before production deployment

## Reference

- [JDBC Sink Connector](https://docs.risingwave.com/integrations/destinations/mysql)
- [PostgreSQL Sink Connector](https://docs.risingwave.com/integrations/destinations/postgresql)
- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)

---

### Troubleshoot Snowflake sink causing barrier stuck

**Impact:** CRITICAL - Restore streaming pipeline, prevent complete cluster stall

**Tags:** snowflake, sink, barrier, stuck, auto-schema-change, decoupling

## Problem Statement

Snowflake sinks can cause barrier stuck issues when sink commits take longer than the barrier interval. This is particularly problematic when `auto.schema.change` is enabled, which in RisingWave 2.7 defaults to disabling sink decoupling. When the Snowflake sink commit time exceeds the barrier interval, barriers accumulate and eventually stall the entire streaming pipeline.

**Note**: The default barrier interval is 1000ms (1 second). Check your current setting with `SHOW PARAMETERS;` and look for `barrier_interval_ms`.

## Symptoms

- Barrier latency increasing continuously (visible in Grafana)
- Barrier count accumulating (e.g., 64328 and growing)
- Snowflake sink throughput is very low or appears stuck
- Cluster enters recovery loop if barriers accumulate excessively

## Diagnosis Steps

### Step 1: Check Barrier Metrics

```sql
-- Check current barrier status via Grafana
-- Navigate to: risingwave_dashboard > Streaming > Barrier Latency
-- Look for: Latency > 1 minute or accumulating barrier count
```

### Step 2: Identify Snowflake Sink as Cause

```sql
-- Check sink decoupling status
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id
WHERE connector = 'snowflake';
```

If `is_decouple = false` for Snowflake sinks, they may be blocking barriers.

### Step 3: Check Snowflake Commit Time

In Grafana monitoring, check the average commit time for Snowflake sink. If commit time (e.g., ~6 seconds) exceeds your barrier interval, this causes accumulation.

```sql
-- Check current barrier interval (look for barrier_interval_ms in output)
SHOW PARAMETERS;
```

## Root Cause

In RisingWave 2.7, enabling `auto.schema.change` for Snowflake sink automatically disables sink decoupling. This means:
1. Barriers must wait for Snowflake commits to complete
2. Snowflake pipe flush can take 5-10+ seconds
3. If barrier interval is shorter than commit time, barriers accumulate faster than they complete

## Solutions

### Immediate Recovery

```sql
-- Option 1: Drop the problematic sink and restart cluster
DROP SINK snowflake_sink_name;
-- Restart cluster via cloud console or kubectl

-- Option 2: If drop hangs due to barrier stuck, pause source first
ALTER SOURCE my_source SET source_rate_limit = 0;
DROP SINK snowflake_sink_name;
ALTER SOURCE my_source SET source_rate_limit = default;
```

### Long-term Solutions

#### Solution 1: Increase Barrier Interval (Trade-off: Reduced freshness)

```sql
-- Check current barrier interval (look for barrier_interval_ms in output)
SHOW PARAMETERS;

-- Increase barrier interval to exceed Snowflake commit time
-- If commit takes ~6 seconds, set to 10+ seconds
ALTER SYSTEM SET barrier_interval_ms = 10000;

-- Then recreate the sink
DROP SINK snowflake_sink;
CREATE SINK snowflake_sink FROM my_mv WITH (...);
```

**Note**: Increasing barrier interval reduces data freshness and increases query latency.

#### Solution 2: Enable Sink Decoupling (Recommended if auto.schema.change not needed)

```sql
-- Enable sink decoupling before creating sink
SET sink_decouple = true;

-- Recreate sink without auto.schema.change
CREATE SINK snowflake_sink FROM my_mv WITH (
  connector = 'snowflake',
  -- ... other options
  -- Do NOT set auto.schema.change = 'true'
);
```

#### Solution 3: Upgrade to Latest Version

In newer versions (post-2.7), RisingWave supports auto schema change for decoupled sinks, eliminating this issue.

## Prevention

1. **Monitor Snowflake commit times**: Set up alerts for commit latency
2. **Test sink configuration**: Before production, verify sink decoupling status
3. **Plan for auto.schema.change**: Understand the trade-offs before enabling
4. **Set appropriate barrier interval**: Match to your slowest sink commit time

## Additional Context

- Snowflake sink uses Snowpipe for data ingestion, which has variable commit latency
- Auto schema change requires coupled sink to track schema versions
- This issue affects cluster-wide streaming, not just the Snowflake sink

## Reference

- [Snowflake Sink Connector](https://docs.risingwave.com/integrations/destinations/snowflake)
- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)

---

## CDC (HIGH)

### Configure and monitor sink decoupling

**Impact:** HIGH - Prevent barrier blocking, improve streaming stability

**Tags:** sink, decouple, connector, barrier, logstore

## Problem Statement

By default, sinks are coupled - barriers wait for data to be committed to external systems. If the external system is slow or unavailable, this blocks the entire streaming pipeline. Sink decoupling writes to an internal logstore first, preventing external systems from blocking barriers.

## Check Sink Decoupling Status

```sql
-- Check which sinks are decoupled
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id;
```

## Enable Sink Decoupling

### For New Sinks

```sql
-- Enable globally before creating sink
SET sink_decouple = true;

CREATE SINK my_sink FROM my_mv WITH (
  connector = 'kafka',
  ...
);
```

### For Existing Sinks

Cannot be changed directly - need to recreate the sink:

```sql
-- Drop and recreate with decoupling
SET sink_decouple = true;
DROP SINK my_sink;
CREATE SINK my_sink FROM my_mv WITH (...);
```

## Monitor Logstore Lag

When decoupled, data goes to logstore before external system. Monitor the lag:

```sql
-- Step 1: Find the internal table name for your sink
SELECT internal_table_name, job_name, job_id
FROM rw_catalog.rw_internal_table_info
WHERE job_name = 'my_sink_name';

-- Example output:
-- internal_table_name                    | job_name  | job_id
-- __internal_public_my_sink_7682_sink_2  | my_sink   | 7682

-- Step 2: Query the logstore lag using the discovered table name
-- Replace __internal_public_my_sink_7682_sink_2 with actual name from Step 1
SELECT
  (now() - to_timestamp(
    ((kv_log_store_epoch >> 16) & 70368744177663) / 1000 + 1617235200
  )) AS lag
FROM __internal_public_my_sink_7682_sink_2
ORDER BY kv_log_store_epoch ASC
LIMIT 1;
```

In Grafana: Check `Log Store Lag` panel.

## When to Use Sink Decoupling

**Enable decoupling when**:
- External system has variable latency
- External system may be temporarily unavailable
- Sink is not critical path (can tolerate eventual consistency)
- Barrier latency is high due to sink blocking

**Keep coupled when**:
- Need strict exactly-once semantics with external system
- External system is fast and reliable
- Storage overhead is a concern (logstore uses disk)

## Troubleshooting Decoupled Sinks

### Logstore Lag Growing

**Symptoms**: Lag increasing over time, data not reaching external system.

**Diagnosis**:
1. Check external system connectivity
2. Check sink error logs
3. Check if external system is rate limiting

**Solution**: Fix external system issues. Logstore will drain once fixed.

### High Storage Usage

**Cause**: Logstore retains data until confirmed delivered.

**Solution**:
- Fix slow/unavailable external system
- Consider sink throughput settings
- Monitor disk usage on compute nodes

### Sink Errors Not Blocking Pipeline

**Note**: With decoupling, sink errors don't immediately block streaming. Check logs regularly for sink issues.

```sql
-- Check for sink-related events
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SINK%'
ORDER BY timestamp DESC;
```

## Sink Types and Decoupling

| Connector | Decoupling Recommended | Notes |
|-----------|----------------------|-------|
| Kafka | Yes | High latency variance |
| JDBC/Postgres | Yes | Database can be slow |
| S3 | Yes | Network latency |
| Iceberg | Yes | Commit can be slow |
| Elasticsearch | Yes | Indexing delays |
| ClickHouse | Depends | Usually fast |

## Additional Context

- Decoupled sinks use compute node local storage for logstore
- Logstore data is checkpointed and survives restarts
- Decoupling adds write amplification (data written twice)
- Consider storage capacity when enabling for high-throughput sinks

## Reference

- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)
- [Connectors Overview](https://docs.risingwave.com/get-started/connectors)

---

### Troubleshoot CDC source issues

**Impact:** HIGH - Restore data ingestion, prevent replication lag accumulation

**Tags:** cdc, source, postgres, mysql, debezium, connector

## Problem Statement

CDC (Change Data Capture) sources can fail for various reasons including timeout, schema changes, offset expiration, and JVM memory issues. Quick diagnosis and resolution is critical to prevent data loss and lag accumulation.

## Common Issues and Solutions

### Issue 1: CDC Fails to Start Within Timeout

**Symptoms**:
```
Debezium streaming source of RW_CDC_xxx failed to start in timeout 30/60
```

**Solution** (RisingWave >= 2.6):
```sql
ALTER SOURCE my_cdc_source CONNECTOR WITH (
  cdc.source.wait.streaming.start.timeout = '120'
);
```

Note: The timeout may not be the root cause - investigate other issues too.

### Issue 2: Auto Schema Change Fails

**Symptoms**: Upstream schema change not appearing in RisingWave.

**Diagnosis**:
```sql
-- Check auto schema change failure events (v2.6+)
SELECT * FROM rw_event_logs
WHERE event_type = 'AUTO_SCHEMA_CHANGE_FAIL'
ORDER BY timestamp DESC;
```

**Solution**:
1. Ensure `auto.schema.change = 'true'` is configured in source
2. Check for unsupported data types (common cause)
3. For SQL Server: Auto schema change not supported, update capture instance manually

### Issue 3: CDC Offset Unavailable

**Symptoms**:
- Source stops consuming (throughput = 0)
- Logs show offset not available upstream

**Cause**: The stored offset has expired in upstream WAL/binlog (e.g., MySQL binlog rotation, MongoDB oplog aged out).

**Solution** (v2.7+):
```sql
-- Reset source to latest offset (DATA LOSS WARNING)
ALTER SOURCE my_source RESET;
RECOVER CLUSTER;
```

**Prevention**: Increase binlog/oplog retention upstream.

### Issue 4: JVM OOM (CDC-caused)

**Symptoms**:
```
ERROR risingwave_connector_node: Producer failure...
java.lang.OutOfMemoryError: Java heap space
```

**Solutions**:
```bash
# Option 1: Increase JVM heap (env var on compute node)
# Default is ~0.07 * remaining memory
JVM_HEAP_SIZE=2g
```

```sql
-- Option 2: Reduce Debezium queue size (v2.7+)
ALTER SOURCE my_source CONNECTOR WITH (
  debezium.max.queue.size = '2000'
);

-- Option 3: Adjust queue memory ratio
ALTER SOURCE my_source CONNECTOR WITH (
  debezium.queue.memory.ratio = '0.3'
);
```

### Issue 5: Null Values During Backfill

**Symptoms**: Some columns show NULL during backfill phase but have data upstream.

**Cause**: Uncommon data types not fully supported during backfill.

**Solution**: Create an issue for the specific data type - this is a known limitation being addressed.

## Postgres-Specific Issues

### Postgres WAL/Replication Lag Increasing

**Diagnosis**:
```sql
-- Check replication slot size on Postgres
SELECT slot_name,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_pretty,
       active
FROM pg_replication_slots;
```

Check if RisingWave is causing the lag:
1. Check source executor's internal state table for LSN updates
2. In v2.7+, view LSN reports in Grafana

**Common causes**:
- Barrier stuck in RisingWave (backpressure to source)
- Network issues between RisingWave and Postgres
- Source rate limited

### Migrating Postgres Host

When upstream Postgres host changes:

```sql
-- 1. Stop writes to original host
-- 2. Pause source
ALTER SOURCE my_source SET source_rate_limit = 0;

-- 3. Take snapshot and restore to new host
-- 4. On new host, recreate publication
-- CREATE PUBLICATION rw_publication FOR TABLE public.my_table;

-- 5. Update secret with new hostname
ALTER SECRET source_db_hostname WITH (backend = 'meta') AS 'new-host.example.com';

-- 6. Resume source
ALTER SOURCE my_source SET source_rate_limit = default;
```

## MySQL-Specific Issues

### Offline Schema Change Fails

**Symptoms**: Schema changes during RisingWave downtime not applied after restart.

**Solution**: Upgrade to v2.6+ which handles offline schema changes.

### Unsigned Type Overflow

**Symptoms**: Unsigned types (e.g., `UNSIGNED BIGINT`) show wrong values.

**Solution**: When defining columns, upcast all unsigned types to larger signed types.

## MongoDB-Specific Issues

### Table Has No Data

**Symptoms**: Newly created MongoDB CDC table is empty.

**Cause**: MongoDB CDC doesn't check connectivity on creation.

**Solution**: Verify connectivity before creating source. v2.7+ will fail creation if connectivity issues exist.

## Diagnosis Queries

```sql
-- Check source status
SELECT * FROM rw_sources WHERE name = 'my_source';

-- Check source throughput in Grafana
-- Panel: Source Throughput

-- Check for source-related events
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SOURCE%' OR event_type LIKE '%CDC%'
ORDER BY timestamp DESC;
```

## Additional Context

- CDC issues often cascade to barrier stuck due to backpressure
- Always check upstream database logs alongside RisingWave logs
- Consider source rate limiting during high-load periods

## Reference

- [Ingest from PostgreSQL CDC](https://docs.risingwave.com/ingestion/sources/postgresql/pg-cdc)
- [Ingest from MySQL CDC](https://docs.risingwave.com/ingestion/sources/mysql/mysql-cdc)
- [Debezium Configuration](https://debezium.io/documentation/reference/stable/connectors/)

---

## Cluster Operations (HIGH)

### Manage connections and secrets for external systems

**Impact:** HIGH - Secure credential management, prevent connectivity failures

**Tags:** connection, secret, credential, kafka, jdbc, iceberg, privatelink, security

## Problem Statement

RisingWave sources and sinks connect to external systems (Kafka, databases, object storage, Iceberg catalogs) using credentials and connection configurations. Managing these connections and secrets correctly prevents credential leaks, connectivity failures, and simplifies rotation.

## Connections

Connections define reusable network configurations (e.g., PrivateLink, SSH tunnels) that can be shared across multiple sources and sinks.

### List all connections

```sql
-- View all connections with their types and properties
SELECT * FROM rw_connections;
```

### Inspect a connection

```sql
SHOW CREATE CONNECTION my_kafka_connection;
```

### Create a PrivateLink connection

```sql
CREATE CONNECTION my_privatelink WITH (
  type = 'privatelink',
  provider = 'aws',
  service_name = 'com.amazonaws.vpce.us-east-1.vpce-svc-xxxx'
);
```

### Drop a connection

```sql
-- All dependent sources and sinks must be removed first
DROP CONNECTION my_kafka_connection;

-- Or drop with CASCADE (not supported for Iceberg connections)
DROP CONNECTION my_kafka_connection CASCADE;

-- Safe drop (no error if it doesn't exist)
DROP CONNECTION IF EXISTS my_kafka_connection;
```

### Troubleshooting connection issues

If a source or sink fails with connectivity errors:

```sql
-- 1. Check which connection the source/sink uses
SHOW CREATE SOURCE my_kafka_source;
-- Look for CONNECTION clause in the output

-- 2. Verify the connection exists and is configured correctly
SHOW CREATE CONNECTION my_connection;

-- 3. Check for errors in event logs
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SOURCE%' OR event_type LIKE '%SINK%'
ORDER BY timestamp DESC LIMIT 20;
```

## Secrets

Secrets store sensitive values (passwords, API keys, tokens) that are referenced by sources and sinks. Secret values are never displayed after creation.

### List all secrets

```sql
-- Shows secret names only (values are never displayed)
SELECT * FROM rw_secrets;
```

### Create a secret

```sql
CREATE SECRET my_kafka_password WITH ('actual-password-value');

CREATE SECRET my_s3_access_key WITH ('AKIAIOSFODNN7EXAMPLE');
CREATE SECRET my_s3_secret_key WITH ('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
```

### Use secrets in sources and sinks

```sql
-- Reference a secret in a source definition
CREATE SOURCE my_kafka_source (...)
WITH (
  connector = 'kafka',
  properties.bootstrap.server = 'broker:9092',
  properties.sasl.mechanism = 'PLAIN',
  properties.sasl.username = 'my-user',
  properties.sasl.password = SECRET my_kafka_password
);

-- Reference secrets in a sink definition
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  s3.access.key = SECRET my_s3_access_key,
  s3.secret.key = SECRET my_s3_secret_key,
  ...
);
```

### Drop a secret

```sql
DROP SECRET my_kafka_password;
```

**Note**: You cannot drop a secret that is currently referenced by an active source or sink. Drop the dependent objects first.

### Rotating secrets

Use `ALTER SECRET` to update a secret's value in place:

```sql
ALTER SECRET my_kafka_password AS 'new-password-value';
```

**Important**: Altering a secret does not take effect in running streaming jobs until they are restarted. Existing sources and sinks continue using the old credential value until the next restart or recovery.

If `ALTER SECRET` is not available (older RisingWave versions), rotate by recreating:

1. Create a new secret with the updated value
2. Recreate the source/sink referencing the new secret
3. Drop the old secret

```sql
-- 1. Create new secret
CREATE SECRET my_kafka_password_v2 WITH ('new-password-value');

-- 2. Recreate the source (will trigger backfill for MVs downstream)
DROP SOURCE my_kafka_source CASCADE;
CREATE SOURCE my_kafka_source (...)
WITH (
  ...
  properties.sasl.password = SECRET my_kafka_password_v2
);

-- 3. Drop old secret
DROP SECRET my_kafka_password;
```

**Important**: Dropping a source with CASCADE also drops all downstream MVs. Plan for backfill time when rotating credentials on critical sources.

## Connector Lifecycle Management

Sources and tables with connectors have additional lifecycle operations beyond secrets and connections.

### Updating Connector Properties (Without Secrets)

Use `ALTER SOURCE ... CONNECTOR WITH` or `ALTER TABLE ... CONNECTOR WITH` to update connector properties without recreating the source or table. This works for any connector type (Kafka, Kinesis, CDC, etc.):

```sql
-- Rotate plaintext credentials on a Kafka source
ALTER SOURCE my_kafka_source CONNECTOR WITH (
  'properties.sasl.username' = 'new-user',
  'properties.sasl.password' = 'new-password'
);

-- Update broker address for a Kafka source
ALTER SOURCE my_kafka_source CONNECTOR WITH (
  'properties.bootstrap.server' = 'new-broker:9092'
);

-- Update properties on a table with connector
ALTER TABLE my_cdc_table CONNECTOR WITH (
  'hostname' = 'new-db-host.example.com',
  'password' = 'new-password'
);
```

**Important**: After altering connector properties, run `RECOVER;` (requires superuser) to force streaming jobs to pick up the new values. Without recovery, existing actors may continue using cached old values.

**Note**: `CONNECTOR WITH` updates **plaintext** properties. If the source uses `SECRET` references, use `ALTER SECRET` instead (see [Rotating secrets](#rotating-secrets) above).

### Dropping a Connector from a Table

If a table with a connector needs to become a standalone table (e.g., the upstream source was permanently deleted):

```sql
ALTER TABLE my_cdc_table DROP CONNECTOR;
```

**Warning**: This is **irreversible** — you cannot re-add a connector to a table after dropping it. The table becomes a regular RisingWave table that only accepts DML inserts.

**When to use**: When the external stream (e.g., a Kafka topic or CDC source) has been permanently deleted and the table is receiving `ResourceNotFoundException` or similar errors that stall the streaming graph. Dropping the connector stops the error loop while preserving the existing data and downstream MVs.

### Handling Deleted External Streams

If an external stream (Kafka topic, database table for CDC) is deleted while a RisingWave source or table references it, the connector will repeatedly fail with errors like `ResourceNotFoundException`, `UnknownTopicOrPartition`, or similar. This can cause barrier stalls.

**Resolution options:**
1. **Recreate the external stream** with the same name/configuration — the connector will reconnect automatically on the next recovery
2. **Drop the connector** (for tables only): `ALTER TABLE my_table DROP CONNECTOR;` — preserves data but stops ingestion
3. **Drop the source/table**: `DROP SOURCE my_source CASCADE;` — removes the source and all downstream MVs
4. **Pause ingestion temporarily**: `ALTER SOURCE my_source SET source_rate_limit = 0;` — stops reading but the error may still occur during barrier processing

## Best Practices

1. **Always use SECRET for credentials** — Avoids plaintext passwords in DDL definitions visible in `SHOW CREATE`
2. **Use connections for shared network config** — Avoid duplicating PrivateLink/SSH settings across sources
3. **Name secrets descriptively** — Include the service and purpose, e.g., `kafka_prod_sasl_password`
4. **Audit secrets periodically** — List secrets and verify each is still in use
5. **Use `CONNECTOR WITH` for non-secret property changes** — Avoids full source recreation and downstream backfill
6. **Always `RECOVER` after connector property changes** — Ensures running actors pick up the new values

## Reference

- [CREATE SECRET](https://docs.risingwave.com/sql/commands/sql-create-secret)
- [ALTER SECRET](https://docs.risingwave.com/sql/commands/sql-alter-secret)
- [CREATE CONNECTION](https://docs.risingwave.com/sql/commands/sql-create-connection)
- [PrivateLink Configuration](https://docs.risingwave.com/ingestion/sources/kafka-config#privatelink-configuration)

---

### Diagnose and resolve pod health issues

**Impact:** CRITICAL - Restore cluster availability, prevent service outages

**Tags:** cluster, kubernetes, pod, health, crashloop, pending

## Problem Statement

Pod health issues (not healthy, pending, crashlooping) can cause service disruption. Quick diagnosis and resolution is essential to maintain cluster availability.

## Common Pod States and Solutions

### State 1: RisingWavePodNotHealthy

**Symptoms**: Pod is running but failing health checks.

**Diagnosis**:
```bash
kubectl describe pod <pod-name> -n <namespace>
kubectl logs <pod-name> -n <namespace> --tail=100
```

**Common causes**:
1. **Extension image missing** - Container image not available
2. **Resource exhaustion** - CPU/memory limits hit
3. **Startup probe timeout** - Service taking too long to start

**Solutions**:
```bash
# Check events
kubectl get events -n <namespace> --sort-by='.lastTimestamp'

# If image missing, trigger rebuild
# Check container registry for image availability

# If resource exhaustion, check limits
kubectl get pod <pod-name> -n <namespace> -o yaml | grep -A 10 resources
```

### State 2: RisingWavePodPending

**Symptoms**: Pod stuck in Pending state, not scheduled.

**Diagnosis**:
```bash
kubectl describe pod <pod-name> -n <namespace>
# Look for "Events" section at the bottom
```

**Common causes and solutions**:

1. **Insufficient resources**:
```bash
# Check node resources
kubectl describe nodes | grep -A 5 "Allocated resources"
# Solution: Scale nodes or reduce pod resource requests
```

2. **PVC pending**:
```bash
kubectl get pvc -n <namespace>
# Solution: Check storage class, ensure volume can be provisioned
```

3. **Node selector/affinity not satisfied**:
```bash
kubectl get pod <pod-name> -o yaml | grep -A 10 nodeSelector
# Solution: Ensure nodes with matching labels exist
```

4. **Taints and tolerations**:
```bash
kubectl describe nodes | grep Taints
# Solution: Add tolerations to pod spec if needed
```

### State 3: RisingWavePodCrashLooping

**Symptoms**: Pod repeatedly starting and crashing.

**Diagnosis**:
```bash
# Check crash logs
kubectl logs <pod-name> -n <namespace> --previous

# Check exit code
kubectl describe pod <pod-name> | grep -A 5 "Last State"
```

**Exit codes**:
- **Exit 137 (OOM Killed)**: Out of memory
- **Exit 1**: Application error
- **Exit 255**: Unknown/generic failure

**Solutions by exit code**:

**OOM (137)**:
```yaml
# Increase memory limits in deployment
resources:
  limits:
    memory: "8Gi"  # Increase as needed
```
See [perf-compute-node-oom](./perf-compute-node-oom.md) for detailed OOM troubleshooting.

**Application Error (1)**:
```bash
# Check logs for panic or error messages
kubectl logs <pod-name> --previous | grep -i "panic\|error\|fatal"
```

### State 4: Pod Phase Unknown

**Symptoms**: Pod shows "Unknown" phase.

**Cause**: Usually node communication issues.

**Diagnosis**:
```bash
# Check node status
kubectl get nodes
kubectl describe node <node-name>
```

**Solutions**:
```bash
# If node is NotReady, may need to drain and replace
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
# Then delete the node and let autoscaler provision new one
```

## Component-Specific Issues

### Meta Node CrashLooping

**Critical**: Meta is the control plane - issues cascade everywhere.

```bash
# Check meta logs
kubectl logs meta-0 --previous

# Common issues:
# - ETCD connection failure
# - Insufficient resources
# - State corruption (rare)
```

### Compute Node CrashLooping

Most often OOM or panic in streaming operators.

```bash
# Check if OOM
kubectl describe pod compute-0 | grep OOMKilled

# Check for panics
kubectl logs compute-0 --previous | grep panic
```

### Compactor CrashLooping

Usually resource issues or object store connectivity.

```bash
# Check compactor logs
kubectl logs compactor-0 --previous

# Verify object store access
# Check AWS/GCS/Azure credentials and connectivity
```

## Emergency Recovery

### Force Delete Stuck Pod

```bash
kubectl delete pod <pod-name> -n <namespace> --force --grace-period=0
```

### Recreate Node

When node is unhealthy:
```bash
# Drain the node
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# Delete the node
kubectl delete node <node-name>

# If using autoscaler, new node will be provisioned
# Otherwise, manually provision replacement
```

### Check Cloud Provider Status

External issues affecting pod health:

```bash
# Check node conditions
kubectl describe node <node-name> | grep -A 10 Conditions

# Network issues
# Disk pressure
# Memory pressure
```

## Monitoring Pod Health

```bash
# Watch pod status
kubectl get pods -n <namespace> -w

# Check all pod events
kubectl get events -n <namespace> --sort-by='.lastTimestamp' | tail -50
```

## Additional Context

- Pod health issues often have cascading effects
- Meta node issues affect the entire cluster
- Always check events and logs together
- Consider cluster autoscaling for resource issues

## Reference

- [Kubernetes Troubleshooting](https://kubernetes.io/docs/tasks/debug/)
- [RisingWave Cloud](https://docs.risingwave.com/cloud/intro)

---

### Audit user privileges and access control

**Impact:** HIGH - Ensure proper access control, identify privilege issues, support compliance

**Tags:** user, privilege, access-control, rbac, security, audit, schema, database

## Problem Statement

RisingWave supports role-based access control (RBAC) with users, roles, and privilege grants. Misconfigured privileges can cause "permission denied" errors for streaming jobs, prevent DDL operations, or leave overly broad access that violates security policies. This guide covers auditing and troubleshooting access control.

## List Users and Roles

```sql
-- List all users with their properties
SELECT * FROM rw_users;
```

Output includes user ID, name, and system privileges (is_super, can_create_db, can_create_user, can_login).

## Check User Privileges

### System-level privileges

```sql
-- Check a specific user's system privileges
SELECT name, is_super, can_create_db, can_create_user, can_login
FROM rw_users
WHERE name = 'my_user';
```

### Schema ownership

```sql
-- Show which schemas a user owns
SELECT s.name AS schema_name, u.name AS owner
FROM rw_schemas s
JOIN rw_users u ON s.owner = u.id
WHERE u.name = 'my_user';
```

### Database ownership

```sql
-- Show which databases a user owns
SELECT d.name AS database_name, u.name AS owner
FROM rw_databases d
JOIN rw_users u ON d.owner = u.id
WHERE u.name = 'my_user';
```

### Table-level privileges

```sql
-- Check privileges on a specific table
SELECT * FROM rw_table_privileges WHERE table_name = 'my_table';
```

## Common Permission Issues

### Issue 1: "permission denied" on DDL operations

**Symptoms**: User cannot create MVs, tables, or sinks.

**Diagnosis**:
```sql
-- Check if user has CREATE privilege on the schema
SELECT * FROM rw_users WHERE name = 'my_user';
-- Check is_super — superusers bypass all checks
```

**Solution**: Grant the minimum necessary privileges:
```sql
-- Allow creating objects in the schema
GRANT CREATE ON SCHEMA public TO my_user;

-- Grant SELECT on upstream tables the user's MVs will read from
GRANT SELECT ON TABLE source_table1, source_table2 TO my_user;

-- Only use broad grants when the user genuinely needs access to all tables
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO my_user;
```

### Issue 2: Streaming job fails with permission error

**Symptoms**: MV creation fails because the user lacks SELECT on upstream tables.

**Solution**:
```sql
GRANT SELECT ON TABLE source_table TO my_user;
-- Or grant on all tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO my_user;
```

### Issue 3: Sink cannot access source data

**Symptoms**: Sink creation fails with permission errors.

**Solution**:
```sql
GRANT SELECT ON TABLE my_mv TO sink_user;
```

## Security Audit Checklist

Run these queries periodically to audit access:

```sql
-- 1. List all superusers (should be minimal)
SELECT name FROM rw_users WHERE is_super = true;

-- 2. List all users who can create databases
SELECT name FROM rw_users WHERE can_create_db = true;

-- 3. List all users who can create other users
SELECT name FROM rw_users WHERE can_create_user = true;

-- 4. List object ownership (find orphaned objects from deleted users)
SELECT r.name AS object_name, r.relation_type, u.name AS owner
FROM rw_relations r
JOIN rw_users u ON r.owner = u.id
ORDER BY u.name, r.relation_type;
```

## User Management

### Create a user

```sql
CREATE USER app_reader WITH PASSWORD 'secure_password' LOGIN;
```

### Grant read-only access

```sql
-- Read-only on all current tables in public schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_reader;

-- Allow connecting
GRANT CONNECT ON DATABASE dev TO app_reader;
```

### Revoke access

```sql
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM former_user;
```

## Reference

- [User and Access Control](https://docs.risingwave.com/sql/commands/sql-create-user)
- [GRANT](https://docs.risingwave.com/sql/commands/sql-grant)
- [REVOKE](https://docs.risingwave.com/sql/commands/sql-revoke)

---

## Operational Best Practices (CRITICAL)

### Manage serving nodes and prevent batch query overload

**Impact:** CRITICAL - Prevent production outages from runaway batch queries saturating serving nodes

**Tags:** serving, batch, query, processlist, kill, query-mode, distributed-query-limit, statement-timeout, index

## Problem Statement

Serving (batch query) overload is the most common cause of user-facing production outages in RisingWave deployments with dedicated serving nodes. The core issue: **uncontrolled batch queries — especially ad-hoc analytical queries, parallel application queries, and full table scans — can saturate serving node CPU and memory, making all user-facing queries fail.** Unlike streaming issues which cause data lag, serving overload causes immediate query failures visible to end users.

## Architecture: Serving vs Streaming Nodes

RisingWave supports three compute node roles:

| Role | Function | Workload |
|------|----------|----------|
| `serving` | Read-only, executes batch queries | Point lookups, analytical queries |
| `streaming` | Processes streaming pipeline | MV maintenance, source ingestion |
| `hybrid` (default) | Both streaming and serving | Combined workload |

**Key insight:** Serving nodes share no resources with streaming nodes. Serving issues do not affect streaming pipeline health (barrier latency, MV updates), and vice versa. However, serving node OOM or CPU saturation makes **all** batch queries fail — including production-critical ones.

## Critical Rule: Disconnecting Does NOT Cancel Queries

**This is the single most common operational mistake.** When a client disconnects (closes psql, closes a Superset tab, terminates an application), the running query on the serving node **continues executing**. Resources are consumed until the query completes or times out.

```sql
-- Step 1: Find running queries
SHOW PROCESSLIST;
-- Output columns: worker_id, id, user, host, database, time, info
-- 'time' shows how long the query has been running
-- 'info' shows the SQL statement (may be truncated)

-- Step 2: Kill specific slow queries
KILL '<process_id>';    -- e.g., KILL '2:0';

-- Tip: If SHOW PROCESSLIST output is too large to read interactively,
-- dump to a file from the command line:
-- psql -h <host> -p <port> -d <db> -U <user> -t -c "SHOW PROCESSLIST" > processes.txt
```

**Limitations of SHOW PROCESSLIST:**
- Only shows queries on the frontend node you're connected to
- SQL statements may be truncated — check application/CloudWatch logs for full SQL
- The output can be many pages long on busy systems

## Anti-Pattern: Parallel Query Floods

Applications that send hundreds or thousands of queries in parallel (e.g., one query per entity ID) can instantly saturate serving nodes.

```sql
-- BAD: Application sends 1,000 queries in parallel (one per entity_id)
-- Each query runs in distributed mode, consuming serving node resources
-- 1,000 concurrent distributed queries overwhelm the serving cluster
SELECT * FROM analytics_table WHERE entity_id = ?;  -- × 1,000 in parallel

-- BETTER: Sequential execution with local query mode
SET query_mode = 'local';  -- Runs on frontend only, no serving node resources
SELECT * FROM analytics_table WHERE entity_id = ?;  -- One at a time
```

**Guidelines for application query patterns:**
- **Rate-limit concurrent queries** from batch/ETL applications
- Switch from parallel to sequential execution for bulk lookups
- Use `query_mode = 'local'` for simple point lookups that can run on the frontend alone
- Consider batching multiple entity lookups into a single `WHERE entity_id IN (...)` query

## Anti-Pattern: Full Table Scans on Large Tables

Queries without proper WHERE clauses or missing indexes cause full scans on multi-TB tables, consuming all serving CPU and memory.

```sql
-- BAD: Full table scan on a large table — saturates serving nodes
SELECT * FROM event_log WHERE doc_id IN ('a', 'b', 'c');
-- If doc_id is not indexed and event_log has billions of rows,
-- this scans the entire table

-- GOOD: Create an index on the lookup column
CREATE INDEX idx_event_log_doc_id ON event_log (doc_id);
-- Now the same query uses an index lookup instead of a full scan
```

**How to detect full scans:**
```sql
-- Use EXPLAIN to check the query plan before running
EXPLAIN SELECT * FROM event_log WHERE doc_id IN ('a', 'b', 'c');
-- Look for "StreamTableScan" or "BatchSeqScan" — indicates a full scan
-- Look for "BatchLookupJoin" or index usage — indicates efficient access
```

## Query Mode: Local vs Distributed

RisingWave supports three query execution modes:

| Mode | Where it Runs | Use When |
|------|--------------|----------|
| `auto` (default) | RisingWave decides | General use |
| `local` | Frontend node only | Simple point lookups, low-cost queries |
| `distributed` | Across serving nodes | Complex analytical queries, joins, aggregations |

```sql
-- Set for current session
SET query_mode = 'local';

-- Check current mode
SHOW query_mode;
```

**`local` mode** avoids serving node load entirely — the frontend executes the query using its own block cache and meta cache. This is ideal for simple point lookups on indexed MVs. However, complex queries (joins, aggregations, large scans) may be slower or fail in local mode.

**`distributed` mode** spreads work across serving nodes for better parallelism, but each query consumes serving node resources and counts toward the distributed query limit.

## Safeguard: Distributed Query Limits

RisingWave provides two config-level limits to prevent serving node overload:

```toml
# In frontend node config (risingwave.toml)
[batch]
# Max concurrent distributed queries per frontend node
# When exceeded, new distributed queries are rejected with QueryReachLimit error
distributed_query_limit = 20

# Max batch queries (local + distributed) per frontend node
max_batch_queries_per_frontend_node = 50
```

When the limit is hit, new queries receive a `QueryReachLimit` error. **Do not blindly increase the limit** — this just delays the crash. Instead, identify and fix the queries consuming resources.

## Safeguard: Statement Timeout

Set a timeout to automatically kill long-running queries:

```sql
-- Session-level: kill queries after 5 minutes
SET statement_timeout = '300s';

-- Config-level default (risingwave.toml): default is 3600s (1 hour)
-- [batch]
-- statement_timeout_in_sec = 300
```

**Recommendation:** Set a cluster-wide default of 5–10 minutes for environments where ad-hoc queries are common. Applications that need longer-running queries can override per-session.

## Best Practice: Index Design for Serving Performance

Indexes are the primary tool for avoiding full table scans. Unlike PostgreSQL, **RisingWave indexes include all columns by default**, so every index is essentially a covering index.

```sql
-- Create an index on the most common lookup column
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- For multi-column lookups, include all filter columns
CREATE INDEX idx_orders_status_date ON orders (status, created_date);

-- Use DISTRIBUTED BY for skewed data
CREATE INDEX idx_orders_customer ON orders (customer_id)
  DISTRIBUTED BY (customer_id);
```

**When to create an index:**
- Any MV queried by end users with a WHERE clause on a non-primary-key column
- Tables used in temporal joins (index on the dimension table's join column)
- Any table where EXPLAIN shows full scans for common query patterns

## Best Practice: Serving Node Memory Configuration

Serving nodes need different memory allocation than streaming/hybrid nodes:

| Component | Streaming Node | Serving Node |
|-----------|---------------|-------------|
| Shared buffer | 30% of memory | Minimal (~1MB) |
| Block cache | 10–20% | 30% of memory |
| Meta cache | 5–10% | 10% of memory |
| Operator cache | 20–30% | Not needed |
| Query execution | Remainder | Remainder (~60%) |

Serving nodes don't need shared buffer or operator cache. Allocate that memory to block cache (for caching data blocks from object storage) and query execution memory.

## Diagnosis: Serving Node Overload

```sql
-- Step 1: Check for running queries
SHOW PROCESSLIST;
-- Sort mentally by 'time' column — longest-running queries are usually the problem

-- Step 2: Kill queries running longer than a threshold (e.g., 30 minutes)
-- Manually identify and KILL each one
KILL '<process_id>';

-- Step 3: Check query plans for problematic queries
EXPLAIN <the slow query>;
-- Look for: full table scans, missing indexes, cross joins

-- Step 4: Check if indexes exist for common access patterns
-- (RisingWave does not have a built-in index advisor —
-- review EXPLAIN output for common queries)
```

## Emergency: All Serving Queries Failing

1. **Find and kill runaway queries**: `SHOW PROCESSLIST;` then `KILL` all queries with long execution times
2. **If too many to kill manually**: Restart the serving nodes (batch queries are stateless, restart is safe)
   ```
   kubectl delete pod <serving-pod-name>
   ```
   Note: Restarting serving nodes makes batch queries temporarily unavailable (~1 minute)
3. **Set a statement timeout** to prevent recurrence: `SET statement_timeout = '300s';` or configure in `risingwave.toml`
4. **Lower the distributed query limit** if parallel query floods are the cause
5. **Identify the source application** sending problematic queries and coordinate with the application team

## Additional Context

- Serving node issues do **not** affect streaming pipeline health — barrier latency, MV updates, and source ingestion continue normally
- MV backfill/creation may cause I/O contention on serving nodes in hybrid deployments — use dedicated serving nodes to avoid this
- No built-in isolation between "online" (production-facing) and "offline" (ad-hoc) batch queries — all share the same serving nodes. Application-level query routing is the only current solution
- Scaling serving nodes horizontally increases total query capacity but does not solve individual runaway query problems
- Batch queries can spill to disk under memory pressure, which prevents OOM but degrades performance

## Reference

- [RisingWave SHOW PROCESSLIST](https://docs.risingwave.com/sql/commands/sql-show-processlist)
- [RisingWave Dedicated Compute Nodes](https://docs.risingwave.com/operate/dedicated-compute-node)
- [RisingWave Performance FAQ](https://docs.risingwave.com/performance/faq)

---

## Diagnostic Queries (HIGH)

### Benchmark environment setup and testing methodology for meaningful results

**Impact:** HIGH - Avoid false conclusions from unrepresentative tests, saving days of wasted optimization effort

**Tags:** benchmark, testing, environment, docker, methodology, data-volume, streaming

## Problem Statement

Performance benchmarks in non-representative environments lead to false conclusions. Docker playground uses in-memory state (data lost after 30 minutes of inactivity), Docker Compose uses local MinIO (local disk I/O), while production uses remote object storage (S3, GCS, Azure Blob). Single-event tests miss aggregation and join behavior that only manifests under volume. Without proper methodology, teams optimize for artifacts of the test environment rather than real production bottlenecks.

## Environment Differences That Matter

### Playground mode (Docker single-container)

```bash
docker run -it --pull=always -p 4566:4566 risingwavelabs/risingwave:latest playground
```

- **State backend:** In-memory (filesystem-backed in standalone mode)
- **Metadata:** Embedded SQLite
- **Auto-shutdown:** Terminates after 30 minutes of inactivity, losing all data
- **Use for:** Quick syntax validation, learning SQL, single-query testing
- **Do NOT use for:** Performance benchmarks, state size testing, durability testing

### Docker Compose (local MinIO)

```bash
docker compose up -d
```

- **State backend:** MinIO on local disk (S3-compatible, but local I/O)
- **Metadata:** etcd
- **Compactor:** Runs locally, competing with compute for CPU/memory
- **Use for:** Functional testing, pipeline correctness verification, small-scale performance comparisons
- **Limitations:** Local disk I/O is orders of magnitude faster than remote S3 for random reads. Compaction runs on the same machine, distorting CPU/memory profiles.

### Production (RisingWave Cloud / self-hosted with remote object storage)

- **State backend:** Remote object storage (S3, GCS, Azure Blob, etc.)
- **Compute cache:** Local NVMe or EBS for disk cache; all reads hit cache first, S3 only for cold data
- **Compactor:** Separate nodes (in cloud) or co-located (self-hosted)
- **Network:** Object store access adds latency to cold reads and compaction I/O

### Key differences summary

| Property | Playground | Docker Compose | Production |
|----------|-----------|----------------|------------|
| State storage | In-memory / local FS | Local MinIO | Remote S3/GCS/Azure |
| Disk cache behavior | N/A | Local disk (fast) | NVMe/EBS cache → S3 fallback |
| Compaction I/O | Local | Local (contends with compute) | Separate compactor nodes (cloud) |
| Network latency to state | None | None | ~1-10ms per S3 call (cold reads) |
| Representative of prod? | No | Partially | Yes |
| Resource contention | Single process | All services on one host | Isolated nodes |

## Data Volume Requirements

### Why volume matters for streaming benchmarks

Streaming operators behave differently under volume than with single events:

1. **Aggregation operators** accumulate state proportional to group cardinality. A `GROUP BY user_id` with 1 user is trivial; with 10M users it stresses memory and compaction.
2. **Join operators** probe state for every incoming record. Join performance depends on state table size, not just throughput rate.
3. **Temporal filters** clean expired state at barrier boundaries. Without enough data to generate state, you can't test whether state cleaning works.
4. **Window functions** maintain partition state. Under-populated partitions miss the performance characteristics of production workloads.

### Minimum volume guidelines

| Test Objective | Minimum Data Volume | Why |
|---------------|-------------------|-----|
| Functional correctness | 10-100 rows per table | Enough to verify output logic |
| Aggregation performance | 100K+ rows with realistic cardinality | State must reach meaningful size |
| Join performance | Both sides populated with realistic ratios | Join amplification only visible at scale |
| State cleaning (temporal filter / TTL) | Run for 10+ minutes with continuous inserts | Need multiple barrier cycles with state accumulation and expiration |
| Backfill performance | Full production-scale data | Backfill speed depends on source table size |
| End-to-end latency | 1K+ events/second sustained for 5+ minutes | Latency stabilizes after initial burst |

### Generating test data

```sql
-- Generate test data directly in RisingWave
-- For a fact table:
INSERT INTO events (event_id, user_id, amount, created_at)
SELECT
  generate_series AS event_id,
  (random() * 10000)::int AS user_id,
  (random() * 1000)::decimal(10,2) AS amount,
  now() - interval '30 days' * random() AS created_at
FROM generate_series(1, 100000);
```

For sustained streaming benchmarks, use a Kafka source with a data generator (e.g., `datagen` connector or `kafka-producer-perf-test`).

```sql
-- RisingWave's built-in datagen connector for testing
CREATE TABLE test_events (
  event_id int,
  user_id int,
  amount decimal,
  created_at timestamp
) WITH (
  connector = 'datagen',
  fields.event_id.kind = 'sequence',
  fields.event_id.start = '1',
  fields.user_id.kind = 'random',
  fields.user_id.min = '1',
  fields.user_id.max = '10000',
  fields.amount.kind = 'random',
  fields.amount.min = '1',
  fields.amount.max = '1000',
  datagen.rows.per.second = '5000'
) FORMAT PLAIN ENCODE JSON;
```

## Streaming Operator Testing Pitfalls

### Pitfall 1: Single-event tests for aggregation workloads

Inserting one row and checking the output only validates SQL syntax, not performance. Aggregation operators need volume to expose state management costs.

**What to do instead:** Insert enough data to populate realistic group cardinality, then measure throughput and latency under sustained load.

### Pitfall 2: Testing temporal joins by inserting into the dimension (right) side

Temporal joins (`FOR SYSTEM_TIME AS OF PROCTIME()`) only trigger output when the stream (left) side receives new data. Inserting into the dimension (right) side produces zero output — this is expected behavior, not a bug.

**What to do instead:** Drive test data from the stream (left) side. For details, see the temporal join testing pitfall in [perf-join-optimization](./perf-join-optimization.md).

### Pitfall 3: Measuring latency from a single event

RisingWave processes data in micro-batches at barrier intervals (default: 1 second). A single event's end-to-end latency includes waiting for the next barrier, making it misleading. Latency should be measured as the sustained p50/p99 under continuous load.

**What to do instead:** Generate continuous load for several minutes and measure steady-state latency from Grafana (Streaming > Barrier Latency).

### Pitfall 4: Testing in a quiescent system

A freshly started system with no data has empty caches, no compaction pressure, and no concurrent workloads. Production systems have background compaction, concurrent queries, and memory pressure from existing state.

**What to do instead:** Pre-populate tables with representative data volumes before running the benchmark. Let the system reach steady state (compaction caught up, caches warm) before measuring.

### Pitfall 5: Ignoring compaction during benchmarks

Heavy inserts trigger compaction, which competes for CPU and I/O. Short benchmarks may not trigger enough compaction to reflect production behavior.

**What to do instead:** Run benchmarks long enough for at least several compaction cycles. Monitor compaction metrics in Grafana (Hummock > Compaction).

## Environment Checklist

Before trusting benchmark results, verify:

### Infrastructure
- [ ] State backend matches production (object storage, not local disk)
- [ ] Compute resources (CPU, memory) are comparable to production
- [ ] Network conditions are representative (especially for remote object store)
- [ ] Compactor is deployed in the same configuration as production

### Data
- [ ] Data volume is sufficient for the test objective (see guidelines above)
- [ ] Data cardinality (number of distinct groups/keys) matches production
- [ ] Data distribution (skew) matches production patterns
- [ ] Data types and sizes match production schema

### Workload
- [ ] Throughput rate matches production (events per second)
- [ ] Concurrent workloads are present if testing under load
- [ ] Benchmark runs long enough for steady state (5+ minutes minimum)
- [ ] Multiple iterations are run to account for variance

### Measurement
- [ ] Metrics are collected from the steady-state period (not including warmup)
- [ ] Barrier latency, throughput, and memory usage are all tracked
- [ ] State table sizes are recorded (not just query latency)
- [ ] Compaction metrics are monitored for I/O pressure

## When Docker Compose Is Sufficient

Docker Compose with local MinIO is acceptable for:

1. **Correctness testing** — Verifying pipeline output is correct
2. **Relative comparison** — Comparing two MV designs against each other (same environment bias cancels out)
3. **Functional regression** — Ensuring changes don't break output
4. **Development iteration** — Rapid prototyping of MV definitions

Docker Compose is **not sufficient** for:

1. **Absolute latency targets** — Local disk I/O makes everything faster than production
2. **Memory capacity planning** — Single-host resource contention differs from distributed
3. **Compaction behavior** — Local compaction differs from separate compactor nodes
4. **Scale testing** — Single-node parallelism is not representative of multi-node

## Quick-Start Benchmark Template

For a quick but meaningful streaming benchmark:

```sql
-- 1. Create source with datagen connector (sustained load)
CREATE TABLE bench_source (
  id int,
  key int,
  value decimal,
  ts timestamp
) WITH (
  connector = 'datagen',
  fields.id.kind = 'sequence',
  fields.id.start = '1',
  fields.key.kind = 'random',
  fields.key.min = '1',
  fields.key.max = '100000',
  fields.value.kind = 'random',
  fields.value.min = '1',
  fields.value.max = '10000',
  datagen.rows.per.second = '10000'
) FORMAT PLAIN ENCODE JSON;

-- 2. Create the MV being benchmarked
CREATE MATERIALIZED VIEW bench_mv AS
SELECT key, count(*) AS cnt, sum(value) AS total
FROM bench_source
GROUP BY key;

-- 3. Wait 5+ minutes for steady state

-- 4. Check metrics
-- Grafana: Streaming > Barrier Latency (should be stable)
-- Grafana: Streaming > Source Throughput (should match datagen rate)

-- 5. Check state size
SELECT total_key_count,
       round((total_key_size + total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats s
JOIN rw_catalog.rw_materialized_views m ON s.id = m.id
WHERE m.name = 'bench_mv';

-- 6. Run EXPLAIN ANALYZE for bottleneck detection
-- EXPLAIN ANALYZE (duration_secs 30) MATERIALIZED VIEW bench_mv;

-- 7. Clean up
DROP MATERIALIZED VIEW bench_mv;
DROP TABLE bench_source;
```

## Additional Context

- For EXPLAIN ANALYZE to identify bottleneck operators, see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md)
- For MV pipeline optimization after benchmarking, see [perf-mv-pipeline-optimization](./perf-mv-pipeline-optimization.md)
- For temporal join behavior and testing, see [perf-join-optimization](./perf-join-optimization.md)
- For barrier latency diagnosis, see [perf-barrier-stuck](./perf-barrier-stuck.md)

## Reference

- [RisingWave Docker Compose Deployment](https://docs.risingwave.com/deploy/risingwave-docker-compose)
- [RisingWave Storage Overview](https://docs.risingwave.com/store/overview)
- [RisingWave datagen Connector](https://docs.risingwave.com/ingest/supported-sources-and-formats)
- [RisingWave Grafana Dashboard](https://docs.risingwave.com/operate/monitor-risingwave-cluster)

---

### Essential diagnostic SQL queries

**Impact:** HIGH - Quickly identify issues, reduce investigation time by 80%

**Tags:** diagnostic, sql, queries, troubleshooting, catalog

## Problem Statement

RisingWave exposes system information through catalog tables. Knowing which queries to run accelerates troubleshooting and provides crucial context for any investigation.

## First Response Queries

**Always run these first when investigating any issue:**

```sql
-- 1. Check recent system events (v1.5+)
SELECT * FROM rw_event_logs ORDER BY timestamp DESC LIMIT 20;

-- 2. Check streaming job health
SELECT name,
       CASE WHEN definition IS NOT NULL THEN 'RUNNING' ELSE 'UNKNOWN' END AS status
FROM rw_materialized_views;

-- 3. Check source throughput (via Grafana or check for zero)
SELECT id, name, connector FROM rw_sources;
```

## Streaming Diagnostics

### Get MV/Table by Fragment or Actor ID

```sql
-- Get MV name by fragment ID
SELECT rw_materialized_views.name AS mv_name,
       rw_schemas.name AS schema_name
FROM rw_materialized_views
JOIN rw_fragments ON rw_materialized_views.id = rw_fragments.table_id
JOIN rw_schemas ON rw_schemas.id = rw_materialized_views.schema_id
WHERE fragment_id = 285211;  -- Your fragment ID

-- Get MV info by actor ID
SELECT m.name, f.fragment_id, a.actor_id
FROM rw_actors a
JOIN rw_fragments f ON a.fragment_id = f.fragment_id
JOIN rw_materialized_views m ON f.table_id = m.id
WHERE a.actor_id = 20836;
```

### Check Actor Distribution

```sql
-- Actors per worker node
SELECT worker_id, count(*) AS actor_count
FROM rw_actors
GROUP BY worker_id;

-- Detailed distribution for specific MV
SELECT worker_id, count(*) AS actor_count
FROM rw_fragments f
JOIN rw_materialized_views m ON f.table_id = m.id
JOIN rw_actors a ON f.fragment_id = a.fragment_id
WHERE m.name = 'my_mv'
GROUP BY worker_id;
```

### Check Streaming Parallelism

```sql
-- Overall parallelism
SELECT * FROM rw_streaming_parallelism;

-- Parallelism for specific job
SELECT rf.fragment_id, count(*) AS actor_cnt
FROM rw_fragments rf
JOIN rw_actors ra ON rf.fragment_id = ra.fragment_id
WHERE <TABLE_ID> = ANY(state_table_ids)
GROUP BY rf.fragment_id;
```

### Get Streaming Job Dependencies

```sql
-- Find downstream MVs depending on a table/MV
WITH matview_oids AS (
  SELECT d.objid AS matview_oid
  FROM rw_catalog.rw_depend d
  JOIN (SELECT oid FROM pg_class WHERE relname = 'your_table_name') t
    ON d.refobjid = t.oid
)
SELECT m.id, m.name, m.definition
FROM rw_catalog.rw_materialized_views m
JOIN matview_oids o ON m.id = o.matview_oid;
```

### Get Job Name from State Table ID

```sql
WITH t AS (
  SELECT table_id FROM rw_fragments
  WHERE array_position(state_table_ids, 123) IS NOT NULL
),
m AS (
  SELECT schema_id, id, name, 'MV' AS job FROM rw_materialized_views UNION
  SELECT schema_id, id, name, 'TABLE' AS job FROM rw_tables UNION
  SELECT schema_id, id, name, 'SINK' AS job FROM rw_sinks UNION
  SELECT schema_id, id, name, 'SOURCE' AS job FROM rw_sources
)
SELECT rw_schemas.name AS schema, m.name, m.job
FROM t JOIN m ON t.table_id = m.id
JOIN rw_schemas ON rw_schemas.id = m.schema_id;
```

## Storage Diagnostics

### Check SST Layout

```sql
SELECT compaction_group_id,
       level_id,
       level_type,
       sub_level_id,
       count(*) AS total_file_count,
       round(sum(file_size) / 1024.0 / 1024.0) AS total_size_mb
FROM rw_catalog.rw_hummock_sstables
GROUP BY compaction_group_id, level_type, level_id, sub_level_id
ORDER BY compaction_group_id, level_id, sub_level_id DESC;
```

### Check Table Physical Size

```sql
SELECT id,
       total_key_count,
       round((total_key_size + total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats
ORDER BY size_mb DESC
LIMIT 20;
```

### Check Compaction Group Configs

```sql
SELECT * FROM rw_catalog.rw_hummock_compaction_group_configs ORDER BY id;
```

### Check Delete Ratio

```sql
WITH sst_delete_ratio AS (
  SELECT sstable_id,
         compaction_group_id,
         level_id,
         stale_key_count * 1.0 / NULLIF(total_key_count, 0) AS delete_ratio,
         jsonb_array_elements_text(table_ids) AS tid
  FROM rw_catalog.rw_hummock_sstables
)
SELECT tid, level_id, avg(delete_ratio) AS avg_delete_ratio
FROM sst_delete_ratio
WHERE delete_ratio IS NOT NULL
GROUP BY tid, level_id
HAVING avg(delete_ratio) > 0.3
ORDER BY avg_delete_ratio DESC;
```

## Sink Diagnostics

```sql
-- Check sink decoupling status
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id;

-- Check sink definition
SHOW CREATE SINK my_sink;
```

## Source Diagnostics

```sql
-- Check source definition
SHOW CREATE SOURCE my_source;

-- Check source connector config
SELECT * FROM rw_sources WHERE name = 'my_source';

-- Check current rate limits for all sources
SELECT r.name, r.id, rl.rate_limit, rl.fragment_id, rl.node_name
FROM rw_sources r
JOIN rw_rate_limit rl ON r.id = rl.table_id
ORDER BY r.name;

-- Check current rate limits for tables with connectors
SELECT r.name, r.id, rl.rate_limit, rl.fragment_id, rl.node_name
FROM rw_tables r
JOIN rw_rate_limit rl ON r.id = rl.table_id
ORDER BY r.name;
```

**Note**: `rw_rate_limit` only shows entries for objects that have an explicit rate limit set. Objects using the default (unlimited) rate will not appear.

## Get Object Definitions

```sql
-- For any object
SELECT relationid, schemaname, relationname, relationtype, definition
FROM rw_catalog.rw_relation_info
WHERE relationname = 'my_object';

-- Specific types
SHOW CREATE TABLE t;
SHOW CREATE MATERIALIZED VIEW mv;
SHOW CREATE SINK s;
SHOW CREATE SOURCE s;
```

## Query Plan Analysis

For all EXPLAIN variants, how to read streaming plans, EXPLAIN ANALYZE runtime metrics, and a red flag table for spotting problems, see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md).

## Worker Node Information

```sql
-- Get worker info for an actor
SELECT worker_id, host, port, type, state
FROM rw_actors t1
JOIN rw_worker_nodes t3 ON t1.worker_id = t3.id
WHERE actor_id = 44609;

-- Get all worker nodes
SELECT * FROM rw_worker_nodes;
```

## Data Freshness Diagnostic Runbook

When users report "data is stale" or "MV returns no recent data", follow this decision tree:

### Step 1: Check barrier latency

```sql
-- In Grafana: Streaming > Barrier Latency
-- If barrier latency > 1 minute, the entire pipeline is stalled
-- See perf-barrier-stuck for resolution
```

If barrier latency is high, data freshness is blocked cluster-wide — fix the barrier issue first.

### Step 2: Check source lag

```sql
-- Check if sources are keeping up with upstream
-- In Grafana: Source Throughput, or for Kinesis check Iterator Age in AWS console
-- For Kafka check consumer lag in Kafka tools

-- Check if any sources are rate-limited (may be intentionally throttled)
-- NULL rate_limit means no explicit limit is set (unlimited)
SELECT r.name, r.id, rl.rate_limit
FROM rw_sources r
LEFT JOIN rw_rate_limit rl ON r.id = rl.table_id;
```

If source lag is growing, either the rate limit is too low or the cluster cannot process fast enough. See [perf-streaming-tuning](./perf-streaming-tuning.md) for rate limit guidance.

**Warning**: If the rate limit is lower than upstream production rate, data in the upstream queue (Kafka/Kinesis) may be lost when retention expires.

### Step 3: Check MV backfill status

```sql
-- Is the MV still being backfilled?
SELECT ddl_id, create_type, ddl_statement, progress, initialized_at
FROM rw_catalog.rw_ddl_progress;
```

If the MV is still backfilling, its data is incomplete. With background DDL (`create_type = 'BACKGROUND'`), queries against the MV return partial results. With foreground DDL, the MV is not yet queryable — the `CREATE` statement is still blocking. See [perf-ddl-background-management](./perf-ddl-background-management.md) for backfill visibility details.

### Step 4: Check for immediate visibility needs

```sql
-- After DML (INSERT/UPDATE/DELETE), data is visible to downstream MVs
-- only after the next barrier checkpoint. To force immediate visibility:
FLUSH;
-- Then query again

-- Or enable implicit flush for the session (every DML blocks until visible):
SET implicit_flush = true;
INSERT INTO my_table VALUES (...);
-- Now all downstream MVs immediately reflect this insert
```

## Additional Context

- Most catalog tables are in `rw_catalog` schema
- Some queries may be expensive on large clusters - use LIMIT
- Catalog data is eventually consistent during cluster operations

## Reference

- [RisingWave System Catalogs](https://docs.risingwave.com/sql/system-catalogs/overview)
- [SHOW CREATE Commands](https://docs.risingwave.com/sql/commands/sql-show-create-mv)

---

### Read and interpret EXPLAIN output for streaming jobs

**Impact:** HIGH - Identify bottleneck operators, detect suboptimal plans, and diagnose runtime performance issues

**Tags:** explain, explain-analyze, streaming-plan, diagnosis, operator, performance

## Problem Statement

RisingWave's streaming plans are complex operator trees. Without knowing how to read them, it's impossible to detect suboptimal join types, missing temporal filter pushdown, unnecessary state, or runtime bottlenecks. This guide covers how to use EXPLAIN variants, read operator trees, interpret runtime metrics, and spot red flags.

## EXPLAIN Variants

```sql
-- Streaming plan (before creating)
EXPLAIN CREATE MATERIALIZED VIEW mv AS SELECT ...;

-- Distributed plan with state table info
EXPLAIN (DISTSQL) CREATE MATERIALIZED VIEW mv AS SELECT ...;

-- Verbose: includes stream key, state table catalog details
EXPLAIN (DISTSQL, VERBOSE) CREATE MATERIALIZED VIEW mv AS SELECT ...;

-- Optimization trace: shows each optimizer rule applied
EXPLAIN (TRACE) CREATE MATERIALIZED VIEW mv AS SELECT ...;

-- Output formats: TEXT (default), JSON, XML, YAML
EXPLAIN (DISTSQL, FORMAT JSON) CREATE MATERIALIZED VIEW mv AS SELECT ...;

-- Backfill dependency graph (v2.5+)
EXPLAIN (BACKFILL) CREATE MATERIALIZED VIEW mv
WITH (backfill_order = FIXED(dim -> fact)) AS SELECT ...;

-- Runtime analysis of an already-running job
EXPLAIN ANALYZE (duration_secs 30) MATERIALIZED VIEW mv;
```

## How to Read a Streaming Plan

Streaming plans read **bottom-up** — data flows from leaf operators (table scans) upward to the root (`StreamMaterialize`).

### Example plan

```
StreamMaterialize { columns: [user_id, total, name], stream_key: [user_id], pk_columns: [user_id] }
└─StreamHashJoin { type: Inner, predicate: orders.user_id = users.user_id }
  ├─StreamHashAgg { group_key: [user_id], aggs: [sum(amount)] }
  │ └─StreamExchange { dist: HashShard(user_id) }
  │   └─StreamTableScan { table: orders, columns: [user_id, amount] }
  └─StreamExchange { dist: HashShard(user_id) }
    └─StreamTableScan { table: users, columns: [user_id, name] }
```

**Reading order:**
1. Start at the bottom — two `StreamTableScan` operators read from `orders` and `users`
2. `StreamExchange { dist: HashShard(user_id) }` — data is shuffled (redistributed) by `user_id` across parallel workers
3. Left branch: `StreamHashAgg` aggregates by `user_id` before the join
4. `StreamHashJoin` joins the aggregated orders with users
5. `StreamMaterialize` writes the final result to the MV state table with `user_id` as primary key

### Key fields in StreamMaterialize

```
StreamMaterialize { columns: [...], stream_key: [user_id], pk_columns: [user_id], pk_conflict: NoCheck }
```

- **columns** — output columns of the MV (includes hidden columns like `_row_id`)
- **stream_key** — the unique key guaranteeing INSERT/DELETE alternation
- **pk_columns** — primary key of the state table; determines physical sort order in LSM tree
- **pk_conflict** — `NoCheck` (default for MVs), `Overwrite` (for tables with connectors)

## EXPLAIN ANALYZE: Runtime Performance

`EXPLAIN ANALYZE` collects runtime statistics from a **running** streaming job. Unlike `EXPLAIN`, which shows the plan, this shows actual throughput and backpressure.

```sql
-- Analyze for 30 seconds (longer = more stable metrics)
EXPLAIN ANALYZE (duration_secs 30) MATERIALIZED VIEW my_mv;

-- Can also analyze tables, sinks, indexes, or by job ID
EXPLAIN ANALYZE (duration_secs 30) TABLE my_table;
EXPLAIN ANALYZE (duration_secs 30) SINK my_sink;
EXPLAIN ANALYZE (duration_secs 30) ID 12345;
```

### Key metrics

| Metric | Meaning | What to look for |
|--------|---------|-----------------|
| `output_rps` | Records output per second per operator | Low value at a specific operator = bottleneck |
| `avg_output_pending_ratio` | Buffer utilization (0.0 - 1.0) | High value (> 0.8) = downstream can't keep up (backpressure) |
| `actor_ids` | Parallel actor IDs for each operator | Imbalanced actor counts may indicate skew |

### Interpreting the results

- **Bottleneck identification**: Walk the plan top-down. The first operator with a significantly lower `output_rps` than its upstream is the bottleneck.
- **Backpressure detection**: A high `avg_output_pending_ratio` on operator A means operator A's output buffer is full — the operator **downstream** of A is slow.
- **Skew detection**: If some actors have much higher throughput than others for the same operator, the data distribution may be skewed.

## Red Flag Table

Quick reference for spotting problems in EXPLAIN output:

| Red Flag | What It Means | Fix |
|----------|--------------|-----|
| `StreamOverWindow` without rank filter | Full partition state stored | Add `WHERE rank <= N` — see [perf-window-and-aggregation](./perf-window-and-aggregation.md) |
| `StreamHashJoin` for dimension lookup | 4 state tables, expensive | Switch to temporal join — see [perf-join-optimization](./perf-join-optimization.md) |
| `StreamExchange` between every operator | Excessive shuffling | Check if distribution keys align; reduce unnecessary reshuffles |
| `StreamDynamicFilter` without `StreamNow` | Temporal filter may not be cleaning state | Verify temporal filter syntax — see [perf-temporal-filters-and-state](./perf-temporal-filters-and-state.md) |
| `StreamHashAgg` with high-cardinality DISTINCT | Unbounded distinct state | Use `approx_count_distinct` or add temporal filter — see [perf-window-and-aggregation](./perf-window-and-aggregation.md) |
| No `StreamExchange` before `StreamHashJoin` | Join may be running on single parallelism | Check if distribution keys match join keys |
| `StreamTableScan` with many columns | Wide scans increase I/O | Select only needed columns — see [perf-mv-design-patterns](./perf-mv-design-patterns.md) |

## Inspecting Already-Created Jobs

```sql
-- Show MV structure (columns, distribution key, primary key)
DESCRIBE my_mv;

-- Show physical fragments and actor assignments (v2.4.0+)
DESCRIBE FRAGMENTS my_mv;
```

`DESCRIBE FRAGMENTS` shows:
- Fragment IDs and their operator topology
- Actor assignments to worker nodes
- Stream key and distribution info per fragment
- Upstream/downstream fragment dependencies

## Additional Context

- Always run `EXPLAIN CREATE` before deploying a new MV to catch suboptimal plans
- Use `EXPLAIN ANALYZE` when a running job has unexpectedly high latency
- For EXPLAIN output related to specific operators, see dedicated skills:
  - Joins: [perf-join-optimization](./perf-join-optimization.md)
  - Window/aggregation: [perf-window-and-aggregation](./perf-window-and-aggregation.md)
  - Temporal filters: [perf-temporal-filters-and-state](./perf-temporal-filters-and-state.md)
  - MV design (arrangement key, distribution): [perf-mv-design-patterns](./perf-mv-design-patterns.md)
  - Backfill order visualization: [perf-ddl-background-management](./perf-ddl-background-management.md)

## Reference

- [RisingWave EXPLAIN](https://docs.risingwave.com/sql/commands/sql-explain)
- [RisingWave EXPLAIN ANALYZE](https://docs.risingwave.com/sql/commands/sql-explain-analyze)
- [RisingWave DESCRIBE](https://docs.risingwave.com/sql/commands/sql-describe)

---

## Monitoring & Alerts (MEDIUM)

### Navigate Grafana metrics for troubleshooting

**Impact:** MEDIUM - Faster issue identification, better system understanding

**Tags:** monitoring, grafana, metrics, dashboard, alerts

## Problem Statement

RisingWave exposes extensive metrics through Grafana. Knowing which panels to check for different issues accelerates troubleshooting.

## Key Dashboards and Panels

### Streaming Dashboard

**Location**: `risingwave_dashboard` > `Streaming`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| Barrier Latency | > 10s sustained | Streaming backpressure |
| Actor Output Blocking Time Ratio | > 50% | Downstream bottleneck |
| Source Throughput | Drop to 0 | Source connectivity or rate limit |
| Sink Throughput | Flatline | Sink issues |

**Barrier Latency Interpretation**:
- < 1s: Healthy
- 1-10s: Monitor closely
- > 10s: Investigate immediately
- > 60s: Barrier stuck, critical

### Memory Dashboard

**Location**: `risingwave_dashboard` > `Memory Management`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| Memory Usage | Approaching limit | Potential OOM |
| LRU Watermark (now - epoch) | Not decreasing to 0 under pressure | LRU not working |
| Cache Hit Rate | Low values | Performance degradation |

### Compaction Dashboard

**Location**: `risingwave_dashboard` > `Compaction`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| L0 File Count | > 100 and growing | Compaction falling behind |
| Write Stop Compaction Groups | Non-zero | Write stop active |
| Compaction Throughput | Declining | Compactor issues |
| Compaction Task Count | Pending > Completed | Backlog building |

### Hummock (Storage) Dashboard

**Location**: `risingwave_dashboard` > `Hummock`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| Object Store Latency | Spikes | External storage issues |
| Cache Memory | Near limit | May need tuning |
| Read/Write IOPS | Unusual patterns | I/O bottleneck |

## Issue-Specific Panel Checks

### For Barrier Stuck

1. `Streaming` > `Barrier Latency` - Confirm barrier stuck
2. `Streaming` > `Actor Output Blocking Time` - Find backpressure source
3. `Compaction` > `Write Stop Compaction Groups` - Check for write stop
4. `Memory` > `Memory Usage` - Check for memory pressure

### For OOM

1. `Memory` > `Memory Usage` - Confirm memory growth pattern
2. `Memory` > `LRU Watermark` - Check if LRU is working
3. `Streaming` > `Barrier Latency` - Check for barrier issues (causes OOM)
4. Pod metrics - Check Kubernetes-level memory

### For Slow Queries

1. `Batch` > `Query Duration` - Identify slow queries
2. `Hummock` > `Read Latency` - Check storage read performance
3. `Compaction` > `L0 File Count` - High L0 = slow reads
4. `Cache` > `Hit Rate` - Low hit rate = more I/O

### For CDC Issues

1. `Streaming` > `Source Throughput` - Check if source is consuming
2. `Streaming` > `Source Latency` - Lag from upstream
3. `Connector` > `CDC Metrics` (if available)

## Alert Thresholds

Common alert conditions to configure:

| Metric | Warning | Critical |
|--------|---------|----------|
| Barrier Latency | > 30s | > 60s |
| L0 File Count | > 50 | > 100 |
| Memory Usage | > 80% | > 95% |
| Write Stop Groups | > 0 | - |
| Source Throughput | Drop > 50% | Drop to 0 |

## Grafana Tips

### Time Range Selection

- **Recent issues**: Last 15-30 minutes
- **Pattern analysis**: Last 6-24 hours
- **Correlation**: Align time ranges across dashboards

### Annotation Timestamps

Mark specific times across all panels:
1. Click on a panel at the event time
2. Add annotation with description
3. Annotation appears on all panels

### Export Data

For sharing or deeper analysis:
1. Panel menu > Inspect > Data
2. Download CSV or copy to clipboard

## Common Patterns

### Cascading Failure Pattern

1. Source throughput drops
2. Barrier latency increases
3. Memory pressure builds
4. OOM or write stop triggers
5. Recovery, cycle may repeat

**Action**: Address root cause (usually first symptom).

### Compaction Backlog Pattern

1. L0 count gradually increases
2. Read performance degrades
3. Write stop eventually triggers
4. After recovery, same pattern repeats

**Action**: Scale compactors or tune configuration.

## Additional Context

- Metrics have 15-30 second delay in Grafana
- Some metrics are sampled, not continuous
- Combine multiple panels for full picture
- Use Grafana alerts for proactive monitoring

## Reference

- [Monitor a RisingWave Cluster](https://docs.risingwave.com/operate/monitor-risingwave-cluster)
- [Grafana Documentation](https://grafana.com/docs/)

---

