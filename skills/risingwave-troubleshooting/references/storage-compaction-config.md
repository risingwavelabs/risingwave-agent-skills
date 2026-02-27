---
title: "Configure compaction groups and storage settings"
impact: "HIGH"
impactDescription: "Optimize storage performance, prevent write stops"
tags: ["storage", "compaction", "config", "hummock", "tuning", "capacity", "state-table", "meta-snapshot"]
---

## Problem Statement

Compaction configuration significantly impacts storage performance. Misconfigured settings can lead to write stops, slow queries, or excessive resource usage. Understanding and tuning these settings is essential for production workloads.

## View Current Configuration

```sql
-- Check all compaction group configs
SELECT * FROM rw_catalog.rw_hummock_compaction_group_configs ORDER BY id;

-- Check specific metrics
SELECT id,
       compaction_config->>'level0StopWriteThresholdSubLevelNumber' AS write_stop_threshold,
       compaction_config->>'maxBytesForLevelBase' AS level_base_bytes,
       compaction_config->>'maxCompactionBytes' AS max_compaction_bytes
FROM rw_hummock_compaction_group_configs;
```

## Key Configuration Parameters

### Write Stop Threshold

Controls when write stop triggers:

```bash
# Increase threshold to delay write stop (use when compaction is catching up)
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --level0-stop-write-threshold-sub-level-number 300
```

Default: ~200. Increase if premature write stops occur.

### Emergency Picker

Enable aggressive L0 compaction when backlogged:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --enable-emergency-picker true
```

### Max Compact File Number

Control how many files per compaction task:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --level0-max-compact-file-number 50
```

Higher values = larger compaction tasks = more memory but faster L0 drain.

### Tombstone Reclaim

Control aggressiveness of reclaiming deleted data:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --tombstone-reclaim-ratio 40
```

Higher values = more aggressive deletion but more CPU usage.

### Level Base Size

Control when levels trigger compaction:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --max-bytes-for-level-base 536870912  # 512MB
```

## Common Tuning Scenarios

### Scenario 1: Write-Heavy Workload

Optimize for high write throughput:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --enable-emergency-picker true \
  --level0-stop-write-threshold-sub-level-number 400 \
  --level0-max-compact-file-number 100
```

### Scenario 2: Read-Heavy Workload

Optimize for query performance (fewer L0 files):

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --level0-stop-write-threshold-sub-level-number 100 \
  --level0-max-compact-file-number 30
```

Lower thresholds keep L0 smaller but may cause more write stops.

### Scenario 3: High Delete/Update Ratio

When source data has many updates/deletes:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --tombstone-reclaim-ratio 60
```

## Inspect Storage State

### Check Table Physical Size

```sql
SELECT id, total_key_count, total_key_size, total_value_size
FROM rw_catalog.rw_table_stats
ORDER BY total_key_size + total_value_size DESC
LIMIT 20;
```

### Check SST Distribution

```sql
SELECT compaction_group_id,
       level_id,
       count(*) AS file_count,
       round(sum(file_size)/1024/1024) AS size_mb
FROM rw_hummock_sstables
GROUP BY compaction_group_id, level_id
ORDER BY compaction_group_id, level_id;
```

### Check Vnode Distribution

For diagnosing hot spots:

```sql
-- For a specific table
WITH tmp AS (
  SELECT sstable_id,
         substr(key_range_left::text, 11, 4) AS start_vnode,
         substr(key_range_right::text, 11, 4) AS end_vnode,
         round(file_size/1024/1024) AS size_mb,
         jsonb_array_elements_text(table_ids) AS tid
  FROM rw_hummock_sstables
  WHERE level_id > 0
)
SELECT tid, start_vnode, end_vnode, sum(size_mb) AS total_mb
FROM tmp
WHERE tid = '<TABLE_ID>'
GROUP BY tid, start_vnode, end_vnode
ORDER BY total_mb DESC;
```

## Advanced Storage Diagnostics

### Compaction Group Summary

Get an overview of all compaction groups with storage usage:

```sql
-- Summary: total SST counts, sizes, and member table counts per group
SELECT id,
       jsonb_array_length(member_tables) AS table_count,
       compaction_config->>'level0StopWriteThresholdSubLevelNumber' AS write_stop_threshold
FROM rw_hummock_compaction_group_configs
ORDER BY id;
```

### Find Large State Tables in a Compaction Group

Identify storage hotspots for capacity planning:

```sql
-- Find the largest state tables in a specific compaction group
WITH members AS (
  SELECT jsonb_array_elements(member_tables)::int AS tid
  FROM rw_hummock_compaction_group_configs
  WHERE id = <COMPACTION_GROUP_ID>
)
SELECT m.tid, s.total_key_count,
       round((s.total_key_size + s.total_value_size) / 1024.0 / 1024.0) AS size_mb
FROM members m
JOIN rw_table_stats s ON m.tid = s.id
ORDER BY size_mb DESC
LIMIT 20;
```

### SST Delete Ratio Analysis

High delete ratios in SSTs slow compaction and table scans, affecting backfill and batch queries:

```sql
-- Find SSTs with high delete ratios for a specific table
WITH sst_info AS (
  SELECT sstable_id, compaction_group_id, level_id,
         stale_key_count * 1.0 / NULLIF(total_key_count, 0) AS delete_ratio,
         jsonb_array_elements_text(table_ids) AS tid
  FROM rw_hummock_sstables
  WHERE total_key_count > 0
)
SELECT tid, level_id, count(*) AS sst_count,
       round(avg(delete_ratio)::numeric, 3) AS avg_delete_ratio
FROM sst_info
WHERE delete_ratio > 0.5
GROUP BY tid, level_id
ORDER BY avg_delete_ratio DESC;
```

If a table has consistently high delete ratios, increase its `tombstone_reclaim_ratio`.

### L0 Per-Group Statistics

Check L0 sub-level distribution for a specific compaction group:

```sql
SELECT compaction_group_id, sub_level_id,
       count(*) AS file_count,
       round(sum(file_size) / 1024.0 / 1024.0) AS size_mb
FROM rw_hummock_sstables
WHERE level_id = 0 AND compaction_group_id = <GROUP_ID>
GROUP BY compaction_group_id, sub_level_id
ORDER BY sub_level_id DESC;
```

### Find Streaming Jobs in a Compaction Group

Useful for impact analysis when investigating compaction issues:

```sql
WITH members AS (
  SELECT jsonb_array_elements(member_tables)::int AS tid
  FROM rw_hummock_compaction_group_configs
  WHERE id = <COMPACTION_GROUP_ID>
),
frags AS (
  SELECT DISTINCT table_id
  FROM rw_fragments, unnest(state_table_ids) AS stid
  WHERE stid = ANY(SELECT tid FROM members)
)
SELECT n.id, n.name, n.kind
FROM frags f
JOIN (
  SELECT id, name, 'MV' AS kind FROM rw_materialized_views UNION
  SELECT id, name, 'TABLE' FROM rw_tables UNION
  SELECT id, name, 'SINK' FROM rw_sinks UNION
  SELECT id, name, 'SOURCE' FROM rw_sources
) n ON f.table_id = n.id;
```

### Meta Snapshot Information

Track metadata snapshots for recovery and point-in-time restore:

```sql
-- View meta snapshots (used for cluster recovery)
SELECT * FROM rw_meta_snapshot ORDER BY snapshot_id DESC;
```

## Additional Context

- Configuration changes take effect immediately for new compaction tasks
- Existing compaction tasks continue with old config
- Monitor for 10-15 minutes after changes to see impact
- Each compaction group can have different settings

## Reference

- [RisingWave System Parameters](https://docs.risingwave.com/operate/view-configure-system-parameters)
- [Node-Specific Configurations](https://docs.risingwave.com/deploy/node-specific-configurations)
