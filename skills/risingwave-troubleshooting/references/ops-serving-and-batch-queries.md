---
title: "Manage serving nodes and prevent batch query overload"
impact: "CRITICAL"
impactDescription: "Prevent production outages from runaway batch queries saturating serving nodes"
tags: ["serving", "batch", "query", "processlist", "kill", "query-mode", "distributed-query-limit", "statement-timeout", "index"]
---

## Problem Statement

Serving (batch query) overload is the most common cause of user-facing production outages in RisingWave deployments with dedicated serving nodes. The core issue: **uncontrolled batch queries — especially ad-hoc analytical queries, parallel application queries, and full table scans — can saturate serving node CPU and memory, making all user-facing queries fail.** Unlike streaming issues which cause data lag, serving overload causes immediate query failures visible to end users.

## Architecture: Serving vs Streaming Nodes

RisingWave supports three compute node roles:

| Role | Function | Workload |
|------|----------|----------|
| `serving` | Read-only, executes batch queries | Point lookups, analytical queries |
| `streaming` | Processes streaming pipeline | MV maintenance, source ingestion |
| `hybrid` (default) | Both streaming and serving | Combined workload |

**Key insight:** Serving nodes share no resources with streaming nodes. Serving issues do not affect streaming pipeline health (barrier latency, MV updates), and vice versa. However, serving node OOM or CPU saturation makes **all** batch queries fail — including production-critical ones.

## Critical Rule: Disconnecting Does NOT Cancel Queries

**This is the single most common operational mistake.** When a client disconnects (closes psql, closes a Superset tab, terminates an application), the running query on the serving node **continues executing**. Resources are consumed until the query completes or times out.

```sql
-- Step 1: Find running queries
SHOW PROCESSLIST;
-- Output columns: worker_id, id, user, host, database, time, info
-- 'time' shows how long the query has been running
-- 'info' shows the SQL statement (may be truncated)

-- Step 2: Kill specific slow queries
KILL '<process_id>';    -- e.g., KILL '2:0';

-- Tip: If SHOW PROCESSLIST output is too large to read interactively,
-- dump to a file from the command line:
-- psql -h <host> -p <port> -d <db> -U <user> -t -c "SHOW PROCESSLIST" > processes.txt
```

**Limitations of SHOW PROCESSLIST:**
- Only shows queries on the frontend node you're connected to
- SQL statements may be truncated — check application/CloudWatch logs for full SQL
- The output can be many pages long on busy systems

## Anti-Pattern: Parallel Query Floods

Applications that send hundreds or thousands of queries in parallel (e.g., one query per entity ID) can instantly saturate serving nodes.

```sql
-- BAD: Application sends 1,000 queries in parallel (one per entity_id)
-- Each query runs in distributed mode, consuming serving node resources
-- 1,000 concurrent distributed queries overwhelm the serving cluster
SELECT * FROM analytics_table WHERE entity_id = ?;  -- × 1,000 in parallel

-- BETTER: Sequential execution with local query mode
SET query_mode = 'local';  -- Runs on frontend only, no serving node resources
SELECT * FROM analytics_table WHERE entity_id = ?;  -- One at a time
```

**Guidelines for application query patterns:**
- **Rate-limit concurrent queries** from batch/ETL applications
- Switch from parallel to sequential execution for bulk lookups
- Use `query_mode = 'local'` for simple point lookups that can run on the frontend alone
- Consider batching multiple entity lookups into a single `WHERE entity_id IN (...)` query

## Anti-Pattern: Full Table Scans on Large Tables

Queries without proper WHERE clauses or missing indexes cause full scans on multi-TB tables, consuming all serving CPU and memory.

```sql
-- BAD: Full table scan on a large table — saturates serving nodes
SELECT * FROM event_log WHERE doc_id IN ('a', 'b', 'c');
-- If doc_id is not indexed and event_log has billions of rows,
-- this scans the entire table

-- GOOD: Create an index on the lookup column
CREATE INDEX idx_event_log_doc_id ON event_log (doc_id);
-- Now the same query uses an index lookup instead of a full scan
```

**How to detect full scans:**
```sql
-- Use EXPLAIN to check the query plan before running
EXPLAIN SELECT * FROM event_log WHERE doc_id IN ('a', 'b', 'c');
-- Look for "StreamTableScan" or "BatchSeqScan" — indicates a full scan
-- Look for "BatchLookupJoin" or index usage — indicates efficient access
```

## Query Mode: Local vs Distributed

RisingWave supports three query execution modes:

| Mode | Where it Runs | Use When |
|------|--------------|----------|
| `auto` (default) | RisingWave decides | General use |
| `local` | Frontend node only | Simple point lookups, low-cost queries |
| `distributed` | Across serving nodes | Complex analytical queries, joins, aggregations |

```sql
-- Set for current session
SET query_mode = 'local';

-- Check current mode
SHOW query_mode;
```

**`local` mode** avoids serving node load entirely — the frontend executes the query using its own block cache and meta cache. This is ideal for simple point lookups on indexed MVs. However, complex queries (joins, aggregations, large scans) may be slower or fail in local mode.

**`distributed` mode** spreads work across serving nodes for better parallelism, but each query consumes serving node resources and counts toward the distributed query limit.

## Safeguard: Distributed Query Limits

RisingWave provides two config-level limits to prevent serving node overload:

```toml
# In frontend node config (risingwave.toml)
[batch]
# Max concurrent distributed queries per frontend node
# When exceeded, new distributed queries are rejected with QueryReachLimit error
distributed_query_limit = 20

# Max batch queries (local + distributed) per frontend node
max_batch_queries_per_frontend_node = 50
```

When the limit is hit, new queries receive a `QueryReachLimit` error. **Do not blindly increase the limit** — this just delays the crash. Instead, identify and fix the queries consuming resources.

## Safeguard: Statement Timeout

Set a timeout to automatically kill long-running queries:

```sql
-- Session-level: kill queries after 5 minutes
SET statement_timeout = '300s';

-- Config-level default (risingwave.toml): default is 3600s (1 hour)
-- [batch]
-- statement_timeout_in_sec = 300
```

**Recommendation:** Set a cluster-wide default of 5–10 minutes for environments where ad-hoc queries are common. Applications that need longer-running queries can override per-session.

## Best Practice: Index Design for Serving Performance

Indexes are the primary tool for avoiding full table scans. Unlike PostgreSQL, **RisingWave indexes include all columns by default**, so every index is essentially a covering index.

```sql
-- Create an index on the most common lookup column
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- For multi-column lookups, include all filter columns
CREATE INDEX idx_orders_status_date ON orders (status, created_date);

-- Use DISTRIBUTED BY for skewed data
CREATE INDEX idx_orders_customer ON orders (customer_id)
  DISTRIBUTED BY (customer_id);
```

**When to create an index:**
- Any MV queried by end users with a WHERE clause on a non-primary-key column
- Tables used in temporal joins (index on the dimension table's join column)
- Any table where EXPLAIN shows full scans for common query patterns

## Best Practice: Serving Node Memory Configuration

Serving nodes need different memory allocation than streaming/hybrid nodes:

| Component | Streaming Node | Serving Node |
|-----------|---------------|-------------|
| Shared buffer | 30% of memory | Minimal (~1MB) |
| Block cache | 10–20% | 30% of memory |
| Meta cache | 5–10% | 10% of memory |
| Operator cache | 20–30% | Not needed |
| Query execution | Remainder | Remainder (~60%) |

Serving nodes don't need shared buffer or operator cache. Allocate that memory to block cache (for caching data blocks from object storage) and query execution memory.

## Diagnosis: Serving Node Overload

```sql
-- Step 1: Check for running queries
SHOW PROCESSLIST;
-- Sort mentally by 'time' column — longest-running queries are usually the problem

-- Step 2: Kill queries running longer than a threshold (e.g., 30 minutes)
-- Manually identify and KILL each one
KILL '<process_id>';

-- Step 3: Check query plans for problematic queries
EXPLAIN <the slow query>;
-- Look for: full table scans, missing indexes, cross joins

-- Step 4: Check if indexes exist for common access patterns
-- (RisingWave does not have a built-in index advisor —
-- review EXPLAIN output for common queries)
```

## Emergency: All Serving Queries Failing

1. **Find and kill runaway queries**: `SHOW PROCESSLIST;` then `KILL` all queries with long execution times
2. **If too many to kill manually**: Restart the serving nodes (batch queries are stateless, restart is safe)
   ```
   kubectl delete pod <serving-pod-name>
   ```
   Note: Restarting serving nodes makes batch queries temporarily unavailable (~1 minute)
3. **Set a statement timeout** to prevent recurrence: `SET statement_timeout = '300s';` or configure in `risingwave.toml`
4. **Lower the distributed query limit** if parallel query floods are the cause
5. **Identify the source application** sending problematic queries and coordinate with the application team

## Additional Context

- Serving node issues do **not** affect streaming pipeline health — barrier latency, MV updates, and source ingestion continue normally
- MV backfill/creation may cause I/O contention on serving nodes in hybrid deployments — use dedicated serving nodes to avoid this
- No built-in isolation between "online" (production-facing) and "offline" (ad-hoc) batch queries — all share the same serving nodes. Application-level query routing is the only current solution
- Scaling serving nodes horizontally increases total query capacity but does not solve individual runaway query problems
- Batch queries can spill to disk under memory pressure, which prevents OOM but degrades performance

## Reference

- [RisingWave SHOW PROCESSLIST](https://docs.risingwave.com/sql/commands/sql-show-processlist)
- [RisingWave Dedicated Compute Nodes](https://docs.risingwave.com/operate/dedicated-compute-node)
- [RisingWave Performance FAQ](https://docs.risingwave.com/performance/faq)
