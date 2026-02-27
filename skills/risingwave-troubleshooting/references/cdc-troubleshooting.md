---
title: "Troubleshoot CDC source issues"
impact: "HIGH"
impactDescription: "Restore data ingestion, prevent replication lag accumulation"
tags: ["cdc", "source", "postgres", "mysql", "debezium", "connector"]
---

## Problem Statement

CDC (Change Data Capture) sources can fail for various reasons including timeout, schema changes, offset expiration, and JVM memory issues. Quick diagnosis and resolution is critical to prevent data loss and lag accumulation.

## Common Issues and Solutions

### Issue 1: CDC Fails to Start Within Timeout

**Symptoms**:
```
Debezium streaming source of RW_CDC_xxx failed to start in timeout 30/60
```

**Solution** (RisingWave >= 2.6):
```sql
ALTER SOURCE my_cdc_source CONNECTOR WITH (
  cdc.source.wait.streaming.start.timeout = '120'
);
```

Note: The timeout may not be the root cause - investigate other issues too.

### Issue 2: Auto Schema Change Fails

**Symptoms**: Upstream schema change not appearing in RisingWave.

**Diagnosis**:
```sql
-- Check auto schema change failure events (v2.6+)
SELECT * FROM rw_event_logs
WHERE event_type = 'AUTO_SCHEMA_CHANGE_FAIL'
ORDER BY timestamp DESC;
```

**Solution**:
1. Ensure `auto.schema.change = 'true'` is configured in source
2. Check for unsupported data types (common cause)
3. For SQL Server: Auto schema change not supported, update capture instance manually

### Issue 3: CDC Offset Unavailable

**Symptoms**:
- Source stops consuming (throughput = 0)
- Logs show offset not available upstream

**Cause**: The stored offset has expired in upstream WAL/binlog (e.g., MySQL binlog rotation, MongoDB oplog aged out).

**Solution** (v2.7+):
```sql
-- Reset source to latest offset (DATA LOSS WARNING)
ALTER SOURCE my_source RESET;
RECOVER CLUSTER;
```

**Prevention**: Increase binlog/oplog retention upstream.

### Issue 4: JVM OOM (CDC-caused)

**Symptoms**:
```
ERROR risingwave_connector_node: Producer failure...
java.lang.OutOfMemoryError: Java heap space
```

**Solutions**:
```bash
# Option 1: Increase JVM heap (env var on compute node)
# Default is ~0.07 * remaining memory
JVM_HEAP_SIZE=2g
```

```sql
-- Option 2: Reduce Debezium queue size (v2.7+)
ALTER SOURCE my_source CONNECTOR WITH (
  debezium.max.queue.size = '2000'
);

-- Option 3: Adjust queue memory ratio
ALTER SOURCE my_source CONNECTOR WITH (
  debezium.queue.memory.ratio = '0.3'
);
```

### Issue 5: Null Values During Backfill

**Symptoms**: Some columns show NULL during backfill phase but have data upstream.

**Cause**: Uncommon data types not fully supported during backfill.

**Solution**: Create an issue for the specific data type - this is a known limitation being addressed.

## Postgres-Specific Issues

### Postgres WAL/Replication Lag Increasing

**Diagnosis**:
```sql
-- Check replication slot size on Postgres
SELECT slot_name,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_pretty,
       active
FROM pg_replication_slots;
```

Check if RisingWave is causing the lag:
1. Check source executor's internal state table for LSN updates
2. In v2.7+, view LSN reports in Grafana

**Common causes**:
- Barrier stuck in RisingWave (backpressure to source)
- Network issues between RisingWave and Postgres
- Source rate limited

### Migrating Postgres Host

When upstream Postgres host changes:

```sql
-- 1. Stop writes to original host
-- 2. Pause source
ALTER SOURCE my_source SET source_rate_limit = 0;

-- 3. Take snapshot and restore to new host
-- 4. On new host, recreate publication
-- CREATE PUBLICATION rw_publication FOR TABLE public.my_table;

-- 5. Update secret with new hostname
ALTER SECRET source_db_hostname WITH (backend = 'meta') AS 'new-host.example.com';

-- 6. Resume source
ALTER SOURCE my_source SET source_rate_limit = default;
```

## MySQL-Specific Issues

### Offline Schema Change Fails

**Symptoms**: Schema changes during RisingWave downtime not applied after restart.

**Solution**: Upgrade to v2.6+ which handles offline schema changes.

### Unsigned Type Overflow

**Symptoms**: Unsigned types (e.g., `UNSIGNED BIGINT`) show wrong values.

**Solution**: When defining columns, upcast all unsigned types to larger signed types.

## MongoDB-Specific Issues

### Table Has No Data

**Symptoms**: Newly created MongoDB CDC table is empty.

**Cause**: MongoDB CDC doesn't check connectivity on creation.

**Solution**: Verify connectivity before creating source. v2.7+ will fail creation if connectivity issues exist.

## Diagnosis Queries

```sql
-- Check source status
SELECT * FROM rw_sources WHERE name = 'my_source';

-- Check source throughput in Grafana
-- Panel: Source Throughput

-- Check for source-related events
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SOURCE%' OR event_type LIKE '%CDC%'
ORDER BY timestamp DESC;
```

## Additional Context

- CDC issues often cascade to barrier stuck due to backpressure
- Always check upstream database logs alongside RisingWave logs
- Consider source rate limiting during high-load periods

## Reference

- [Ingest from PostgreSQL CDC](https://docs.risingwave.com/ingestion/sources/postgresql/pg-cdc)
- [Ingest from MySQL CDC](https://docs.risingwave.com/ingestion/sources/mysql/mysql-cdc)
- [Debezium Configuration](https://debezium.io/documentation/reference/stable/connectors/)
