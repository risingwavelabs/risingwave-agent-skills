---
title: "MV architecture patterns: dedup placement, distribution skew, and backfill strategies"
impact: "CRITICAL"
impactDescription: "Avoid expensive VIEW-based dedup, datetime distribution hot spots, and backfill resource contention"
tags: ["materialized-view", "dedup", "view", "distribution-key", "data-skew", "datetime", "backfill", "scaling", "streaming"]
---

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
