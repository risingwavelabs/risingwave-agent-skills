---
name: risingwave-troubleshooting
license: MIT
metadata:
  version: 1.0.0
  author: RisingWave Labs
description: |
  RisingWave troubleshooting and operational best practices derived from real production incidents.

  This skill helps agents with:
  - Diagnosing and resolving performance issues (barrier stuck, OOM, backpressure, join optimization)
  - Designing and optimizing materialized view pipelines
  - Managing storage and compaction problems (L0 accumulation, write stops)
  - Troubleshooting CDC, source, and sink issues (Kafka, JDBC, Snowflake, Iceberg)
  - Running diagnostic queries, EXPLAIN plan analysis, and cluster operations
---

# RisingWave Troubleshooting

## Overview

This skill provides comprehensive troubleshooting guidance for RisingWave streaming database operations. All references are derived from real production incidents and the on-call knowledge base, ensuring practical, battle-tested solutions.

## When to Use

Apply this skill when:
- Investigating streaming job performance issues or stuck barriers
- Diagnosing memory problems (OOM, high memory usage)
- Troubleshooting storage/compaction issues
- Debugging CDC source problems (Postgres, MySQL, MongoDB)
- Running cluster maintenance operations
- Analyzing system health via diagnostic queries

## Categories

This skill organizes references into the following categories:

| Category | Priority | Prefix | Count | Description |
|----------|----------|--------|-------|-------------|
| Performance & Memory | CRITICAL/HIGH | `perf-` | 12 | Barrier stuck, OOM, joins, MV design, DML, streaming tuning |
| Storage & Compaction | CRITICAL/HIGH | `storage-` | 2 | L0 files, compaction config, write stops |
| Sources | HIGH | `source-` | 1 | Kafka SSL/TLS connection issues |
| Sinks | CRITICAL/HIGH/MEDIUM | `sink-` | 3 | Snowflake, JDBC, Iceberg sink issues |
| CDC | HIGH | `cdc-` | 2 | CDC troubleshooting, sink decoupling |
| Cluster Operations | CRITICAL/HIGH | `cluster-` | 3 | Pod health, connections, access control |
| Operational Best Practices | CRITICAL | `ops-` | 1 | Serving nodes, batch query management |
| Diagnostic Queries | HIGH | `diag-` | 3 | SQL queries, EXPLAIN plan analysis, benchmarking |
| Monitoring & Alerts | MEDIUM | `monitor-` | 1 | Grafana metrics, alerting |

## Key Principles

1. **Always check event logs first**: `SELECT * FROM rw_event_logs ORDER BY timestamp DESC;`
2. **Use await-tree for barrier issues**: Identify bottleneck via async stack traces
3. **Check LSM layout for storage issues**: Query `rw_hummock_sstables` for L0 accumulation
4. **Verify sink decoupling**: Coupled sinks are a common cause of barrier blocking
5. **Profile memory before scaling**: Use heap dumps to identify actual memory consumers

## Usage

The skill activates automatically when working on RisingWave troubleshooting tasks. Reference the specific guides when encountering:
- High barrier latency (> 1 minute)
- Compute node OOM/restarts
- Source throughput dropping to zero
- Compaction backlog growing
- CDC replication lag increasing
