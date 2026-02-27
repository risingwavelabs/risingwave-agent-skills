---
title: "Window function, aggregation, and UNION edge cases for streaming SQL"
impact: "CRITICAL"
impactDescription: "Avoid incorrect results from window functions, OOMs from aggregation patterns, and JSONB dedup explosions"
tags: ["window-function", "row-number", "dense-rank", "group-topn", "lead-lag", "aggregation", "distinct", "union", "jsonb", "streaming"]
---

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
