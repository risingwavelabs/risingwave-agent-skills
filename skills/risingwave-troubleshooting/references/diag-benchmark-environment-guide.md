---
title: "Benchmark environment setup and testing methodology for meaningful results"
impact: "HIGH"
impactDescription: "Avoid false conclusions from unrepresentative tests, saving days of wasted optimization effort"
tags: ["benchmark", "testing", "environment", "docker", "methodology", "data-volume", "streaming"]
---

## Problem Statement

Performance benchmarks in non-representative environments lead to false conclusions. Docker playground uses in-memory state (data lost after 30 minutes of inactivity), Docker Compose uses local MinIO (local disk I/O), while production uses remote object storage (S3, GCS, Azure Blob). Single-event tests miss aggregation and join behavior that only manifests under volume. Without proper methodology, teams optimize for artifacts of the test environment rather than real production bottlenecks.

## Environment Differences That Matter

### Playground mode (Docker single-container)

```bash
docker run -it --pull=always -p 4566:4566 risingwavelabs/risingwave:latest playground
```

- **State backend:** In-memory (filesystem-backed in standalone mode)
- **Metadata:** Embedded SQLite
- **Auto-shutdown:** Terminates after 30 minutes of inactivity, losing all data
- **Use for:** Quick syntax validation, learning SQL, single-query testing
- **Do NOT use for:** Performance benchmarks, state size testing, durability testing

### Docker Compose (local MinIO)

```bash
docker compose up -d
```

- **State backend:** MinIO on local disk (S3-compatible, but local I/O)
- **Metadata:** etcd
- **Compactor:** Runs locally, competing with compute for CPU/memory
- **Use for:** Functional testing, pipeline correctness verification, small-scale performance comparisons
- **Limitations:** Local disk I/O is orders of magnitude faster than remote S3 for random reads. Compaction runs on the same machine, distorting CPU/memory profiles.

### Production (RisingWave Cloud / self-hosted with remote object storage)

- **State backend:** Remote object storage (S3, GCS, Azure Blob, etc.)
- **Compute cache:** Local NVMe or EBS for disk cache; all reads hit cache first, S3 only for cold data
- **Compactor:** Separate nodes (in cloud) or co-located (self-hosted)
- **Network:** Object store access adds latency to cold reads and compaction I/O

### Key differences summary

| Property | Playground | Docker Compose | Production |
|----------|-----------|----------------|------------|
| State storage | In-memory / local FS | Local MinIO | Remote S3/GCS/Azure |
| Disk cache behavior | N/A | Local disk (fast) | NVMe/EBS cache → S3 fallback |
| Compaction I/O | Local | Local (contends with compute) | Separate compactor nodes (cloud) |
| Network latency to state | None | None | ~1-10ms per S3 call (cold reads) |
| Representative of prod? | No | Partially | Yes |
| Resource contention | Single process | All services on one host | Isolated nodes |

## Data Volume Requirements

### Why volume matters for streaming benchmarks

Streaming operators behave differently under volume than with single events:

1. **Aggregation operators** accumulate state proportional to group cardinality. A `GROUP BY user_id` with 1 user is trivial; with 10M users it stresses memory and compaction.
2. **Join operators** probe state for every incoming record. Join performance depends on state table size, not just throughput rate.
3. **Temporal filters** clean expired state at barrier boundaries. Without enough data to generate state, you can't test whether state cleaning works.
4. **Window functions** maintain partition state. Under-populated partitions miss the performance characteristics of production workloads.

### Minimum volume guidelines

| Test Objective | Minimum Data Volume | Why |
|---------------|-------------------|-----|
| Functional correctness | 10-100 rows per table | Enough to verify output logic |
| Aggregation performance | 100K+ rows with realistic cardinality | State must reach meaningful size |
| Join performance | Both sides populated with realistic ratios | Join amplification only visible at scale |
| State cleaning (temporal filter / TTL) | Run for 10+ minutes with continuous inserts | Need multiple barrier cycles with state accumulation and expiration |
| Backfill performance | Full production-scale data | Backfill speed depends on source table size |
| End-to-end latency | 1K+ events/second sustained for 5+ minutes | Latency stabilizes after initial burst |

### Generating test data

```sql
-- Generate test data directly in RisingWave
-- For a fact table:
INSERT INTO events (event_id, user_id, amount, created_at)
SELECT
  generate_series AS event_id,
  (random() * 10000)::int AS user_id,
  (random() * 1000)::decimal(10,2) AS amount,
  now() - interval '30 days' * random() AS created_at
FROM generate_series(1, 100000);
```

For sustained streaming benchmarks, use a Kafka source with a data generator (e.g., `datagen` connector or `kafka-producer-perf-test`).

```sql
-- RisingWave's built-in datagen connector for testing
CREATE TABLE test_events (
  event_id int,
  user_id int,
  amount decimal,
  created_at timestamp
) WITH (
  connector = 'datagen',
  fields.event_id.kind = 'sequence',
  fields.event_id.start = '1',
  fields.user_id.kind = 'random',
  fields.user_id.min = '1',
  fields.user_id.max = '10000',
  fields.amount.kind = 'random',
  fields.amount.min = '1',
  fields.amount.max = '1000',
  datagen.rows.per.second = '5000'
) FORMAT PLAIN ENCODE JSON;
```

## Streaming Operator Testing Pitfalls

### Pitfall 1: Single-event tests for aggregation workloads

Inserting one row and checking the output only validates SQL syntax, not performance. Aggregation operators need volume to expose state management costs.

**What to do instead:** Insert enough data to populate realistic group cardinality, then measure throughput and latency under sustained load.

### Pitfall 2: Testing temporal joins by inserting into the dimension (right) side

Temporal joins (`FOR SYSTEM_TIME AS OF PROCTIME()`) only trigger output when the stream (left) side receives new data. Inserting into the dimension (right) side produces zero output — this is expected behavior, not a bug.

**What to do instead:** Drive test data from the stream (left) side. For details, see the temporal join testing pitfall in [perf-join-optimization](./perf-join-optimization.md).

### Pitfall 3: Measuring latency from a single event

RisingWave processes data in micro-batches at barrier intervals (default: 1 second). A single event's end-to-end latency includes waiting for the next barrier, making it misleading. Latency should be measured as the sustained p50/p99 under continuous load.

**What to do instead:** Generate continuous load for several minutes and measure steady-state latency from Grafana (Streaming > Barrier Latency).

### Pitfall 4: Testing in a quiescent system

A freshly started system with no data has empty caches, no compaction pressure, and no concurrent workloads. Production systems have background compaction, concurrent queries, and memory pressure from existing state.

**What to do instead:** Pre-populate tables with representative data volumes before running the benchmark. Let the system reach steady state (compaction caught up, caches warm) before measuring.

### Pitfall 5: Ignoring compaction during benchmarks

Heavy inserts trigger compaction, which competes for CPU and I/O. Short benchmarks may not trigger enough compaction to reflect production behavior.

**What to do instead:** Run benchmarks long enough for at least several compaction cycles. Monitor compaction metrics in Grafana (Hummock > Compaction).

## Environment Checklist

Before trusting benchmark results, verify:

### Infrastructure
- [ ] State backend matches production (object storage, not local disk)
- [ ] Compute resources (CPU, memory) are comparable to production
- [ ] Network conditions are representative (especially for remote object store)
- [ ] Compactor is deployed in the same configuration as production

### Data
- [ ] Data volume is sufficient for the test objective (see guidelines above)
- [ ] Data cardinality (number of distinct groups/keys) matches production
- [ ] Data distribution (skew) matches production patterns
- [ ] Data types and sizes match production schema

### Workload
- [ ] Throughput rate matches production (events per second)
- [ ] Concurrent workloads are present if testing under load
- [ ] Benchmark runs long enough for steady state (5+ minutes minimum)
- [ ] Multiple iterations are run to account for variance

### Measurement
- [ ] Metrics are collected from the steady-state period (not including warmup)
- [ ] Barrier latency, throughput, and memory usage are all tracked
- [ ] State table sizes are recorded (not just query latency)
- [ ] Compaction metrics are monitored for I/O pressure

## When Docker Compose Is Sufficient

Docker Compose with local MinIO is acceptable for:

1. **Correctness testing** — Verifying pipeline output is correct
2. **Relative comparison** — Comparing two MV designs against each other (same environment bias cancels out)
3. **Functional regression** — Ensuring changes don't break output
4. **Development iteration** — Rapid prototyping of MV definitions

Docker Compose is **not sufficient** for:

1. **Absolute latency targets** — Local disk I/O makes everything faster than production
2. **Memory capacity planning** — Single-host resource contention differs from distributed
3. **Compaction behavior** — Local compaction differs from separate compactor nodes
4. **Scale testing** — Single-node parallelism is not representative of multi-node

## Quick-Start Benchmark Template

For a quick but meaningful streaming benchmark:

```sql
-- 1. Create source with datagen connector (sustained load)
CREATE TABLE bench_source (
  id int,
  key int,
  value decimal,
  ts timestamp
) WITH (
  connector = 'datagen',
  fields.id.kind = 'sequence',
  fields.id.start = '1',
  fields.key.kind = 'random',
  fields.key.min = '1',
  fields.key.max = '100000',
  fields.value.kind = 'random',
  fields.value.min = '1',
  fields.value.max = '10000',
  datagen.rows.per.second = '10000'
) FORMAT PLAIN ENCODE JSON;

-- 2. Create the MV being benchmarked
CREATE MATERIALIZED VIEW bench_mv AS
SELECT key, count(*) AS cnt, sum(value) AS total
FROM bench_source
GROUP BY key;

-- 3. Wait 5+ minutes for steady state

-- 4. Check metrics
-- Grafana: Streaming > Barrier Latency (should be stable)
-- Grafana: Streaming > Source Throughput (should match datagen rate)

-- 5. Check state size
SELECT total_key_count,
       round((total_key_size + total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_catalog.rw_table_stats s
JOIN rw_catalog.rw_materialized_views m ON s.id = m.id
WHERE m.name = 'bench_mv';

-- 6. Run EXPLAIN ANALYZE for bottleneck detection
-- EXPLAIN ANALYZE (duration_secs 30) MATERIALIZED VIEW bench_mv;

-- 7. Clean up
DROP MATERIALIZED VIEW bench_mv;
DROP TABLE bench_source;
```

## Additional Context

- For EXPLAIN ANALYZE to identify bottleneck operators, see [diag-explain-plan-analysis](./diag-explain-plan-analysis.md)
- For MV pipeline optimization after benchmarking, see [perf-mv-pipeline-optimization](./perf-mv-pipeline-optimization.md)
- For temporal join behavior and testing, see [perf-join-optimization](./perf-join-optimization.md)
- For barrier latency diagnosis, see [perf-barrier-stuck](./perf-barrier-stuck.md)

## Reference

- [RisingWave Docker Compose Deployment](https://docs.risingwave.com/deploy/risingwave-docker-compose)
- [RisingWave Storage Overview](https://docs.risingwave.com/store/overview)
- [RisingWave datagen Connector](https://docs.risingwave.com/ingest/supported-sources-and-formats)
- [RisingWave Grafana Dashboard](https://docs.risingwave.com/operate/monitor-risingwave-cluster)
