---
title: "Troubleshoot JDBC sink connection issues"
impact: "HIGH"
impactDescription: "Restore sink connectivity, prevent data delivery failures"
tags: ["jdbc", "sink", "postgres", "mysql", "connection", "timeout", "keepalive"]
---

## Problem Statement

JDBC sinks can experience connection issues including "Timer already cancelled" errors, connection timeouts, and connection closures. These issues are often caused by idle connection timeouts from managed database services (like AWS RDS) or network configurations that drop idle connections.

## Common Issues and Solutions

### Issue 1: Timer Already Cancelled Error

**Symptoms**:
```
java.lang.IllegalStateException: Timer already cancelled
at java.base/java.util.Timer.sched(Timer.java:409)
at org.postgresql.jdbc.PgConnection.addTimerTask(...)
```

Followed by:
```
org.postgresql.util.PSQLException: This connection has been closed
```

**Cause**: The JDBC connection was closed by the database or network due to idle timeout, but the sink tries to use a stale connection.

**Solution** (RisingWave >= 2.7):

Configure TCP keepalive parameters for MySQL/MariaDB sinks:
```sql
CREATE SINK my_jdbc_sink FROM my_mv WITH (
  connector = 'jdbc',
  jdbc.url = 'jdbc:mysql://...',
  -- Enable TCP keepalive (default: true)
  'jdbc.tcp.keep.alive' = 'true',
  -- Keepalive time in milliseconds (e.g., 5 minutes)
  'jdbc.tcp.keep.alive.time.ms' = '300000',
  -- Keepalive interval in milliseconds
  'jdbc.tcp.keep.alive.interval.ms' = '30000',
  -- Keepalive probe count
  'jdbc.tcp.keep.alive.count' = '3',
  ...
);
```

**Note**: These TCP keepalive options are only supported for MySQL and MariaDB JDBC sinks as of the PR introducing them.

**Workaround for PostgreSQL JDBC**:

Consider using the native PostgreSQL sink instead of JDBC sink:
```sql
CREATE SINK my_pg_sink FROM my_mv WITH (
  connector = 'postgres',
  host = '...',
  port = '5432',
  ...
);
```

### Issue 2: Connection Timeout During Write

**Symptoms**:
```
timeout error when writing to downstream PG
```

**Cause**: Downstream database is overloaded, network latency, or connection pool exhaustion.

**Solutions**:

1. **Adjust query timeout**:
```sql
CREATE SINK my_sink FROM my_mv WITH (
  connector = 'jdbc',
  'jdbc.query.timeout' = '60',  -- seconds, default is 60
  ...
);
```

2. **Check downstream database health**:
   - Monitor CPU, memory, and connection count
   - Check for long-running queries or locks
   - Verify network connectivity

3. **Enable sink decoupling** to prevent connection issues from blocking the pipeline:
```sql
SET sink_decouple = true;
CREATE SINK my_sink FROM my_mv WITH (...);
```

### Issue 3: Deadlock Detected in Downstream Database

**Symptoms**:
```
ERROR: deadlock detected
Process X waits for ShareLock on transaction Y blocked by process Z
```

**Cause**: Multiple sink parallelism writing to the same rows causing downstream database deadlocks.

**Solutions**:

1. **Reduce sink parallelism**:
```sql
-- Set parallelism before creating sink
SET streaming_parallelism = 1;
CREATE SINK my_sink FROM my_mv WITH (...);
```

2. **Ensure proper primary key ordering**:
   - The sink's write order should align with the downstream table's primary key
   - Consider partitioning writes to avoid conflicts

3. **Add retry logic** (handled automatically by RisingWave with logstore rewind)

### Issue 4: Sink Rate Limit Data Loss (v2.6.0)

**Symptoms**: Missing rows in downstream database when sink rate limit is set.

**Cause**: Known corner case in v2.6.0 where sink rate limit can cause data loss.

**Solution**: Upgrade to v2.6.1 or later.

**Workaround to re-sink missing rows**:
```sql
-- Issue UPDATE on missing rows to trigger re-sink
UPDATE my_table SET some_column = some_column WHERE id IN (...);
```

## Native PostgreSQL Sink vs JDBC Sink

| Aspect | Native PG Sink | JDBC Sink |
|--------|---------------|-----------|
| Performance | Generally better | Standard |
| Keepalive | OS-level | Configurable (MySQL/MariaDB only) |
| Foreign Keys | May have issues | Supported |
| Maturity | Some edge case bugs | More tested |

**Recommendation**: Start with native PG sink for PostgreSQL, fall back to JDBC if you encounter issues with foreign key constraints or specific edge cases.

## Diagnosis Queries

```sql
-- Check sink status
SELECT * FROM rw_sinks WHERE name = 'my_sink';

-- Check sink-related events
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SINK%'
ORDER BY timestamp DESC;

-- Check if sink is decoupled
SELECT sink_id, is_decouple, name, connector
FROM rw_sink_decouple a
JOIN rw_sinks b ON a.sink_id = b.id;
```

## Prevention

1. **Enable sink decoupling** for production sinks to external databases
2. **Monitor downstream database** health and connection counts
3. **Set appropriate timeouts** based on your network latency
4. **Test failover scenarios** before production deployment

## Reference

- [JDBC Sink Connector](https://docs.risingwave.com/integrations/destinations/mysql)
- [PostgreSQL Sink Connector](https://docs.risingwave.com/integrations/destinations/postgresql)
- [Sink Decoupling](https://docs.risingwave.com/delivery/overview#sink-decoupling)
