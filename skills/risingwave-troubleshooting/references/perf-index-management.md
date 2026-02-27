---
title: "Manage indexes for query acceleration"
impact: "HIGH"
impactDescription: "Speed up point lookups 10-100x, reduce batch query latency"
tags: ["index", "performance", "query", "lookup", "distribution", "include"]
---

## Problem Statement

RisingWave indexes are specialized materialized views sorted by the index key columns. They accelerate batch (point/range) queries but add streaming state overhead. Understanding when to create indexes, how to inspect them, and when to remove them is key to balancing query performance against resource usage.

## When to Create an Index

Create an index when:
- Batch queries filter on columns that are **not** the MV's primary key
- Point lookups on a table/MV are slow (full scan visible in EXPLAIN)
- Range scans need a different sort order than the MV arrangement key

Do **not** create an index when:
- The query already uses the MV's primary key for lookup
- The table is small enough that full scans are acceptable
- The additional streaming state cost outweighs the query benefit

## Creating Indexes

### Basic index (includes all columns by default)

```sql
-- Includes ALL columns from the source table/MV
CREATE INDEX idx_orders_customer ON orders(customer_id);
```

### Narrow index with INCLUDE

```sql
-- Only stores the indexed column plus explicitly included columns
CREATE INDEX idx_orders_customer ON orders(customer_id) INCLUDE (id, amount, created_at);
```

Use `INCLUDE` to reduce index state size when queries only need specific columns.

### Index with custom distribution

```sql
-- Override the default distribution key (first index column)
CREATE INDEX idx_orders_region ON orders(region, customer_id) DISTRIBUTED BY (region);
```

If queries filter primarily by `region`, distributing by `region` enables vnode-targeted lookups.

## Inspecting Existing Indexes

### List all indexes on a table

```sql
-- View index names, key columns, included columns, and distribution
SELECT * FROM rw_indexes WHERE primary_table_id = (
  SELECT id FROM rw_tables WHERE name = 'my_table'
);

-- Or use SHOW CREATE INDEX for the full DDL
SHOW CREATE INDEX idx_orders_customer;
```

### Check index structure

```sql
-- Describe index columns and types
DESCRIBE idx_orders_customer;
```

### Check index state size

```sql
-- Index state tables appear in rw_table_stats like any MV
SELECT s.id, s.total_key_count,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_table_stats s
JOIN rw_indexes i ON s.id = i.id
ORDER BY size_mb DESC;
```

## Verifying Index Usage

```sql
-- Check if a query uses the index
EXPLAIN SELECT * FROM orders WHERE customer_id = 123;
```

Look for `BatchLookupJoin` or `BatchScan` referencing the index name. If the optimizer chooses a full scan instead, the query pattern may not match the index key.

## Dropping Unused Indexes

Indexes consume streaming resources (actors, state storage, checkpoint I/O) even when no batch queries use them.

```sql
-- Drop an index
DROP INDEX idx_orders_customer;

-- Drop only if it exists (avoids error)
DROP INDEX IF EXISTS idx_orders_customer;

-- Drop with CASCADE if other objects depend on it
DROP INDEX idx_orders_customer CASCADE;
```

### Finding potentially unused indexes

There is no built-in usage tracking for indexes. Review indexes periodically:

```sql
-- List all indexes with their sizes
SELECT i.name AS index_name, t.name AS table_name,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_indexes i
JOIN rw_tables t ON i.primary_table_id = t.id
LEFT JOIN rw_table_stats s ON i.id = s.id
ORDER BY size_mb DESC;
```

Large indexes that are not used by any active query pattern should be dropped to reclaim resources.

## Index vs Materialized View

| Use Case | Recommendation |
|----------|---------------|
| Accelerate point lookups on existing table/MV | `CREATE INDEX` |
| Need different sort order for range scans | `CREATE INDEX` |
| Need complex transforms, aggregations, or joins | Separate MV |
| Need different output columns than the source | Separate MV selecting only needed columns |

For detailed MV design guidance, see [perf-mv-design-patterns](./perf-mv-design-patterns.md).

## Reference

- [RisingWave Indexes](https://docs.risingwave.com/processing/indexes)
- [CREATE INDEX](https://docs.risingwave.com/sql/commands/sql-create-index)
