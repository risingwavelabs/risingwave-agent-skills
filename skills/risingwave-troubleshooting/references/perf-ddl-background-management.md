---
title: "Manage background DDL and MV creation"
impact: "HIGH"
impactDescription: "Control DDL execution, prevent cluster overload from concurrent backfills"
tags: ["ddl", "materialized-view", "background", "backfill", "creation", "timeout", "cancel", "recover", "running-queries", "flush"]
---

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
