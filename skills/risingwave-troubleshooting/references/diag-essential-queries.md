---
title: "Essential diagnostic SQL queries"
impact: "HIGH"
impactDescription: "Quickly identify issues, reduce investigation time by 80%"
tags: ["diagnostic", "sql", "queries", "troubleshooting", "catalog"]
---

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
