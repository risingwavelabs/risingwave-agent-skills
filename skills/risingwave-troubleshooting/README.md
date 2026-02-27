# RisingWave Troubleshooting

Production-ready troubleshooting guides for RisingWave streaming database, derived from real on-call incidents and operational experience.

## What's Included

28 reference guides across 9 categories, covering 9 CRITICAL, 17 HIGH, and 2 MEDIUM impact topics.

### Performance & Memory (CRITICAL/HIGH)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `perf-barrier-stuck` | CRITICAL | Diagnose and resolve barrier stuck issues |
| `perf-compute-node-oom` | CRITICAL | Diagnose and resolve Compute Node OOM |
| `perf-join-optimization` | CRITICAL | Optimize streaming join performance and avoid common pitfalls |
| `perf-temporal-filters-and-state` | CRITICAL | Use temporal filters and watermarks correctly for state management |
| `perf-dml-best-practices` | CRITICAL | Avoid DML pitfalls that stall streaming pipelines |
| `perf-window-and-aggregation` | HIGH | Optimize window functions and aggregations for streaming |
| `perf-mv-pipeline-optimization` | HIGH | Refactor and optimize existing MV pipelines |
| `perf-mv-design-patterns` | HIGH | Design materialized views for efficient streaming and serving |
| `perf-ddl-background-management` | HIGH | Manage background DDL and MV creation |
| `perf-parallelism-management` | HIGH | Manage streaming job parallelism and adaptive scaling |
| `perf-streaming-tuning` | HIGH | Streaming performance tuning and optimization |
| `perf-index-management` | HIGH | Manage indexes for query acceleration |

### Storage & Compaction (CRITICAL/HIGH)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `storage-l0-compaction-stuck` | CRITICAL | Resolve L0 file accumulation and compaction stuck |
| `storage-compaction-config` | HIGH | Configure compaction groups and storage settings |

### Sources (HIGH)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `source-kafka-ssl-connection` | HIGH | Troubleshoot Kafka source SSL/TLS connection issues |

### Sinks (CRITICAL/HIGH/MEDIUM)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `sink-snowflake-barrier-stuck` | CRITICAL | Troubleshoot Snowflake sink causing barrier stuck |
| `sink-jdbc-connection-issues` | HIGH | Troubleshoot JDBC sink connection issues |
| `sink-iceberg-issues` | MEDIUM | Troubleshoot Iceberg sink issues |

### CDC (HIGH)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `cdc-troubleshooting` | HIGH | Troubleshoot CDC source issues (Postgres, MySQL, MongoDB) |
| `cdc-sink-decouple` | HIGH | Configure and monitor sink decoupling |

### Cluster Operations (CRITICAL/HIGH)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `cluster-pod-health` | CRITICAL | Diagnose and resolve pod health issues |
| `cluster-connection-secret-management` | HIGH | Manage connections and secrets for external systems |
| `cluster-user-access-control` | HIGH | Audit user privileges and access control |

### Operational Best Practices (CRITICAL)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `ops-serving-and-batch-queries` | CRITICAL | Manage serving nodes and prevent batch query overload |

### Diagnostic Queries (HIGH)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `diag-essential-queries` | HIGH | Essential diagnostic SQL queries |
| `diag-explain-plan-analysis` | HIGH | Read and interpret EXPLAIN output for streaming jobs |
| `diag-benchmark-environment-guide` | HIGH | Benchmark environment setup and testing methodology |

### Monitoring & Alerts (MEDIUM)

| Reference | Impact | Description |
|-----------|--------|-------------|
| `monitor-grafana-metrics` | MEDIUM | Navigate Grafana metrics for troubleshooting |

## Quick Start

When troubleshooting RisingWave issues, always start with:

```sql
-- Check recent system events
SELECT * FROM rw_event_logs ORDER BY timestamp DESC LIMIT 20;

-- Check LSM storage layout
SELECT compaction_group_id, level_id, count(*) AS file_count,
       round(sum(file_size)/1024/1024) AS size_mb
FROM rw_hummock_sstables
GROUP BY compaction_group_id, level_id
ORDER BY compaction_group_id, level_id;

-- Check sink decoupling status
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a JOIN rw_sinks b ON a.sink_id = b.id;
```

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines on adding new references.

## License

MIT
