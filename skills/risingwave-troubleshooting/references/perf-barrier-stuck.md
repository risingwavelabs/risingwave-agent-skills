---
title: "Diagnose and resolve barrier stuck issues"
impact: "CRITICAL"
impactDescription: "Restore streaming pipeline within minutes, prevent data lag accumulation"
tags: ["barrier", "streaming", "stuck", "backpressure", "performance"]
---

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
