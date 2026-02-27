---
title: "Troubleshoot Iceberg sink issues"
impact: "MEDIUM"
impactDescription: "Restore Iceberg data delivery, fix permission and configuration errors"
tags: ["iceberg", "sink", "s3", "permission", "parquet", "databricks", "vacuum", "time-travel", "snapshot"]
---

## Problem Statement

Iceberg sinks can fail due to S3 permission issues, commit latency, small file problems, and catalog configuration. These issues often manifest as "PermissionDenied" errors when writing parquet files or slow sink performance.

## Common Issues and Solutions

### Issue 1: S3 Permission Denied When Writing Parquet

**Symptoms**:
```
Iceberg error: Unexpected = Failed to close parquet writer
source: PermissionDenied persistent at Writer::write
S3Error code: AccessDenied, message: Access Denied
```

**Causes**:
1. IAM role/policy doesn't have write permission to S3 path
2. S3 bucket policy restricts writes
3. Temporary credentials expired
4. Cross-account access not configured

**Diagnosis**:
```sql
-- Check sink definition for S3 paths
SELECT definition FROM rw_sinks WHERE name = 'my_iceberg_sink';

-- Look at the S3 path in error:
-- uri: https://s3.../metastore/.../tables/.../xxx.parquet
```

**Solutions**:

1. **Verify IAM permissions**:
```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:ListBucket"
  ],
  "Resource": [
    "arn:aws:s3:::your-bucket/*",
    "arn:aws:s3:::your-bucket"
  ]
}
```

2. **Check Unity Catalog / Databricks permissions**:
   - Ensure RisingWave has write access to the external location
   - Verify the table's storage credential

3. **For cross-account S3 access**: Configure bucket policy and IAM trust relationship

### Issue 2: Sink Decoupling and Error Handling

**Note**: When sink decoupling is enabled, Iceberg sink errors don't immediately block the pipeline:
```
reset log reader stream successfully after sink error
```

This means:
- Data is being written to logstore
- Iceberg writes are failing
- Errors are contained to the affected parallelism

**Diagnosis**:
```sql
-- Check if sink is decoupled
SELECT sink_id, is_decouple, name
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id
WHERE connector = 'iceberg';
```

**Solution**: Fix the underlying permission issue; logstore will drain once fixed.

### Issue 3: Small Files Problem

**Symptoms**:
- Too many small parquet files in Iceberg table
- Read performance degradation
- High metadata overhead

**Cause**: Default commit interval is 60 seconds, but high-frequency writes can still create many files.

**Solutions**:

1. **Tune commit checkpoint interval**:
```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  ...
  commit_checkpoint_interval = 300,  -- 5 minutes between commits
);
```

2. **Enable compaction**:
```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  ...
  enable_compaction = true,
  compaction_interval_sec = 10800,  -- 3 hours
);
```

3. **Enable snapshot expiration**:
```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  ...
  enable_snapshot_expiration = true,
  snapshot_expiration_max_age_millis = 3600000,  -- 1 hour
  snapshot_expiration_retain_last = 12,
);
```

### Issue 4: Iceberg Sink Commit Latency

**Symptoms**:
- Barrier latency increasing
- Sink appears slow or stuck

**Cause**: Iceberg commits to S3/catalog can be slow, especially for large transactions.

**Solutions**:

1. **Enable sink decoupling**:
```sql
SET sink_decouple = true;
CREATE SINK my_sink FROM my_mv WITH (...);
```

2. **Increase barrier interval** (if decoupling not possible):
```sql
ALTER SYSTEM SET barrier_interval_ms = 10000;
```

3. **Monitor commit latency in Grafana**:
   - Panel: Sink Commit Latency
   - Alert if consistently > barrier interval

### Issue 5: Iceberg Time Travel Query Errors

**Symptoms**: Unable to query historical snapshots.

**Diagnosis**:
```sql
-- Check available snapshots
SELECT * FROM rw_iceberg_snapshots('my_iceberg_source');

-- Query at specific snapshot
SELECT * FROM my_iceberg_source
FOR SYSTEM_VERSION AS OF 12345678;

-- Query at specific time
SELECT * FROM my_iceberg_source
FOR SYSTEM_TIME AS OF '2025-01-01 12:00:00';
```

**Common issues**:
- Snapshot expired (check expiration settings)
- Time format incorrect
- Snapshot ID doesn't exist

### Issue 6: Iceberg Table Bloat and Storage Growth

**Symptoms**:
- S3 storage costs increasing faster than expected
- Many small data files accumulating
- Slow metadata operations

**Diagnosis**:
```sql
-- Inspect snapshot history to understand commit frequency
SELECT * FROM rw_iceberg_snapshots('my_iceberg_source');

-- Check data file inventory (file count, sizes, record counts)
SELECT * FROM rw_iceberg_files('my_iceberg_source');

-- Check manifest files (metadata overhead)
SELECT * FROM rw_iceberg_manifests('my_iceberg_source');

-- Check table evolution history (schema changes, operations)
SELECT * FROM rw_iceberg_history('my_iceberg_source');
```

**Solutions**:

Note: The diagnostic functions above (`rw_iceberg_snapshots`, `rw_iceberg_files`, etc.) take the RisingWave **source** name as argument. The `VACUUM` commands below operate on the RisingWave **table or sink** name that writes to Iceberg.

1. **Expire old snapshots** (removes outdated versions without rewriting data):
```sql
VACUUM my_iceberg_sink;
```

2. **Full compaction** (rewrites data files then expires snapshots):
```sql
-- WARNING: requires temporary extra disk space
VACUUM FULL my_iceberg_sink;
```

3. **Configure automatic maintenance on the sink** (see Iceberg Sink Configuration Reference below for all options).

### Issue 7: Full-Reload Iceberg Source Refresh Stalled

**Symptoms**: Iceberg source using full reload mode shows stale data.

**Diagnosis**:
```sql
-- Check refresh state for all Iceberg sources using full reload
SELECT * FROM rw_iceberg_refresh_state();
```

If a refresh is stuck, check connectivity and permissions to the upstream Iceberg catalog.

## Iceberg Sink Configuration Reference

```sql
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  type = 'upsert',  -- or 'append-only'
  primary_key = 'id',  -- required for upsert

  -- Catalog configuration
  catalog.type = 'storage',  -- or 'rest', 'glue', 'hive'
  warehouse.path = 's3://bucket/warehouse',
  database.name = 'my_db',
  table.name = 'my_table',

  -- S3 configuration
  s3.region = 'us-east-1',
  s3.access.key = 'xxx',  -- or use IAM role
  s3.secret.key = SECRET my_s3_secret,

  -- Performance tuning
  commit_checkpoint_interval = 60,

  -- Compaction (optional)
  enable_compaction = true,
  compaction_interval_sec = 10800,

  -- Snapshot management (optional)
  enable_snapshot_expiration = true,
  snapshot_expiration_max_age_millis = 3600000,
  snapshot_expiration_retain_last = 12,

  -- Create table if not exists
  create_table_if_not_exists = true
);
```

## Monitoring Iceberg Sinks

```sql
-- Check sink status
SELECT * FROM rw_sinks WHERE name = 'my_iceberg_sink';

-- Check for sink errors in event logs
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SINK%'
ORDER BY timestamp DESC;

-- Check logstore lag (for decoupled sinks)
-- See: cdc-sink-decouple.md for query
```

## Reference

- [Sink to Iceberg](https://docs.risingwave.com/iceberg/deliver-to-iceberg)
- [Iceberg Configuration Options](https://docs.risingwave.com/iceberg/deliver-to-iceberg#configuration-parameters)
- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)
