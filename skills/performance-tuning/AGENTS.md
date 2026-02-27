# Agent References

> This file is auto-generated. Do not edit directly. Run `npm run build` to regenerate.

## Performance Patterns (CRITICAL)

### MV architecture patterns: dedup placement, distribution skew, and backfill strategies

**Impact:** CRITICAL - Avoid expensive VIEW-based dedup, datetime distribution hot spots, and backfill resource contention

**Tags:** materialized-view, dedup, view, distribution-key, data-skew, datetime, backfill, scaling, streaming

## Problem Statement

Several MV architecture anti-patterns cause production issues that are not covered in general MV design guidance: dedup logic in VIEWs instead of MVs, datetime-based distribution skew, and monolithic CTE backfill contention. These supplement the `risingwave-troubleshooting` skill.

## Anti-Pattern: Dedup Logic in VIEWs

Defining dedup + join in a `VIEW` that gets materialized downstream leads to very expensive MVs because the optimizer cannot share state across the VIEW boundary. Materialize the dedup step explicitly:

```sql
-- BAD: dedup in a VIEW consumed by an MV
CREATE VIEW deduped AS
SELECT DISTINCT ON (id) * FROM raw_data ORDER BY id, updated_at DESC;

CREATE MATERIALIZED VIEW enriched AS
SELECT d.*, dim.name FROM deduped d JOIN dim ON d.dim_id = dim.id;

-- GOOD: dedup in its own MV
CREATE MATERIALIZED VIEW deduped AS
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC) AS rn
  FROM raw_data
) WHERE rn = 1;

CREATE MATERIALIZED VIEW enriched AS
SELECT d.*, dim.name FROM deduped d JOIN dim ON d.dim_id = dim.id;
```

## Datetime Distribution Skew

Even with correct distribution keys, datetime columns (like `window_start`) in GROUP BY keys route all current-window traffic to a single compute node. This causes hot partitions while other nodes sit idle.

**Diagnosis:** Monitor per-node CPU and memory usage. If one node is consistently saturated while others are underutilized, check whether GROUP BY keys include a low-cardinality time column.

**Mitigation:** Add a higher-cardinality column to the GROUP BY key to spread load, or restructure the query to avoid datetime-only grouping.

## Backfill Cache Locality

When building MV-on-MV pipelines, align the upstream table's **order key** with the downstream MV's **group key** to improve cache locality and avoid triggering remote I/O operations during backfill.

## Decompose Complex MVs for Backfill

Break MVs with many CTEs or subqueries into sequential independent MV creations. Running a single query with many CTEs during backfill is equivalent to running that many queries simultaneously, causing memory pressure, CPU cache thrashing, and I/O contention.

```sql
-- BAD: monolithic MV with many CTEs backfills everything at once
CREATE MATERIALIZED VIEW final AS
WITH cte1 AS (...), cte2 AS (...), ... cte10 AS (...)
SELECT * FROM cte10;

-- GOOD: decompose into sequential MV creations
CREATE MATERIALIZED VIEW step1 AS SELECT ... FROM source1;
CREATE MATERIALIZED VIEW step2 AS SELECT ... FROM source2;
CREATE MATERIALIZED VIEW final AS SELECT ... FROM step1 JOIN step2 ON ...;
```

## Scaling Strategy

The official RisingWave recommendation: prefer **scaling UP** (adding resources to existing nodes) over **scaling OUT** (adding more nodes), to minimize network overhead and resource fragmentation across the distributed system.

## Reference

- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/performance-best-practices)
- [RisingWave Indexes and Distribution Keys](https://docs.risingwave.com/processing/indexes#how-to-decide-the-index-distribution-key)

---

### Window function, aggregation, and UNION edge cases for streaming SQL

**Impact:** CRITICAL - Avoid incorrect results from window functions, OOMs from aggregation patterns, and JSONB dedup explosions

**Tags:** window-function, row-number, dense-rank, group-topn, lead-lag, aggregation, distinct, union, jsonb, streaming

## Problem Statement

Several window function, aggregation, and UNION patterns have non-obvious edge cases in RisingWave that cause incorrect results, OOMs, or excessive state. These supplement the general guidance in the `risingwave-troubleshooting` skill.

## Window Function Edge Cases

### DENSE_RANK() does not trigger GroupTopN optimization

| Function | GroupTopN? | Notes |
|----------|------------|-------|
| `ROW_NUMBER()` | Yes | Standard top-N |
| `RANK()` | Yes | Uses `with_ties: true` |
| `DENSE_RANK()` | **No** | Falls back to `StreamOverWindow` with a warning |

Always use `ROW_NUMBER()` for top-N queries unless you specifically need rank semantics.

### LEAD/LAG combined with ROW_NUMBER() — correctness risk

Combining `ROW_NUMBER()` filtering with `LEAD()` or `LAG()` in the same query can produce **incorrect results**. The GroupTopN optimization prunes rows before lead/lag can evaluate them, so lead/lag see a truncated window. See [risingwave#13905](https://github.com/risingwavelabs/risingwave/issues/13905).

**Workaround:** Compute lead/lag in a separate upstream MV before applying the top-N filter.

### Window functions without PARTITION BY

RisingWave blocks general window function calls without `PARTITION BY` because all data routes to a single operator instance. Workaround: use `PARTITION BY CAST(1 AS INT)` for global top-N, but note this doesn't get 2-phase optimization. See [risingwave#22290](https://github.com/risingwavelabs/risingwave/issues/22290).

## Aggregation Edge Cases

### Split distinct aggregation optimization is pending

RisingWave does not yet split distinct aggregations across nodes. Until this lands, isolate `COUNT(DISTINCT ...)` into separate MVs so they get dedicated resources rather than competing with other aggregations.

### Two-tier aggregation for long windows

Split long-window aggregations (e.g., 90 days) into daily aggregations + a rolling aggregation over the dailies. Older tiles stay cached and avoid S3 re-fetches.

```sql
-- Tier 1: Daily aggregation MV
CREATE MATERIALIZED VIEW daily_agg AS
SELECT entity_id, DATE_TRUNC('day', event_time) AS day, SUM(amount) AS daily_total
FROM events
WHERE event_time > NOW() - INTERVAL '90 DAY'
GROUP BY entity_id, DATE_TRUNC('day', event_time);

-- Tier 2: Rolling window over daily tiles
CREATE MATERIALIZED VIEW rolling_90d AS
SELECT entity_id, SUM(daily_total) AS total_90d
FROM daily_agg
WHERE day >= NOW() - INTERVAL '90 DAY'
GROUP BY entity_id;
```

## UNION with JSONB — Dedup Explosion

`UNION` (not `UNION ALL`) on tables with JSONB columns creates extremely long stream keys because RisingWave must deduplicate across all columns including JSONB. This causes excessive state and poor performance. See [risingwave#14314](https://github.com/risingwavelabs/risingwave/issues/14314).

Always use `UNION ALL` unless you explicitly need deduplication, and especially avoid `UNION` when JSONB columns are involved.

## Reference

- [risingwave#13905 — LEAD/LAG + ROW_NUMBER correctness](https://github.com/risingwavelabs/risingwave/issues/13905)
- [risingwave#22290 — Window functions without PARTITION BY](https://github.com/risingwavelabs/risingwave/issues/22290)
- [risingwave#14314 — UNION with JSONB dedup explosion](https://github.com/risingwavelabs/risingwave/issues/14314)

---

## Diagnostics (HIGH)

### Systematic workflow for analyzing MV performance with EXPLAIN plans

**Impact:** HIGH - Identify performance bottlenecks before deployment using structured plan analysis

**Tags:** explain, explain-create, explain-analyze, distsql, streaming-plan, diagnostics, performance, workflow

## Problem Statement

Without a systematic approach to analyzing EXPLAIN plans, performance issues go undetected until they cause production incidents. This workflow provides a structured approach to catch problems before deployment, supplementing the EXPLAIN syntax reference in the `risingwave-troubleshooting` skill.

## Workflow: Analyzing MV Performance

### Step 1: Get the SQL

Obtain the SELECT statement for the MV you want to analyze.

### Step 2: Run EXPLAIN CREATE

Use `EXPLAIN (DISTSQL) CREATE MATERIALIZED VIEW temp AS (...)` — the DISTSQL variant is most useful for performance debugging as it shows fragment layout and distribution keys.

### Step 3: Scan the plan for red flags

| Red Flag in Plan | Problem |
|------------------|---------|
| `StreamHashJoin` on low-cardinality keys | Join amplification |
| `StreamFilter` appears *after* `StreamHashJoin` | Filter not pushed down |
| `StreamHashJoin` where temporal join would suffice | Unnecessary stateful join |
| `StreamOverWindow` for a top-1 query | Should be `StreamGroupTopN` |
| `StreamExchange` between fragments | Distribution key mismatch causing shuffle |
| `StreamNow` present | Uses `NOW()` — verify it's not in SELECT |
| Many columns in `StreamMaterialize` | Unused columns propagating updates |
| Multiple `StreamHashJoin` in sequence | Consecutive joins — expensive |
| `StreamDynamicFilter` without state cleanup | Temporal filter may not clean state |

### Step 4: Profile a running MV

```sql
EXPLAIN ANALYZE (duration_secs 10) MATERIALIZED VIEW my_mv;
```

**High `downstream_backpressure_ratio`** on operator X means X's downstream consumer is the bottleneck — look *below* X in the tree. Run before and after a query change, diff the output, and compare metrics to see if the change helped.

### Step 5: Check table stats and dependencies

```sql
SELECT * FROM rw_catalog.rw_table_stats ORDER BY total_key_count DESC LIMIT 20;
SELECT * FROM rw_catalog.rw_depend;
```

### Step 6: Produce recommendations

Cross-reference the plan analysis with the red flags table. For each finding, suggest a concrete fix.

## Key Operators Quick Reference

| Operator | Meaning | Watch For |
|----------|---------|-----------|
| `StreamMaterialize` | Final output; shows columns and PK | Check `pk_columns` and `distribution key` |
| `StreamHashJoin` | Stateful join (4 state tables) | Most expensive operator; check join keys |
| `StreamTemporalJoin` | Process-time join against dimension | **Good** — much cheaper than hash join |
| `StreamHashAgg` | Stateful aggregation | Check group keys, look for distinct aggs |
| `StreamGroupTopN` | Efficient top-N within groups | **Good** — what you want for top-1 |
| `StreamOverWindow` | Full window function | **Bad for top-1** — GroupTopN wasn't triggered |
| `StreamFilter` | Stateless filtering | Should appear *before* joins |
| `StreamExchange` | Data redistribution between fragments | **Network shuffle** — check distribution keys |
| `StreamDynamicFilter` | Dynamic filter from `NOW()` | Check state cleanup |
| `StreamNow` | Emits `NOW()` ticks at barrier interval | Check it's not driving SELECT |
| `StreamTableScan` | Reads from upstream table/MV | Starting point of data flow |

**Tip:** Different filter positions might produce the same streaming plan after optimization. Always compare `EXPLAIN CREATE` output before and after a change to verify it actually affects the plan.

## Reference

- [RisingWave EXPLAIN](https://docs.risingwave.com/sql/commands/sql-explain)
- [RisingWave EXPLAIN ANALYZE](https://docs.risingwave.com/sql/commands/sql-explain-analyze)
- [RisingWave Troubleshoot High Latency](https://docs.risingwave.com/performance/troubleshoot-high-latency)

---

## Review (HIGH)

### Comprehensive MV performance review checklist

**Impact:** HIGH - Catch performance issues systematically before deployment using a structured review

**Tags:** review, checklist, materialized-view, performance, code-review, streaming

## Problem Statement

Without a systematic review process, performance issues in materialized views go undetected until production. This checklist ensures every MV is reviewed against known best practices before deployment.

## Review Checklist

### Joins
- [ ] Are joins necessary? Can any be replaced with temporal joins for dimension lookups?
- [ ] Are join inputs pre-filtered and deduplicated?
- [ ] Are only needed columns selected from each source?
- [ ] Are stable and unstable columns separated?
- [ ] For multi-way joins: is `backfill_order` set to backfill dimensions before facts?

### Temporal Filters and State
- [ ] Do temporal filters use continuous ranges (not `DATE_TRUNC`)?
- [ ] Are temporal filters wrapped in FROM subqueries to guarantee pushdown?
- [ ] Is `NOW()` absent from `SELECT`, `GROUP BY`, and `AGGREGATE FILTER` clauses?
- [ ] Does every long-running MV have a state cleanup strategy (temporal filter or TTL)?

### Query Design
- [ ] Do top-N queries use `WHERE rn = N` in the same MV (not deferred to downstream)?
- [ ] Is `ROW_NUMBER()` used (not `DENSE_RANK()`) for top-N optimization?
- [ ] Are distinct aggregations isolated into their own MVs?
- [ ] Is `UNION ALL` used instead of `UNION`?

### Architecture
- [ ] Is the query broken into layered MVs rather than one monolith?
- [ ] Do distribution keys (group-by keys, join keys) align across MV layers?
- [ ] Are append-only sources declared as such?

### Plan Verification
- [ ] Does `EXPLAIN CREATE` show the expected operators?
- [ ] Are there no `StreamHashJoin` where `StreamTemporalJoin` would suffice?
- [ ] Are there no `StreamOverWindow` where `StreamGroupTopN` is expected?
- [ ] Are there no unexpected `StreamExchange` (network shuffles)?

## Most Common Production Problems

Ranked by frequency from real-world deployments:

1. **Dummy-column joins** causing periodic OOMs at time boundaries
2. **Unused/frequently-changing columns** propagating unnecessary updates through the MV graph
3. **OverWindow instead of GroupTopN** for top-1 queries (often caused by ORM/SQL generation tools)
4. **Large join state** from un-deduped tables joined downstream
5. **`DATE_TRUNC` in temporal filters** creating batch spikes — the `DynamicFilterExecutor` can't keep up with `NowExecutor` ticks, causing barrier pile-up. See [risingwave#13807](https://github.com/risingwavelabs/risingwave/issues/13807)
6. **Mismatched distribution keys** across MV layers causing network shuffles
7. **Unbounded state** from missing temporal filters or watermark TTL

## Known Bugs

- **`streaming_separate_consecutive_join`** has a known optimizer panic in v2.6.2 — test carefully before enabling. See [risingwave#23807](https://github.com/risingwavelabs/risingwave/issues/23807)
- **FULL OUTER JOIN NULL amplification** with chained joins — even unique keys cause exponential intermediate NULLs. See [risingwave#17450](https://github.com/risingwavelabs/risingwave/issues/17450)

## Reference

- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/performance-best-practices)
- [RisingWave Streaming Optimizations](https://docs.risingwave.com/performance/streaming-optimizations)

---

