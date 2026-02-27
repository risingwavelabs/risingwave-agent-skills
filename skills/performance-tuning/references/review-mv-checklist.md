---
title: "Comprehensive MV performance review checklist"
impact: "HIGH"
impactDescription: "Catch performance issues systematically before deployment using a structured review"
tags: ["review", "checklist", "materialized-view", "performance", "code-review", "streaming"]
---

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
