---
title: "Interpret visual metric patterns in rendered Grafana panels"
impact: "HIGH"
impactDescription: "Enables accurate diagnosis from rendered panel images without manual metric reading"
tags: ["visual", "pattern", "metrics", "interpretation", "grafana", "diagnosis"]
---

## Problem Statement

When agents render Grafana panels to PNG images, they see visual shapes — lines, spikes, plateaus. Different RisingWave failure modes produce distinct visual signatures. Without knowing what these patterns mean, agents cannot extract diagnostic value from rendered panels. This reference catalogs the common visual patterns and what they indicate in each metric context.

## Best Practice

### Pattern 1: Spike (Sudden Vertical Jump)

**Visual signature:** A sharp upward peak that may or may not return to baseline.

**What it means by metric:**

| Metric | Interpretation | Likely Cause |
|--------|---------------|-------------|
| Barrier Latency | Single event caused pipeline stall | DDL operation, large batch insert, sink timeout, or heavy join materialization |
| Memory Usage | Sudden large allocation | Large batch query, join materialization, or MV backfill starting |
| Source Throughput | Burst of upstream data | Producer-side batch job or replay |

**Action:** Check what changed at the spike time — deployments, DDL operations, upstream batch jobs. If barrier latency spike is transient (returns to normal), no intervention needed. If sustained, follow the barrier stuck traversal.

---

### Pattern 2: Flatline at Zero

**Visual signature:** Metric drops to zero and stays there.

**What it means by metric:**

| Metric | Interpretation | Likely Cause |
|--------|---------------|-------------|
| Source Throughput | Source stopped consuming | Connection lost, rate limit hit, or upstream system down |
| Sink Throughput | Sink stopped producing | Sink failure, downstream system down, or backpressure from barrier |
| Compaction Throughput | Compactor stopped working | Compactor process crashed or resource starvation |

**Action:** A flatline at zero almost always indicates a component failure. Check pod health and logs for the relevant component.

---

### Pattern 3: Gradual Climb

**Visual signature:** Metric increases steadily over time without leveling off.

**What it means by metric:**

| Metric | Interpretation | Likely Cause |
|--------|---------------|-------------|
| Memory Usage | Unbounded state growth | Missing temporal filter in materialized view, state not being cleaned up |
| L0 File Count | Compaction falling behind | Write rate exceeds compaction throughput |
| Barrier Latency | Progressive degradation | Growing state size making each barrier checkpoint slower |

**Action:** Gradual climbs indicate a structural problem that will eventually cause a failure (OOM, write stop, barrier stuck). Address the root cause rather than treating symptoms. For memory: check MVs for missing temporal filters. For L0: scale compactors.

---

### Pattern 4: Sawtooth (Periodic Rise and Drop)

**Visual signature:** Regular oscillations — metric rises, drops, rises, drops.

**What it means by metric:**

| Metric | Interpretation | Likely Cause |
|--------|---------------|-------------|
| Memory Usage | LRU eviction cycles | Memory reaches threshold, LRU evicts, fills again — this is normal if amplitude is stable |
| Compaction Throughput | Periodic compaction cycles | Compactor runs, clears backlog, pauses, backlog builds — normal for bursty workloads |
| CPU Usage | Periodic processing spikes | Batch scheduling or periodic upstream data patterns |

**Action:** Sawtooth is often normal. Only concerning if:
- Amplitude is growing over time (each peak is higher than the last)
- Frequency is increasing (cycles getting shorter)
- Troughs are rising (baseline never returns to the same level)

---

### Pattern 5: Plateau / Ceiling

**Visual signature:** Metric rises to a certain level and stays flat, unable to go higher.

**What it means by metric:**

| Metric | Interpretation | Likely Cause |
|--------|---------------|-------------|
| Memory Usage | Hitting memory limit | LRU is actively evicting to keep memory at the cap |
| CPU Usage | Compute-bound | Needs vertical scaling or parallelism increase |
| Compaction Throughput | Compactor at maximum capacity | Cannot compact faster with current resources |

**Action:** A plateau means the system is resource-constrained. Check if the plateau level matches a configured limit. For memory: check if this equals the memory limit. For compaction: scale compactor resources.

---

### Pattern 6: Sudden Drop to Zero then Recovery

**Visual signature:** Metric abruptly drops to zero, stays at zero briefly, then resumes.

**What it means by metric:**

| Metric | Interpretation | Likely Cause |
|--------|---------------|-------------|
| Any metric | Node restart or crash | Pod was OOM-killed, evicted, or crashed and was restarted by Kubernetes |
| Source Throughput | Temporary connection loss | Brief network partition or upstream restart |

**Action:** Check pod restart counts and events around the drop time. If recurring, the drops will show a regular pattern — identify what's triggering the restarts (usually OOM or liveness probe failures).

---

### Pattern 7: Step Change (Sudden Shift to New Baseline)

**Visual signature:** Metric was stable at one level, then abruptly shifts to a new stable level (higher or lower).

**What it means by metric:**

| Metric | Interpretation | Likely Cause |
|--------|---------------|-------------|
| Source Throughput | Upstream workload changed | New producer added, producer removed, or schema change |
| Memory Usage | Configuration or topology change | New MV created, parallelism changed, or memory limit adjusted |
| Barrier Latency | Pipeline complexity changed | New streaming job added or removed |

**Action:** Correlate the step change with deployment events, DDL operations, or upstream changes. A step change up may require resource scaling; a step change down usually indicates a resolved issue or removed workload.

## Additional Context

- **Time range affects pattern visibility**: Rendering with too narrow a time range (e.g., `now-1m`) may show only a flat line even during an active issue. Use at minimum `now-15m` to see patterns, and `now-1h` for pattern analysis.
- **Metrics have 15-30 second delay**: The most recent data points in Grafana may lag behind real-time by up to 30 seconds. Don't assume "now" in the panel matches actual current state.
- **Sampled vs continuous metrics**: Some metrics are sampled at intervals. Brief transient events may not appear in rendered panels. If you suspect a transient issue, narrow the time range to increase visual resolution.
- **Multiple series on one panel**: Some panels show multiple lines (e.g., per-node memory usage). Look at each line individually — one node hitting a ceiling while others are normal indicates a node-specific issue.
- **When comparing panels**: Always render with identical time ranges. Even a few minutes of offset can make it impossible to correlate events chronologically.

## Reference

- [Monitor a RisingWave Cluster](https://docs.risingwave.com/operate/monitor-risingwave-cluster)
