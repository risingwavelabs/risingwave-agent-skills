---
title: "Streaming performance tuning and optimization"
impact: "HIGH"
impactDescription: "Improve throughput by 2-10x, reduce resource consumption"
tags: ["streaming", "performance", "tuning", "parallelism", "rate-limit"]
---

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
