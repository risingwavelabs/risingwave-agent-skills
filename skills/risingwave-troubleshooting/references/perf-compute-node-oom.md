---
title: "Diagnose and resolve Compute Node OOM"
impact: "CRITICAL"
impactDescription: "Prevent cluster instability, restore normal operations"
tags: ["oom", "memory", "compute-node", "crash", "performance"]
---

## Problem Statement

Compute Node OOM (Out of Memory) causes pod restarts and service disruption. Memory issues can cascade across the cluster, affecting all streaming jobs. Early detection and proper diagnosis are essential for stable operations.

## Observations

1. **Grafana Memory Metrics**: Memory increases unbounded, beyond the `total_memory` limit set for CN
2. **Kubernetes Exit Code**: OOM Killed (137) - check with `kubectl describe pod xxx`
3. **No Panic Logs**: OOM typically doesn't produce panic logs before crash

## Quick Solutions

### Solution 1: Wait for Auto-Recovery

If OOM disappears after a few restarts, the system may self-heal. Monitor for stability.

### Solution 2: Reduce Channel Buffer Size

```toml
# Requires compute node restart
[streaming.developer]
stream_exchange_initial_permits = 512
```

### Solution 3: Drop Problematic MV

Usually the newly created MV is the culprit:

```sql
-- If you can identify the problematic MV
DROP MATERIALIZED VIEW problematic_mv;
```

### Solution 4: Pause System for Intervention

If OOM happens too fast to drop MV:

```sql
-- Set pause flag before recovery
ALTER SYSTEM SET pause_on_next_bootstrap = true;
-- Restart meta node - streams will be paused
-- Now you can safely drop the problematic MV
```

### Solution 5: Enable Flow Control

```sql
-- Set backfill rate limit before creating MV (limits backfill speed)
SET backfill_rate_limit = 10000;  -- records per second per parallelism
CREATE MATERIALIZED VIEW mv AS ...;

-- Or set source rate limit to slow down ingestion
SET source_rate_limit = 10000;  -- records per second per source parallelism
```

Note: Rate limit must be larger than `stream_chunk_size` (default 256).

### Solution 6: Reduce Parallelism

```sql
-- Reduce parallelism for complex MVs
SET streaming_parallelism = 4;  -- default 0 = all CPU cores
CREATE MATERIALIZED VIEW mv AS ...;
```

## Root Cause Investigation

### Check 1: Was Barrier Stuck?

Barrier stuck > 1 minute often precedes OOM because memory management relies on barriers.

```
# In Grafana: Check barrier latency panel
# Gaps or spikes > 1 minute indicate barrier issues
```

If barrier was stuck, investigate barrier issues first (see [perf-barrier-stuck](./perf-barrier-stuck.md)).

### Check 2: LRU Watermark

Navigate to Grafana > Memory Management > LRU Watermark:

- If `now - watermark_epoch` decreased to near zero: LRU worked correctly, something else consumed memory
- If diff is not zero: LRU memory controller didn't work properly, this may indicate a bug - consider filing an issue

### Check 3: Memory Profiling

When LRU is working but OOM still occurs, run memory profiling:

```bash
# Inside the compute node pod
cd /risingwave/cache
ls -laht  # Check for heap dump files

# Analyze heap dump
jeprof --collapsed /risingwave/bin/risingwave HEAP_FILE > heap.collapsed

# Download and visualize with https://www.speedscope.app/
# Click "Left Heavy" to merge shared calling stacks
```

Heap dumps are automatically generated when memory hits threshold. If missing:
- Jemalloc profiling not enabled (`MALLOC_CONF="prof:true"`)
- Folder not mounted (deleted after restart)
- Memory never hit threshold
- Files already scraped to S3

## Memory Configuration

Check CN boot logs for "Memory outline" to see current memory settings:

```bash
cat .risingwave/log/* | grep -o 'chunk_size: [0-9]*'
```

## Common OOM Causes

1. **Join Amplification**: Many-to-many joins can explode memory
2. **Large State Tables**: Check state table sizes in Grafana
3. **High Parallelism**: Too many actors consuming memory
4. **Barrier Stuck**: Memory cannot be reclaimed without barriers
5. **Memory Leaks**: Rare but possible, check heap profiles

## Additional Context

- OOM is a general problem without uniform cause - always investigate
- Don't just increase memory without understanding the root cause
- Consider cluster sizing if workload legitimately needs more memory

## Reference

- [Memory (Heap) Profiling Guide](https://github.com/risingwavelabs/risingwave/blob/main/docs/dev/src/benchmark-and-profile/memory-profiling.md)
- [RisingWave Troubleshooting](https://docs.risingwave.com/troubleshoot/overview)
