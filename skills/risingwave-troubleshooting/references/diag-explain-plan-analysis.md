---
title: "Read and interpret EXPLAIN output for streaming jobs"
impact: "HIGH"
impactDescription: "Identify bottleneck operators, detect suboptimal plans, and diagnose runtime performance issues"
tags: ["explain", "explain-analyze", "streaming-plan", "diagnosis", "operator", "performance"]
---

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
