---
title: "Navigate Grafana metrics for troubleshooting"
impact: "MEDIUM"
impactDescription: "Faster issue identification, better system understanding"
tags: ["monitoring", "grafana", "metrics", "dashboard", "alerts"]
---

## Problem Statement

RisingWave exposes extensive metrics through Grafana. Knowing which panels to check for different issues accelerates troubleshooting.

## Key Dashboards and Panels

### Streaming Dashboard

**Location**: `risingwave_dashboard` > `Streaming`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| Barrier Latency | > 10s sustained | Streaming backpressure |
| Actor Output Blocking Time Ratio | > 50% | Downstream bottleneck |
| Source Throughput | Drop to 0 | Source connectivity or rate limit |
| Sink Throughput | Flatline | Sink issues |

**Barrier Latency Interpretation**:
- < 1s: Healthy
- 1-10s: Monitor closely
- > 10s: Investigate immediately
- > 60s: Barrier stuck, critical

### Memory Dashboard

**Location**: `risingwave_dashboard` > `Memory Management`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| Memory Usage | Approaching limit | Potential OOM |
| LRU Watermark (now - epoch) | Not decreasing to 0 under pressure | LRU not working |
| Cache Hit Rate | Low values | Performance degradation |

### Compaction Dashboard

**Location**: `risingwave_dashboard` > `Compaction`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| L0 File Count | > 100 and growing | Compaction falling behind |
| Write Stop Compaction Groups | Non-zero | Write stop active |
| Compaction Throughput | Declining | Compactor issues |
| Compaction Task Count | Pending > Completed | Backlog building |

### Hummock (Storage) Dashboard

**Location**: `risingwave_dashboard` > `Hummock`

| Panel | What to Look For | Issue Indicated |
|-------|------------------|-----------------|
| Object Store Latency | Spikes | External storage issues |
| Cache Memory | Near limit | May need tuning |
| Read/Write IOPS | Unusual patterns | I/O bottleneck |

## Issue-Specific Panel Checks

### For Barrier Stuck

1. `Streaming` > `Barrier Latency` - Confirm barrier stuck
2. `Streaming` > `Actor Output Blocking Time` - Find backpressure source
3. `Compaction` > `Write Stop Compaction Groups` - Check for write stop
4. `Memory` > `Memory Usage` - Check for memory pressure

### For OOM

1. `Memory` > `Memory Usage` - Confirm memory growth pattern
2. `Memory` > `LRU Watermark` - Check if LRU is working
3. `Streaming` > `Barrier Latency` - Check for barrier issues (causes OOM)
4. Pod metrics - Check Kubernetes-level memory

### For Slow Queries

1. `Batch` > `Query Duration` - Identify slow queries
2. `Hummock` > `Read Latency` - Check storage read performance
3. `Compaction` > `L0 File Count` - High L0 = slow reads
4. `Cache` > `Hit Rate` - Low hit rate = more I/O

### For CDC Issues

1. `Streaming` > `Source Throughput` - Check if source is consuming
2. `Streaming` > `Source Latency` - Lag from upstream
3. `Connector` > `CDC Metrics` (if available)

## Alert Thresholds

Common alert conditions to configure:

| Metric | Warning | Critical |
|--------|---------|----------|
| Barrier Latency | > 30s | > 60s |
| L0 File Count | > 50 | > 100 |
| Memory Usage | > 80% | > 95% |
| Write Stop Groups | > 0 | - |
| Source Throughput | Drop > 50% | Drop to 0 |

## Grafana Tips

### Time Range Selection

- **Recent issues**: Last 15-30 minutes
- **Pattern analysis**: Last 6-24 hours
- **Correlation**: Align time ranges across dashboards

### Annotation Timestamps

Mark specific times across all panels:
1. Click on a panel at the event time
2. Add annotation with description
3. Annotation appears on all panels

### Export Data

For sharing or deeper analysis:
1. Panel menu > Inspect > Data
2. Download CSV or copy to clipboard

## Common Patterns

### Cascading Failure Pattern

1. Source throughput drops
2. Barrier latency increases
3. Memory pressure builds
4. OOM or write stop triggers
5. Recovery, cycle may repeat

**Action**: Address root cause (usually first symptom).

### Compaction Backlog Pattern

1. L0 count gradually increases
2. Read performance degrades
3. Write stop eventually triggers
4. After recovery, same pattern repeats

**Action**: Scale compactors or tune configuration.

## Additional Context

- Metrics have 15-30 second delay in Grafana
- Some metrics are sampled, not continuous
- Combine multiple panels for full picture
- Use Grafana alerts for proactive monitoring

## Reference

- [Monitor a RisingWave Cluster](https://docs.risingwave.com/operate/monitor-risingwave-cluster)
- [Grafana Documentation](https://grafana.com/docs/)
