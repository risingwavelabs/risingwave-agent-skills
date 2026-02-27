---
title: "Troubleshoot Snowflake sink causing barrier stuck"
impact: "CRITICAL"
impactDescription: "Restore streaming pipeline, prevent complete cluster stall"
tags: ["snowflake", "sink", "barrier", "stuck", "auto-schema-change", "decoupling"]
---

## Problem Statement

Snowflake sinks can cause barrier stuck issues when sink commits take longer than the barrier interval. This is particularly problematic when `auto.schema.change` is enabled, which in RisingWave 2.7 defaults to disabling sink decoupling. When the Snowflake sink commit time exceeds the barrier interval, barriers accumulate and eventually stall the entire streaming pipeline.

**Note**: The default barrier interval is 1000ms (1 second). Check your current setting with `SHOW PARAMETERS;` and look for `barrier_interval_ms`.

## Symptoms

- Barrier latency increasing continuously (visible in Grafana)
- Barrier count accumulating (e.g., 64328 and growing)
- Snowflake sink throughput is very low or appears stuck
- Cluster enters recovery loop if barriers accumulate excessively

## Diagnosis Steps

### Step 1: Check Barrier Metrics

```sql
-- Check current barrier status via Grafana
-- Navigate to: risingwave_dashboard > Streaming > Barrier Latency
-- Look for: Latency > 1 minute or accumulating barrier count
```

### Step 2: Identify Snowflake Sink as Cause

```sql
-- Check sink decoupling status
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id
WHERE connector = 'snowflake';
```

If `is_decouple = false` for Snowflake sinks, they may be blocking barriers.

### Step 3: Check Snowflake Commit Time

In Grafana monitoring, check the average commit time for Snowflake sink. If commit time (e.g., ~6 seconds) exceeds your barrier interval, this causes accumulation.

```sql
-- Check current barrier interval (look for barrier_interval_ms in output)
SHOW PARAMETERS;
```

## Root Cause

In RisingWave 2.7, enabling `auto.schema.change` for Snowflake sink automatically disables sink decoupling. This means:
1. Barriers must wait for Snowflake commits to complete
2. Snowflake pipe flush can take 5-10+ seconds
3. If barrier interval is shorter than commit time, barriers accumulate faster than they complete

## Solutions

### Immediate Recovery

```sql
-- Option 1: Drop the problematic sink and restart cluster
DROP SINK snowflake_sink_name;
-- Restart cluster via cloud console or kubectl

-- Option 2: If drop hangs due to barrier stuck, pause source first
ALTER SOURCE my_source SET source_rate_limit = 0;
DROP SINK snowflake_sink_name;
ALTER SOURCE my_source SET source_rate_limit = default;
```

### Long-term Solutions

#### Solution 1: Increase Barrier Interval (Trade-off: Reduced freshness)

```sql
-- Check current barrier interval (look for barrier_interval_ms in output)
SHOW PARAMETERS;

-- Increase barrier interval to exceed Snowflake commit time
-- If commit takes ~6 seconds, set to 10+ seconds
ALTER SYSTEM SET barrier_interval_ms = 10000;

-- Then recreate the sink
DROP SINK snowflake_sink;
CREATE SINK snowflake_sink FROM my_mv WITH (...);
```

**Note**: Increasing barrier interval reduces data freshness and increases query latency.

#### Solution 2: Enable Sink Decoupling (Recommended if auto.schema.change not needed)

```sql
-- Enable sink decoupling before creating sink
SET sink_decouple = true;

-- Recreate sink without auto.schema.change
CREATE SINK snowflake_sink FROM my_mv WITH (
  connector = 'snowflake',
  -- ... other options
  -- Do NOT set auto.schema.change = 'true'
);
```

#### Solution 3: Upgrade to Latest Version

In newer versions (post-2.7), RisingWave supports auto schema change for decoupled sinks, eliminating this issue.

## Prevention

1. **Monitor Snowflake commit times**: Set up alerts for commit latency
2. **Test sink configuration**: Before production, verify sink decoupling status
3. **Plan for auto.schema.change**: Understand the trade-offs before enabling
4. **Set appropriate barrier interval**: Match to your slowest sink commit time

## Additional Context

- Snowflake sink uses Snowpipe for data ingestion, which has variable commit latency
- Auto schema change requires coupled sink to track schema versions
- This issue affects cluster-wide streaming, not just the Snowflake sink

## Reference

- [Snowflake Sink Connector](https://docs.risingwave.com/integrations/destinations/snowflake)
- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)
