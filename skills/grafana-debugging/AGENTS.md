# Agent References

> This file is auto-generated. Do not edit directly. Run `npm run build` to regenerate.

## CLI Tool Usage (HIGH)

### Use grafana-cli to search, list, and render Grafana panels

**Impact:** HIGH - Enables visual metrics inspection without browser access

**Tags:** grafana, cli, render, panel, dashboard, tool

## Problem Statement

Agents troubleshooting RisingWave production issues need to inspect Grafana metrics visually, but don't have browser access. The `grafana-cli` tool bridges this gap by searching dashboards, listing panels, and rendering individual panels to PNG images that agents can read and interpret.

## Best Practice

### Setup

Set required environment variables before using the tool:

```bash
export GRAFANA_URL="https://your-grafana-instance.com"
export GRAFANA_API_TOKEN="your-api-token-here"
```

The API token needs at minimum Viewer permissions on the dashboards you want to inspect.

### Command 1: Search Dashboards

Find dashboards by name:

```bash
grafana-cli search-dashboards --query "risingwave"
```

Output (JSON to stdout):
```json
[
  {
    "id": 1,
    "uid": "EpkBw5W4k",
    "title": "risingwave_dev_dashboard",
    "uri": "db/risingwave-dev-dashboard",
    "url": "/d/EpkBw5W4k/risingwave-dev-dashboard",
    "type": "dash-db",
    "tags": ["risingwave"],
    "isStarred": false
  }
]
```

Use the `uid` value from the output for subsequent commands.

### Command 2: List Panels

List all panels in a dashboard, or search by title:

```bash
# List all panels
grafana-cli list-panels --dashboard EpkBw5W4k

# Search for specific panels
grafana-cli list-panels --dashboard EpkBw5W4k --search "barrier latency"
```

Output (JSON to stdout):
```json
[
  {
    "id": 42,
    "title": "Barrier Latency",
    "description": "End-to-end barrier latency"
  }
]
```

The `--search` flag uses fuzzy matching — partial words work (e.g., "sst" matches "SSTable Count"). Returns up to 5 best matches.

### Command 3: Render Panel

Render a specific panel to a PNG image:

```bash
grafana-cli render-panel \
  --dashboard EpkBw5W4k \
  --panel 42 \
  --from now-1h \
  --to now \
  --var namespace=rwc-xxx-cluster-name \
  --var datasource=prometheus \
  --out barrier-latency.png
```

The command prints the output file path to stdout. Agents can then read the PNG image file to visually inspect the metric.

**Default values:**
- `--from`: `now-15m`
- `--to`: `now`
- `--width`: `1000`
- `--height`: `500`
- `--out`: `./panel-<id>.png`

### Common Variable Patterns for RisingWave

Most RisingWave Grafana dashboards use template variables:

```bash
# Specify the namespace (required for most dashboards)
--var namespace=rwc-xxx-cluster-name

# Specify the datasource
--var datasource=prometheus

# Multiple variables
--var namespace=rwc-xxx --var datasource=prometheus
```

## Additional Context

- **Cold cache retry**: The CLI automatically retries once (after 3 seconds) if the first render returns a suspiciously small image. This handles Grafana's cold PromQL cache where the first render warms the cache and the second gets actual data.
- **Time range tips**: Use `now-15m` for active/recent issues, `now-1h` for the last hour's context, `now-6h` for pattern analysis, `now-24h` for trend analysis.
- **Grafana image renderer**: The `render-panel` command requires the [Grafana Image Renderer](https://grafana.com/grafana/plugins/grafana-image-renderer/) plugin to be installed on the Grafana server.
- **File naming**: When investigating an issue, use descriptive output names (e.g., `barrier-latency-1h.png`, `memory-usage-24h.png`) to keep track of multiple renders.

## Reference

- [Grafana HTTP API - Dashboard](https://grafana.com/docs/grafana/latest/developers/http_api/dashboard/)
- [Grafana Image Rendering](https://grafana.com/docs/grafana/latest/setup-grafana/image-rendering/)

---

## Investigation Workflows (CRITICAL)

### Systematic metrics investigation workflow for RisingWave issues

**Impact:** CRITICAL - Structured approach reduces mean time to diagnosis by following proven investigation paths

**Tags:** workflow, investigation, debugging, metrics, grafana, troubleshooting

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

---

## Dashboard Traversal (CRITICAL)

### Dashboard traversal patterns for RisingWave symptom diagnosis

**Impact:** CRITICAL - Targeted panel sequences per symptom reduce investigation from dozens of panels to 3-5 key renders

**Tags:** dashboard, traversal, panels, barrier, oom, compaction, cdc, sink, grafana

## Problem Statement

RisingWave Grafana dashboards contain dozens of panels. Without guidance, agents render panels randomly, wasting time and missing critical correlations. Traversal patterns specify exactly which panels to render, in which order, for each symptom category — reducing investigation to 3-5 targeted renders.

## Best Practice

### Barrier Stuck

When barrier latency exceeds 60 seconds, follow this sequence:

**Step 1: Confirm barrier stuck**
```bash
grafana-cli list-panels --dashboard <uid> --search "barrier latency"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-30m --out barrier-latency.png
```
Look for: sustained values > 60s. If < 10s, barrier is healthy — investigate elsewhere.

**Step 2: Find backpressure source**
```bash
grafana-cli list-panels --dashboard <uid> --search "actor output blocking time"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-30m --out blocking-time.png
```
Look for: actors with blocking time ratio > 50%. These downstream operators are the bottleneck.

**Step 3: Check for write stop**
```bash
grafana-cli list-panels --dashboard <uid> --search "write stop"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-30m --out write-stop.png
```
Look for: non-zero values. If write stop is active, compaction is the root cause — follow the Compaction Backlog sequence.

**Step 4: Check memory pressure**
```bash
grafana-cli list-panels --dashboard <uid> --search "memory usage"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-30m --out memory.png
```
Look for: memory approaching the configured limit. If memory is high, follow the OOM / High Memory sequence.

**Decision tree:**
- Write stop active → follow Compaction Backlog
- Memory near limit → follow OOM / High Memory
- Neither → check await-tree for async bottlenecks (SQL diagnostic, not Grafana)

---

### OOM / High Memory

When a compute node is OOM-killed or memory usage exceeds 90% of the limit:

**Step 1: Confirm memory growth pattern**
```bash
grafana-cli list-panels --dashboard <uid> --search "memory usage"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out memory-1h.png
```
Look for: gradual climb (state growth), sudden spike (batch operation), or sawtooth at ceiling (LRU eviction).

**Step 2: Check LRU eviction**
```bash
grafana-cli list-panels --dashboard <uid> --search "lru watermark"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out lru.png
```
Look for: "LRU watermark (now - epoch)" not decreasing to 0 under memory pressure means LRU is not evicting effectively.

**Step 3: Check barrier latency**
```bash
grafana-cli list-panels --dashboard <uid> --search "barrier latency"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out barrier.png
```
Look for: barrier issues cause memory buildup because state cannot be flushed. If barrier latency is high, the memory issue is secondary — fix the barrier issue first.

**Step 4: Check ingestion rate**
```bash
grafana-cli list-panels --dashboard <uid> --search "source throughput"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out source.png
```
Look for: sudden increase in source throughput that correlates with memory growth.

**Decision tree:**
- Barrier latency high → fix barrier first (barrier stuck sequence)
- LRU not working → investigate memory configuration
- Source throughput spike → ingestion rate exceeds processing capacity
- Gradual climb → unbounded state growth (missing temporal filter in MV)

---

### Compaction Backlog

When L0 file count is growing or write stop is triggered:

**Step 1: Confirm L0 accumulation**
```bash
grafana-cli list-panels --dashboard <uid> --search "l0 file count"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out l0-count.png
```
Look for: count > 100 and trend is upward. Healthy systems keep L0 under 50.

**Step 2: Check write stop status**
```bash
grafana-cli list-panels --dashboard <uid> --search "write stop compaction"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out write-stop.png
```
Look for: non-zero values mean ingestion is blocked waiting for compaction.

**Step 3: Check compaction throughput**
```bash
grafana-cli list-panels --dashboard <uid> --search "compaction throughput"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out compaction-throughput.png
```
Look for: declining throughput or flatline at zero (compactor crash). Healthy compaction shows steady throughput matching ingestion rate.

**Step 4: Check pending vs completed tasks**
```bash
grafana-cli list-panels --dashboard <uid> --search "compaction task count"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out compaction-tasks.png
```
Look for: pending count >> completed count means compactor cannot keep up.

**Decision tree:**
- Compaction throughput at zero → compactor process is down or crashed
- Pending >> completed → scale compactors or tune configuration
- L0 climbing despite active compaction → write rate exceeds compaction capacity

---

### Source / CDC Issues

When source throughput drops or CDC replication lags:

**Step 1: Check source throughput**
```bash
grafana-cli list-panels --dashboard <uid> --search "source throughput"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-30m --out source.png
```
Look for: drop to zero (source disconnected), sudden decrease (rate limiting), or flatline (no new data upstream).

**Step 2: Check source latency**
```bash
grafana-cli list-panels --dashboard <uid> --search "source latency"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-30m --out source-latency.png
```
Look for: increasing latency means consumer is falling behind the producer.

**Step 3: Check barrier latency**
```bash
grafana-cli list-panels --dashboard <uid> --search "barrier latency"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-30m --out barrier.png
```
Look for: CDC can block barriers if the source is stalled. High barrier latency with low source throughput confirms CDC as the cause.

**Decision tree:**
- Throughput at zero + latency increasing → source connection lost
- Throughput at zero + latency stable → no new data upstream (check source system)
- Barrier blocked with source stalled → CDC blocking the pipeline

---

### Slow Queries

When batch queries are taking too long:

**Step 1: Check query duration**
```bash
grafana-cli list-panels --dashboard <uid> --search "query duration"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out query-duration.png
```
Look for: query duration spikes or sustained high values.

**Step 2: Check storage read latency**
```bash
grafana-cli list-panels --dashboard <uid> --search "read latency"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out read-latency.png
```
Look for: high read latency means storage is the bottleneck (likely L0 accumulation or cache misses).

**Step 3: Check L0 file count**
```bash
grafana-cli list-panels --dashboard <uid> --search "l0"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out l0.png
```
Look for: high L0 count directly degrades read performance. If L0 > 100, follow Compaction Backlog sequence.

**Step 4: Check cache hit rate**
```bash
grafana-cli list-panels --dashboard <uid> --search "cache hit"
grafana-cli render-panel --dashboard <uid> --panel <id> --from now-1h --out cache.png
```
Look for: low hit rate means more data read from object storage. May need to increase block cache size.

**Decision tree:**
- High L0 → compaction backlog causing slow reads
- Low cache hit rate → increase block cache or data too large for cache
- Read latency spikes with normal L0 → object storage latency (external issue)

---

### Cascading Failure

When multiple symptoms appear simultaneously (e.g., high barrier latency + high memory + compaction backlog):

**Step 1: Render all primary indicators at the same time range**
```bash
grafana-cli render-panel --dashboard <uid> --panel <barrier-id> --from now-1h --out barrier.png
grafana-cli render-panel --dashboard <uid> --panel <memory-id> --from now-1h --out memory.png
grafana-cli render-panel --dashboard <uid> --panel <source-id> --from now-1h --out source.png
grafana-cli render-panel --dashboard <uid> --panel <l0-id> --from now-1h --out l0.png
```

**Step 2: Identify the first deviation**

Compare the rendered panels chronologically. The metric that deviated first is the root cause:
- Source throughput dropped first → upstream issue cascaded
- Memory climbed first → state growth or leak triggered backpressure
- L0 count grew first → compaction issue caused write stop, then barrier stuck
- Barrier latency spiked first → single blocking event cascaded

**Step 3: Follow the root cause sequence**

Once you identify the first deviation, follow that symptom's specific traversal sequence to confirm and resolve.

## Additional Context

- **Panel discovery**: If you don't know the exact panel name, use `grafana-cli list-panels --dashboard <uid> --search "<keyword>"` to find relevant panels. The fuzzy search matches partial words.
- **Time range consistency**: Always use the same `--from` and `--to` for panels you want to compare. Mismatched ranges make chronological comparison impossible.
- **Alert thresholds for reference**:

| Metric | Warning | Critical |
|--------|---------|----------|
| Barrier Latency | > 30s | > 60s |
| L0 File Count | > 50 | > 100 |
| Memory Usage | > 80% of limit | > 95% of limit |
| Write Stop Groups | > 0 | — |
| Source Throughput | Drop > 50% | Drop to 0 |

## Reference

- [Monitor a RisingWave Cluster](https://docs.risingwave.com/operate/monitor-risingwave-cluster)
- [Grafana Documentation](https://grafana.com/docs/)

---

## Visual Pattern Recognition (HIGH)

### Interpret visual metric patterns in rendered Grafana panels

**Impact:** HIGH - Enables accurate diagnosis from rendered panel images without manual metric reading

**Tags:** visual, pattern, metrics, interpretation, grafana, diagnosis

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

---

