---
title: "Configure and monitor sink decoupling"
impact: "HIGH"
impactDescription: "Prevent barrier blocking, improve streaming stability"
tags: ["sink", "decouple", "connector", "barrier", "logstore"]
---

## Problem Statement

By default, sinks are coupled - barriers wait for data to be committed to external systems. If the external system is slow or unavailable, this blocks the entire streaming pipeline. Sink decoupling writes to an internal logstore first, preventing external systems from blocking barriers.

## Check Sink Decoupling Status

```sql
-- Check which sinks are decoupled
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id;
```

## Enable Sink Decoupling

### For New Sinks

```sql
-- Enable globally before creating sink
SET sink_decouple = true;

CREATE SINK my_sink FROM my_mv WITH (
  connector = 'kafka',
  ...
);
```

### For Existing Sinks

Cannot be changed directly - need to recreate the sink:

```sql
-- Drop and recreate with decoupling
SET sink_decouple = true;
DROP SINK my_sink;
CREATE SINK my_sink FROM my_mv WITH (...);
```

## Monitor Logstore Lag

When decoupled, data goes to logstore before external system. Monitor the lag:

```sql
-- Step 1: Find the internal table name for your sink
SELECT internal_table_name, job_name, job_id
FROM rw_catalog.rw_internal_table_info
WHERE job_name = 'my_sink_name';

-- Example output:
-- internal_table_name                    | job_name  | job_id
-- __internal_public_my_sink_7682_sink_2  | my_sink   | 7682

-- Step 2: Query the logstore lag using the discovered table name
-- Replace __internal_public_my_sink_7682_sink_2 with actual name from Step 1
SELECT
  (now() - to_timestamp(
    ((kv_log_store_epoch >> 16) & 70368744177663) / 1000 + 1617235200
  )) AS lag
FROM __internal_public_my_sink_7682_sink_2
ORDER BY kv_log_store_epoch ASC
LIMIT 1;
```

In Grafana: Check `Log Store Lag` panel.

## When to Use Sink Decoupling

**Enable decoupling when**:
- External system has variable latency
- External system may be temporarily unavailable
- Sink is not critical path (can tolerate eventual consistency)
- Barrier latency is high due to sink blocking

**Keep coupled when**:
- Need strict exactly-once semantics with external system
- External system is fast and reliable
- Storage overhead is a concern (logstore uses disk)

## Troubleshooting Decoupled Sinks

### Logstore Lag Growing

**Symptoms**: Lag increasing over time, data not reaching external system.

**Diagnosis**:
1. Check external system connectivity
2. Check sink error logs
3. Check if external system is rate limiting

**Solution**: Fix external system issues. Logstore will drain once fixed.

### High Storage Usage

**Cause**: Logstore retains data until confirmed delivered.

**Solution**:
- Fix slow/unavailable external system
- Consider sink throughput settings
- Monitor disk usage on compute nodes

### Sink Errors Not Blocking Pipeline

**Note**: With decoupling, sink errors don't immediately block streaming. Check logs regularly for sink issues.

```sql
-- Check for sink-related events
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SINK%'
ORDER BY timestamp DESC;
```

## Sink Types and Decoupling

| Connector | Decoupling Recommended | Notes |
|-----------|----------------------|-------|
| Kafka | Yes | High latency variance |
| JDBC/Postgres | Yes | Database can be slow |
| S3 | Yes | Network latency |
| Iceberg | Yes | Commit can be slow |
| Elasticsearch | Yes | Indexing delays |
| ClickHouse | Depends | Usually fast |

## Additional Context

- Decoupled sinks use compute node local storage for logstore
- Logstore data is checkpointed and survives restarts
- Decoupling adds write amplification (data written twice)
- Consider storage capacity when enabling for high-throughput sinks

## Reference

- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)
- [Connectors Overview](https://docs.risingwave.com/get-started/connectors)
