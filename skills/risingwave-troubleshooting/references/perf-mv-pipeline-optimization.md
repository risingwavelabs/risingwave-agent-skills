---
title: "Refactor and optimize existing MV pipelines"
impact: "HIGH"
impactDescription: "Reduce pipeline latency 30-60% by eliminating redundant MVs, unnecessary joins, and wasted state"
tags: ["materialized-view", "pipeline", "refactoring", "optimization", "dependency-graph", "collapse", "correctness", "swap", "zero-downtime"]
---

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
