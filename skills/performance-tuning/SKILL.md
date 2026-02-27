---
name: performance-tuning
license: MIT
metadata:
  version: 1.0.0
  author: RisingWave Labs
description: |
  RisingWave streaming SQL performance best practices for writing and reviewing materialized views.

  Supplements the risingwave-troubleshooting skill with edge cases, anti-patterns, and workflows
  not covered there. This skill helps agents with:
  - Window function, aggregation, and UNION edge cases (DENSE_RANK, LEAD/LAG, JSONB dedup)
  - MV architecture anti-patterns (dedup in VIEWs, datetime distribution skew, CTE backfill contention)
  - Systematic EXPLAIN plan analysis workflow with red flags table and operator reference
  - Pre-deployment MV performance review checklist with ranked production problems
---

# Performance Tuning

## Overview

This skill captures production-tested edge cases and anti-patterns for writing performant streaming SQL on RisingWave. It supplements the `risingwave-troubleshooting` skill with unique findings not covered there — window function pitfalls, architecture anti-patterns, a systematic EXPLAIN analysis workflow, and a pre-deployment review checklist.

## When to Use

Apply this skill when:
- Writing or reviewing materialized views for RisingWave
- Choosing join types, temporal filters, or aggregation strategies
- Designing MV layering and data distribution
- Analyzing EXPLAIN plans for performance red flags
- Optimizing backfill for new MV creation

## Categories

| Category | Priority | Prefix | Description |
|----------|----------|--------|-------------|
| Performance Patterns | CRITICAL | `perf-` | Query design edge cases, MV architecture anti-patterns |
| Diagnostics | HIGH | `diag-` | EXPLAIN workflow, red flags, operator reference |
| Review | HIGH | `review-` | MV performance review checklist |

## Key Principles

1. **Joins are the #1 performance risk**: Choose the cheapest join type that satisfies your requirements
2. **Bound your state**: Every long-running MV needs a state cleanup strategy (temporal filter or TTL)
3. **Align distribution keys**: Mismatched keys across MV layers cause network shuffles
4. **Always check EXPLAIN CREATE**: Verify the streaming plan matches your intent before deploying
5. **Decompose, don't monolith**: Layered MVs are cheaper and easier to debug than one complex query

## Usage

The skill activates automatically when writing or reviewing RisingWave SQL. Use alongside the `risingwave-troubleshooting` skill for comprehensive coverage. Reference specific guides for:
- Window function and aggregation edge cases
- MV architecture anti-patterns
- Systematic EXPLAIN plan analysis
- Pre-deployment review checklist
