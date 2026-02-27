---
title: "Systematic workflow for analyzing MV performance with EXPLAIN plans"
impact: "HIGH"
impactDescription: "Identify performance bottlenecks before deployment using structured plan analysis"
tags: ["explain", "explain-create", "explain-analyze", "distsql", "streaming-plan", "diagnostics", "performance", "workflow"]
---

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
