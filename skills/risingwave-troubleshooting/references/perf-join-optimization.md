---
title: "Optimize streaming join performance and avoid common pitfalls"
impact: "CRITICAL"
impactDescription: "Prevent OOMs, barrier stalls, and 10-100x latency spikes from join anti-patterns"
tags: ["join", "streaming", "performance", "temporal-join", "hash-join", "state", "amplification"]
---

## Problem Statement

Joins are the #1 source of latency spikes, OOMs, and barrier stalls in RisingWave streaming pipelines. Understanding join types, their state costs, and common anti-patterns is essential for building stable, performant pipelines.

## Join Types and Their Cost

### Regular (hash) joins — most expensive

Both sides are stateful. RisingWave maintains left/right state tables plus degree tables. Every update on either side probes the other side's state.

```sql
-- Hash join: 4 state tables (left, right, left degree, right degree)
-- Use only when both sides genuinely need to react to each other's changes
SELECT a.*, b.*
FROM stream_a a
JOIN stream_b b ON a.id = b.id;
```

**Parallelism tip:** Start with low parallelism for complex joins and increase only if CPU is underutilized. High parallelism on join-heavy MVs multiplies memory usage proportionally.

### Process-time temporal joins — cheapest for dimension lookups

Use `FOR SYSTEM_TIME AS OF PROCTIME()` to join a stream against a dimension table or MV. The stream side maintains **zero state** in the append-only variant — the dimension table IS the state.

```sql
-- Temporal join: zero state on stream side (append-only variant)
SELECT s.*, d.category_name
FROM stream_table s
LEFT JOIN dimension_table FOR SYSTEM_TIME AS OF PROCTIME() AS d
  ON s.dim_id = d.id;
```

**Requirements:**
- The left (stream) side must be append-only for the stateless variant
- The join condition must include the primary key of the right (dimension) table
- Non-append-only temporal joins are supported but maintain internal state

**Critical behavior:** Temporal joins are **asymmetric** — they use process-time (`PROCTIME()`) semantics, meaning the right side is a point-in-time snapshot lookup, not a reactive join. This has two important consequences:
1. Only changes on the **left (stream) side** trigger a lookup and produce output. Updates to the right (dimension) side alone do NOT produce new output — they just update the reference data for future lookups.
2. Updates to the dimension table do NOT retroactively affect previous join outputs. Once a row is joined, the result is final.

This applies to **both** append-only and non-append-only temporal join variants. The non-append-only variant only adds the ability to retract previously emitted results when the left side sends updates/deletes — it does not make the join reactive to right-side changes.

**Testing pitfall:** INSERT-based testing on the lookup (right) table side will produce 0 rows. This is expected behavior, not a bug. To test a temporal join, drive data from the stream (left) side.

**Optimization:** Create an index on the dimension table and join against the index for faster lookups.

### ASOF joins — for nearest-record matching (v2.1+ streaming, v2.3+ batch)

Avoids the state explosion of traditional range joins when matching by time or ordered properties.

```sql
SELECT *
FROM events e
ASOF LEFT JOIN prices p
  ON e.symbol = p.symbol AND e.event_time >= p.price_time;
```

**Requirements:** At least one equality condition + one inequality condition.

### Window joins and interval joins

Segment data into time windows before joining. Both require watermark-based conditions.

**Caveat:** State cleaning for interval joins is triggered only when upstream messages arrive at the join key granularity. If a particular join key stops receiving messages, its state may be retained indefinitely. Monitor for inactive keys retaining stale state.

## Choosing the Right Join Type

| Scenario | Recommended Join | Why |
|----------|-----------------|-----|
| Stream enrichment from dimension table | Temporal join | Zero state on stream side |
| Both sides are streams that must react to each other | Hash join | Only option for bi-directional reactivity |
| Nearest-match by time/ordered column | ASOF join | Avoids range join state explosion |
| Time-bounded correlation between streams | Interval/window join | Bounded state via watermarks |
| Building wide table from many sources | `SINK INTO TABLE` | Avoids multi-way join state explosion |

**Rule of thumb:** If you're using a hash join for a dimension lookup, switch to a temporal join. Check `EXPLAIN CREATE` for `StreamHashJoin` where `StreamTemporalJoin` would suffice.

## Anti-Pattern: Join amplification on low-cardinality columns

Joining on columns with few distinct values causes exponential row output.

```sql
-- BAD: low-cardinality join key causes amplification
SELECT * FROM orders o
JOIN products p ON o.category = p.category;  -- 'category' has few distinct values

-- GOOD: join on high-cardinality key
SELECT * FROM orders o
JOIN products p ON o.product_id = p.id;
```

**Diagnosis:** Check Grafana's **Streaming > Join Executor Matched Rows** panel. High matched rows indicate amplification. Also check join state table sizes:

```sql
-- Check for unexpectedly large state tables indicating join amplification
SELECT id, total_key_count,
       round((total_key_size + total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats
ORDER BY size_mb DESC
LIMIT 20;
```

## Anti-Pattern: FULL OUTER JOIN NULL amplification

With FULL OUTER JOINs on shared primary keys, intermediate NULL results multiply exponentially with the number of joins. This is distinct from low-cardinality amplification — even unique keys cause it when multiple tables are chained with outer joins.

## Anti-Pattern: Cross joins / joins without equality predicates

RisingWave disables these by default. Every new row on one side scans all rows on the other, stalling the barrier mechanism cluster-wide. If unavoidable, add a dummy equality column.

## Anti-Pattern: Dummy-column joins causing periodic batch spikes

```sql
-- BAD: dummy column join causes full table rescan on time boundaries
SELECT *
FROM fact_table f
LEFT JOIN current_day_snapshot s ON f.dummy_column = s.dummy_column;

-- GOOD: use event time or processing time for continuous processing
SELECT *
FROM fact_table f
LEFT JOIN dimension_table FOR SYSTEM_TIME AS OF PROCTIME() AS d
  ON f.dim_id = d.id;
```

Patterns like `JOIN ON dummy = dummy` cause a full update of the left table at time boundaries (e.g., start of each new day), producing barrier latency spikes and OOMs. **What to do instead:** Process data continuously using event time or processing time rather than attaching a timestamp via a dummy join.

## Best Practice: Filter before join, not after

RisingWave's optimizer may or may not push filters down. The `streaming_force_filter_inside_join` cluster setting forces filter pushdown inside the join operator in streaming mode. Always check `EXPLAIN CREATE` to verify predicates land where you expect.

```sql
-- BAD: filter after join — optimizer may not push it down
SELECT * FROM orders o
JOIN products p ON o.product_id = p.id
WHERE o.status = 'active';

-- GOOD: pre-filter in subquery to guarantee pushdown
SELECT * FROM (
  SELECT * FROM orders WHERE status = 'active'
) o
JOIN products p ON o.product_id = p.id;
```

Also ensure join inputs are **deduplicated** before joining. Large join state from un-deduped tables is a common production issue. Materialize the dedup step in an intermediate MV rather than a VIEW.

## Best Practice: Use INNER JOIN instead of LEFT JOIN when possible

`LEFT JOIN` preserves all rows from the left side even without matches, requiring more state. If your query logic doesn't need unmatched rows, use `INNER JOIN` for reduced state and better performance.

## Best Practice: Separate stable vs. unstable columns

Only include rarely-changing columns in large joined MVs. Every update to any joined column triggers a full downstream update. Defer frequently-updating columns (e.g., `current_balance`, `last_updated_at`) to a smaller downstream MV.

## Best Practice: Only select needed columns

Avoid `SELECT *` in joins. Pulling all columns when you only need a few causes unnecessary updates to propagate downstream. Use appropriate data types — smaller types mean faster comparisons and less memory.

```sql
-- BAD: selecting all columns through a join
SELECT * FROM orders o JOIN products p ON o.product_id = p.id;

-- GOOD: select only what's needed
SELECT o.order_id, o.quantity, p.name, p.price
FROM orders o JOIN products p ON o.product_id = p.id;
```

## Best Practice: Wide table with table sinks instead of multi-way LEFT JOIN

For building denormalized tables with many source columns, use `SINK INTO TABLE` to merge updates from multiple streams into a single wide table. This avoids the state explosion of a single MV with many joins.

## Best Practice: Declare append-only tables

Use `CREATE TABLE ... APPEND ONLY` for data that is never updated or deleted. This enables:
- **Temporal joins:** Stream side maintains zero state (most impactful benefit)
- **Over-window functions:** Simplified state management
- **Aggregations:** RW only needs a single data point for functions like `max(timestamp)` instead of maintaining full state for potential retractions

## Advanced: Consecutive joins optimization

RisingWave has a `streaming_separate_consecutive_join` cluster setting that inserts no-shuffle exchanges between consecutive `StreamHashJoin` operators, which can improve parallelism. When possible, restructure queries to reduce join chains instead.

## Advanced: Unaligned joins for high-amplification scenarios (v2.5+)

The `streaming_enable_unaligned_join` cluster setting buffers join output and allows checkpoint barriers to pass through immediately. This improves stability at the cost of increased latency. Useful when join amplification causes barrier stalls.

## Additional Context

- Always verify join behavior with `EXPLAIN CREATE` before deploying — look for `StreamHashJoin` vs `StreamTemporalJoin`
- For multi-way joins, use `backfill_order = FIXED(dim -> fact)` to backfill dimension tables before fact tables — see [perf-ddl-background-management](./perf-ddl-background-management.md) for syntax and details
- If barrier stuck is caused by joins, see [perf-barrier-stuck](./perf-barrier-stuck.md) for emergency actions
- If join amplification causes OOM, see [perf-compute-node-oom](./perf-compute-node-oom.md) for diagnosis
- Create indexes on dimension tables used in temporal joins for faster lookups

## Reference

- [RisingWave Joins Documentation](https://docs.risingwave.com/processing/sql/joins)
- [Maintain Wide Table with Table Sinks](https://docs.risingwave.com/processing/maintain-wide-table-with-table-sinks)
- [Understanding Streaming Joins in RisingWave](https://risingwave.com/blog/understanding-streaming-joins-in-risingwave/)
