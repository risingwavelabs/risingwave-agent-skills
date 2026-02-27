---
title: "Optimize window functions and aggregations for streaming"
impact: "HIGH"
impactDescription: "Reduce state size by 10-100x with TopN pattern, avoid OOM from unbounded aggregation state"
tags: ["window", "aggregation", "topn", "row_number", "count-distinct", "union", "streaming", "state"]
---

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
