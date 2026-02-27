---
title: "Systematic metrics investigation workflow for RisingWave issues"
impact: "CRITICAL"
impactDescription: "Structured approach reduces mean time to diagnosis by following proven investigation paths"
tags: ["workflow", "investigation", "debugging", "metrics", "grafana", "troubleshooting"]
---

## Problem Statement

Ad-hoc metric checking wastes time and misses correlations. When troubleshooting a RisingWave production issue, checking random panels leads to incomplete diagnosis. A structured investigation workflow ensures consistent, thorough diagnosis by following proven paths from symptom to root cause.

## Best Practice

### The Investigation Loop

Follow this sequence for every metrics investigation:

**Step 1: Identify the symptom category**

Classify the issue into one of these categories:
- **Barrier stuck** — streaming pipeline stalled, barrier latency > 60s
- **OOM / high memory** — compute node OOM restarts, memory approaching limit
- **Compaction backlog** — L0 file count growing, write stops
- **Source / CDC issues** — source throughput dropped, replication lag
- **Slow queries** — batch queries taking too long
- **Cascading failure** — multiple symptoms appearing simultaneously

**Step 2: Find the right dashboard**

```bash
grafana-cli search-dashboards --query "risingwave"
```

Note the dashboard UID for subsequent commands.

**Step 3: Render the primary indicator panel**

Each symptom category has one primary panel that confirms or rules out the issue. Render it first:

| Symptom | Primary Panel | Critical Threshold |
|---------|--------------|-------------------|
| Barrier stuck | Barrier Latency | > 60s |
| OOM | Memory Usage | > 95% of limit |
| Compaction | L0 File Count | > 100 and growing |
| Source issues | Source Throughput | Drop to 0 |
| Slow queries | Query Duration | Depends on baseline |

```bash
grafana-cli list-panels --dashboard <uid> --search "barrier latency"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-15m --out primary.png
```

**Step 4: Interpret the visual pattern**

Read the rendered panel image. Look for:
- Spikes (sudden events)
- Flatlines (something stopped)
- Gradual climbs (degradation over time)
- Sawtooth (periodic behavior)

See the visual pattern recognition reference for detailed interpretation guidance.

**Step 5: Render correlated panels**

Follow the dashboard traversal pattern for your symptom category. Each symptom has a sequence of 3-5 panels that together reveal the root cause.

```bash
# Render each panel in the traversal sequence
grafana-cli render-panel --dashboard <uid> --panel <id1> --from now-15m --out step1.png
grafana-cli render-panel --dashboard <uid> --panel <id2> --from now-15m --out step2.png
```

**Step 6: Narrow the time range**

Once you spot the anomaly, re-render with a tighter window to see the exact onset:

```bash
# Narrow from 15m to 5m around the event
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-5m --out narrow.png
```

If the issue started at a known time, use explicit timestamps.

**Step 7: Cross-dashboard correlation**

Render panels from different dashboards at the same time range to confirm the relationship:

```bash
# Same time range across Streaming and Memory dashboards
grafana-cli render-panel --dashboard <streaming-uid> --panel <id> --from now-30m --out streaming.png
grafana-cli render-panel --dashboard <memory-uid> --panel <id> --from now-30m --out memory.png
```

**Step 8: Confirm root cause**

The metric that shows the earliest deviation is the root cause. Compare timestamps across rendered panels:
- If memory spiked before barrier latency increased → memory is the root cause
- If barrier latency increased before memory grew → backpressure is causing memory buildup
- If L0 count grew before write stop → compaction falling behind is the root cause

### Time Range Selection Guide

| Scenario | Recommended Range | Why |
|----------|------------------|-----|
| Active issue, just reported | `now-15m` | See current state clearly |
| Issue happened recently | `now-1h` | Capture onset and current state |
| Recurring pattern | `now-6h` | See multiple cycles |
| Gradual degradation | `now-24h` | See the full trend |
| Compare before/after change | `now-48h` | Context around deployment |

### Investigation Checklist

For every investigation, render at minimum:
1. The primary indicator panel for the symptom
2. At least one correlated panel from a different dashboard section
3. A narrowed time range of the anomaly period

## Additional Context

- Always use the same `--from` and `--to` values when rendering panels you want to compare — mismatched time ranges make correlation impossible.
- If a panel shows "No data", verify the `--var namespace=` value matches the actual cluster namespace.
- Start with the broadest symptom category, then narrow down. For example, if you see high barrier latency AND high memory, check which one deviated first chronologically.
- Save all rendered panel images with descriptive names. When reporting findings, reference the specific panel names and time ranges.

## Reference

- [Monitor a RisingWave Cluster](https://docs.risingwave.com/operate/monitor-risingwave-cluster)
