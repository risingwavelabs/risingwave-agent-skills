---
title: "Manage streaming job parallelism and adaptive scaling"
impact: "HIGH"
impactDescription: "Optimize resource usage, prevent scaling-related failures"
tags: ["parallelism", "scaling", "adaptive", "actors", "fragments", "performance"]
---

## Problem Statement

RisingWave's adaptive parallelism can lead to resource exhaustion when running many streaming jobs. By default, new jobs inherit the cluster's total core count as parallelism (e.g., three 48-core nodes = 144 parallelism). With many MVs, this creates too many actors, leading to memory pressure, high barrier latency, and potential OOM.

## Understanding Parallelism

### Key Concepts

- **Parallelism**: Number of parallel execution units for a streaming job
- **Fragment**: A unit of the streaming execution plan
- **Actor**: An instance of a fragment running on a compute node
- **Total actors** = Number of fragments × Parallelism

### Default Behavior

```sql
-- Check default parallelism strategy (look for adaptive_parallelism_strategy in output)
SHOW PARAMETERS;

-- Default: parallelism = total cores across all compute nodes
-- e.g., 3 nodes × 48 cores = 144 default parallelism
```

## Common Issues and Solutions

### Issue 1: Too Many Actors Causing High Memory/Barrier Latency

**Symptoms**:
- High barrier latency (> 1 minute)
- Memory pressure on compute nodes
- Actor count in thousands or tens of thousands

**Diagnosis**:
```sql
-- Check actor count per worker
SELECT worker_id, count(*) AS actor_count
FROM rw_actors
GROUP BY worker_id
ORDER BY actor_count DESC;

-- Check total actors in cluster
SELECT count(*) FROM rw_actors;

-- Recommended: < 400 actors per core
-- Example: 48-core node should have < 19,200 actors
```

**Solution**: Set bounded adaptive parallelism strategy
```sql
-- Limit new jobs to max 32 parallelism
ALTER SYSTEM SET adaptive_parallelism_strategy TO 'Bounded32';

-- Other valid values: 'Bounded8', 'Bounded16', 'Bounded64'
-- Or use 'Auto' for full adaptive (default)

-- Note: If barrier latency is high, restart meta to force the change
```

### Issue 2: Scaling Operation Causes Crash Loop

**Symptoms**:
- Cluster enters recovery loop after scale-in
- `worker not found` errors
- Jobs fail to reschedule

**Cause**: Corner case in RisingWave 2.6 scheduling where old and new scheduling paths interact during scaling.

**Solution** (v2.6.x):
```sql
-- 1. Disable automatic parallelism control
ALTER SYSTEM SET disable_automatic_parallelism_control = true;

-- 2. Restart meta node to apply
-- 3. Wait for recovery to complete

-- 4. Record current parallelism settings
SELECT * FROM rw_streaming_parallelism;

-- 5. For jobs with fixed parallelism, temporarily set to 1
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = 1 DEFERRED;

-- 6. Re-enable automatic control
ALTER SYSTEM SET disable_automatic_parallelism_control = false;

-- 7. Restart meta and wait for recovery
-- 8. Restore original parallelism values
```

**Prevention**: Upgrade to v2.6.3 or later which fixes this corner case.

### Issue 3: Fixed Parallelism Jobs Blocking Scaling

**Symptoms**: Some jobs don't scale with cluster, causing uneven load distribution.

**Diagnosis**:
```sql
-- Check jobs with fixed vs adaptive parallelism
SELECT name, parallelism, max_parallelism
FROM rw_streaming_parallelism
WHERE parallelism != max_parallelism;
```

**Solution**: Convert to adaptive parallelism
```sql
-- Set to adaptive (will use bounded strategy if configured)
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = ADAPTIVE;
```

## Parallelism Configuration

### For New Jobs

```sql
-- Set session-level parallelism before creating job
SET streaming_parallelism = 8;
CREATE MATERIALIZED VIEW my_mv AS ...;

-- Or set cluster-wide default
ALTER SYSTEM SET adaptive_parallelism_strategy TO 'Bounded8';
```

### For Existing Jobs

```sql
-- Change parallelism (takes effect on next recovery)
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = 16;

-- Or use DEFERRED to avoid immediate reschedule
ALTER MATERIALIZED VIEW my_mv SET PARALLELISM = 16 DEFERRED;

-- Trigger recovery to apply DEFERRED changes
RECOVER CLUSTER;
```

### Recommended Settings by Cluster Size

| Cluster Size | Recommended Strategy | Notes |
|--------------|---------------------|-------|
| Small (< 16 cores) | Bounded8 | Prevent resource exhaustion |
| Medium (16-64 cores) | Bounded16 or Bounded32 | Balance throughput and overhead |
| Large (> 64 cores) | Bounded32 or Bounded64 | Allow high throughput jobs |

## Calculating Optimal Parallelism

```sql
-- Check plan complexity
EXPLAIN DISTSQL CREATE MATERIALIZED VIEW my_mv AS ...;
-- Count fragments in output

-- Formula: actors = fragments × parallelism
-- Rule: actors per core < 400 (empirical)

-- Example: 5 fragments, 32 parallelism = 160 actors per job
-- On 48-core node: ~120 jobs before hitting 400 actors/core
```

## Background DDL and Parallelism

When running multiple background DDL jobs concurrently:

```sql
-- Rate limit backfilling to prevent overload
ALTER SYSTEM SET backfill_rate_limit TO 200;
-- This limits backfill to 200 rows/s per parallelism
-- With parallelism=8: 1,600 rows/s total

-- Reset to unlimited after backfill completes
ALTER SYSTEM SET backfill_rate_limit TO DEFAULT;
```

## Monitoring

```sql
-- Check current parallelism settings
SELECT name, parallelism, max_parallelism, status
FROM rw_streaming_parallelism;

-- In Grafana:
-- - Actor Output Blocking Time Ratio (backpressure indicator)
-- - Memory usage per compute node
-- - Barrier latency
```

## Prevention

1. **Set bounded strategy early**: Configure before creating many jobs
2. **Monitor actor counts**: Set alerts for actors per core > 300
3. **Test scaling**: Verify scale-up/down before production
4. **Use DEFERRED for bulk changes**: Avoid multiple immediate reschedules

## Reference

- [Manage a Large Number of Streaming Jobs](https://docs.risingwave.com/operate/manage-a-large-number-of-streaming-jobs)
- [Configure Adaptive Parallelism Strategy](https://docs.risingwave.com/operate/manage-a-large-number-of-streaming-jobs#configure-adaptive-parallelism-strategy)
- [View and Configure System Parameters](https://docs.risingwave.com/operate/view-configure-system-parameters)
