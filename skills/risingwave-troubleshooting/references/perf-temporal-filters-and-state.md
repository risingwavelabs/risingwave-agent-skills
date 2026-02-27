---
title: "Use temporal filters and watermarks correctly for state management"
impact: "CRITICAL"
impactDescription: "Prevent unbounded state growth, avoid OOMs and periodic latency spikes"
tags: ["temporal-filter", "now", "watermark", "state", "ttl", "proctime", "streaming"]
---

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
