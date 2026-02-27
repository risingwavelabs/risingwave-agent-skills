---
title: "Design materialized views for efficient streaming and serving"
impact: "HIGH"
impactDescription: "Reduce state storage, improve query latency, and prevent backfill bottlenecks through proper MV design"
tags: ["materialized-view", "design", "index", "distribution", "column-selection", "layering", "backfill"]
---

## Problem Statement

Materialized view design directly impacts state storage size, streaming throughput, batch query latency, and backfill time. Poor column selection, missing indexes, wrong distribution keys, and monolithic MV definitions cause excessive state, slow lookups, and long recovery times. This guide covers MV design patterns for both streaming efficiency and serving performance.

## Column Selection: Avoid SELECT *

Every column in an MV becomes part of the state table stored in Hummock (RisingWave's LSM-tree state store). Unnecessary columns waste storage and increase I/O for every state read/write.

```sql
-- BAD: stores all columns even if only a few are queried
CREATE MATERIALIZED VIEW mv AS
SELECT * FROM orders JOIN customers ON orders.customer_id = customers.id;

-- GOOD: select only the columns needed by downstream consumers
CREATE MATERIALIZED VIEW mv AS
SELECT o.id, o.amount, o.created_at, c.name, c.tier
FROM orders o JOIN customers c ON o.customer_id = c.id;
```

**Note:** Intermediate operator state (join state, aggregation state) only stores columns referenced by the query. The final MV state table stores all output columns. So narrowing the column list reduces the final MV state and any indexes built on it.

## MV Layering: Decompose Complex Pipelines

Decomposing a complex MV with many CTEs/subqueries into multiple independent MVs has two key benefits:

1. **No additional computation cost** — decomposition does not increase computational overhead, only storage (typically negligible with cloud object storage)
2. **Reduced backfill contention** — during initial backfill or recovery, independent MVs can backfill in parallel without competing for the same resources

```sql
-- Instead of one monolithic MV:
CREATE MATERIALIZED VIEW final AS
WITH enriched AS (
  SELECT ... FROM orders JOIN customers ON ...
),
aggregated AS (
  SELECT ... FROM enriched GROUP BY ...
)
SELECT ... FROM aggregated JOIN products ON ...;

-- Decompose into layers:
CREATE MATERIALIZED VIEW enriched_orders AS
SELECT ... FROM orders JOIN customers ON ...;

CREATE MATERIALIZED VIEW order_stats AS
SELECT ... FROM enriched_orders GROUP BY ...;

CREATE MATERIALIZED VIEW final AS
SELECT ... FROM order_stats JOIN products ON ...;
```

**When to decompose:**
- The MV has multiple joins followed by aggregations
- Multiple downstream MVs share the same intermediate computation
- Backfill of the monolithic MV takes too long or causes memory pressure
- You need to inspect intermediate results for debugging

**When NOT to decompose:**
- The query is simple (single scan + filter + project)
- No downstream MVs share intermediate state
- The added storage is a concern (rare with object storage)

## Indexes: When and How

In RisingWave, an index is a specialized MV sorted by the index key columns. Key differences from PostgreSQL:

### Default behavior: all columns included

By default, `CREATE INDEX` includes **all columns** of the source table/MV — not just the indexed columns. This eliminates primary table lookups (which are slow in cloud environments) but increases storage.

```sql
-- Includes ALL columns from orders (wide index)
CREATE INDEX idx_orders_customer ON orders(customer_id);

-- Narrow index: only includes columns needed for the query
CREATE INDEX idx_orders_customer ON orders(customer_id) INCLUDE (id, amount);
```

Use `INCLUDE` to limit which columns are stored in the index when you know the query pattern.

### Distribution key for indexes

The default distribution key is the first index column. Override with `DISTRIBUTED BY` when query patterns provide different filter columns:

```sql
-- Queries filter by region, then customer_id
CREATE INDEX idx ON orders(region, customer_id) DISTRIBUTED BY (region);
```

If a query only provides a prefix of the distribution key, RisingWave cannot target specific vnodes and must scan all of them.

### CREATE INDEX vs separate MV

| Use Case | Recommendation |
|----------|---------------|
| Accelerate point lookups on existing table/MV | `CREATE INDEX` |
| Need different sort order for range scans | `CREATE INDEX` |
| Need complex transforms, aggregations, or joins | Separate MV |
| Need different output columns than the source | Separate MV |

## Distribution and Data Skew

Data is distributed across vnodes via consistent hashing on the distribution key. Skewed distribution causes hot vnodes and uneven parallelism.

### How distribution keys are chosen

| Object | Default Distribution Key |
|--------|------------------------|
| Table (with PK) | Primary key columns |
| Table (without PK) | Hidden `_row_id` column |
| MV with GROUP BY | GROUP BY columns (HashAgg shuffles by group key) |
| MV without GROUP BY | Derived from upstream stream key |
| Index | First index column (override with `DISTRIBUTED BY`) |

### Diagnosing skew

```sql
-- Check vnode distribution for a table (WARNING: full table scan)
SELECT rw_vnode(distribution_key_column) AS vnode, COUNT(*)
FROM my_table
GROUP BY vnode
ORDER BY count DESC
LIMIT 20;
```

If a few vnodes have significantly more rows than others, the distribution key has poor cardinality or skewed values. Consider using a higher-cardinality column or a composite key.

For parallelism tuning guidance, see [perf-streaming-tuning](./perf-streaming-tuning.md).

## Stream Key and Arrangement Key

Understanding these internal concepts helps interpret EXPLAIN output and diagnose state issues.

### Stream key

The unique key derived bottom-up through the operator tree. It guarantees that INSERT and DELETE operations with the same stream key alternate (no duplicate inserts, no phantom deletes). The stream key is:
- **Table scan**: table's primary key
- **Aggregation**: GROUP BY columns
- **Join**: combination of both sides' primary keys
- **Filter/Project**: preserves upstream stream key

### Arrangement key (pk_columns)

The primary key of the final state table. Determines physical sort order in the LSM tree. Visible in EXPLAIN output:

```
StreamMaterialize { columns: [...], stream_key: [order_id], pk_columns: [order_id], pk_conflict: NoCheck }
```

For joins, the state table uses the **join key as prefix** of the arrangement key. For example, joining on `customer_id` produces state table PK `[customer_id, order_id]`, enabling efficient prefix scans during join lookups.

## Verifying MV Design with EXPLAIN

For a comprehensive guide to all EXPLAIN variants, reading streaming plans, and runtime analysis, see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md).

Key MV design elements to verify in EXPLAIN output:
- `StreamMaterialize { pk_columns: [...] }` — the arrangement key (see Stream Key and Arrangement Key above)
- `StreamExchange { dist: HashShard(...) }` — data shuffle boundaries indicating distribution key
- For join operators (`StreamHashJoin` vs `StreamTemporalJoin`), see [perf-join-optimization](./perf-join-optimization.md)
- For `StreamGroupTopN` vs `StreamOverWindow`, see [perf-window-and-aggregation](./perf-window-and-aggregation.md)
- For `StreamDynamicFilter` / `StreamNow` (temporal filters), see [perf-temporal-filters-and-state](./perf-temporal-filters-and-state.md)

## Reference

- [RisingWave Indexes](https://docs.risingwave.com/processing/indexes)
- [RisingWave CREATE MATERIALIZED VIEW](https://docs.risingwave.com/sql/commands/sql-create-mv)
- [RisingWave Performance Best Practices](https://docs.risingwave.com/performance/performance-best-practices)
- [RisingWave DESCRIBE](https://docs.risingwave.com/sql/commands/sql-describe)
