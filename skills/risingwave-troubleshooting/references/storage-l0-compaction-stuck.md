---
title: "Resolve L0 file accumulation and compaction stuck"
impact: "CRITICAL"
impactDescription: "Restore write throughput, prevent system-wide write stops"
tags: ["storage", "compaction", "l0", "hummock", "write-stop", "lsm"]
---

## Problem Statement

RisingWave uses an LSM-tree based storage engine (Hummock). Each compute node flushes L0 files per checkpoint, and background compaction reduces L0 file count. Without sufficient compaction, L0 files accumulate, degrading read performance and eventually triggering "write stop" which halts all streaming.

## Observations

Symptoms of L0 accumulation:
- Increasing barrier latency
- Degraded query performance
- Write stop triggered (system halts)
- Compaction tasks timing out

## Diagnosis

### Step 1: Check LSM Layout

```sql
SELECT compaction_group_id,
       level_id,
       level_type,
       sub_level_id,
       count(*) AS total_file_count,
       round(sum(file_size) / 1024.0) AS total_file_size_kb
FROM rw_catalog.rw_hummock_sstables
GROUP BY compaction_group_id, level_type, level_id, sub_level_id
ORDER BY compaction_group_id, level_id, sub_level_id DESC;
```

**Red flags**:
- L0 (level_id = 0) file count > 100
- Many sub-levels in L0
- Total L0 size growing continuously

### Step 2: Check Write Stop Status

```sql
-- Check compaction group configs including write stop threshold
SELECT * FROM rw_catalog.rw_hummock_compaction_group_configs ORDER BY id;
```

In Grafana: Check `Write Stop Compaction Groups` panel - non-zero indicates write stop active.

### Step 3: Check Compaction Progress

In Grafana:
- `Compaction Task Count`: Tasks pending vs completed
- `Compaction Throughput`: Bytes compacted per second
- `L0 File Count`: Trend over time

## Solutions

### Solution 1: Scale Up Compactors

Increase compactor resources to process L0 files faster:

```bash
# Scale compactor replicas
kubectl scale deployment compactor --replicas=3

# Or increase compactor memory/CPU
# Edit deployment resources
```

### Solution 2: Adjust Compaction Config

Lower thresholds to trigger more aggressive compaction:

```bash
risectl hummock update-compaction-config \
  --compaction-group-ids <GROUP_ID> \
  --enable-emergency-picker true \
  --level0-stop-write-threshold-sub-level-number 300 \
  --tombstone-reclaim-ratio 40 \
  --level0-max-compact-file-number 50
```

Parameters explained:
- `enable-emergency-picker`: Prioritize L0 compaction when backlogged
- `level0-stop-write-threshold-sub-level-number`: When to trigger write stop (increase if premature)
- `tombstone-reclaim-ratio`: Aggressiveness of deleting tombstones
- `level0-max-compact-file-number`: Max files per compaction task

### Solution 3: Identify Heavy State Tables

Find which tables are causing most L0 files:

```sql
-- Find state tables in a compaction group
WITH m AS (
  SELECT jsonb_array_elements(member_tables)::int AS tid
  FROM rw_hummock_compaction_group_configs
  WHERE id = <COMPACTION_GROUP_ID>
),
f AS (
  SELECT table_id, unnest(state_table_ids) AS stid
  FROM rw_fragments
),
t AS (
  SELECT DISTINCT f.table_id AS tid
  FROM m JOIN f ON m.tid = f.stid
)
SELECT n.id, n.name, n.ident
FROM t JOIN (
  SELECT id, name, 'MV' AS ident FROM rw_materialized_views UNION
  SELECT id, name, 'TABLE' FROM rw_tables UNION
  SELECT id, name, 'SINK' FROM rw_sinks
) n ON t.tid = n.id;
```

Consider optimizing or dropping heavy jobs.

### Solution 4: Check for Delete Ratio

High delete ratio in SSTs slows compaction and queries:

```sql
WITH sst_delete_ratio AS (
  SELECT sstable_id,
         compaction_group_id,
         level_id,
         stale_key_count * 1.0 / total_key_count AS delete_ratio,
         jsonb_array_elements_text(table_ids) AS tid
  FROM rw_catalog.rw_hummock_sstables
  WHERE total_key_count > 0
)
SELECT * FROM sst_delete_ratio
WHERE delete_ratio > 0.5
ORDER BY delete_ratio DESC
LIMIT 20;
```

High delete ratio indicates:
- Lots of updates/deletes in source data
- Consider tuning tombstone reclaim settings

## Compaction Write Stop Details

When write stop triggers:
1. LSM shape is marked as abnormal in metadata
2. During store flush, system checks LSM shape
3. If abnormal, store flush blocks
4. This manifests as `store_flush` in await-tree

**Recovery**: Once compaction catches up and LSM shape normalizes, writes resume automatically.

## Monitoring After Fix

After applying fixes, monitor:

```sql
-- Run periodically to check L0 trend
SELECT compaction_group_id, count(*) AS l0_count
FROM rw_hummock_sstables
WHERE level_id = 0
GROUP BY compaction_group_id;
```

L0 count should decrease over time. If not, apply more aggressive fixes.

## Additional Context

- L0 files overlap with each other, requiring merge-sort on reads
- Write stop is a safety mechanism to prevent unbounded L0 growth
- Consider cluster sizing if workload consistently overwhelms compaction

## Reference

- [RisingWave Storage Overview](https://docs.risingwave.com/store/overview)
- [Hummock LSM Storage](https://github.com/risingwavelabs/risingwave/tree/main/src/storage)
