---
title: "Manage connections and secrets for external systems"
impact: "HIGH"
impactDescription: "Secure credential management, prevent connectivity failures"
tags: ["connection", "secret", "credential", "kafka", "jdbc", "iceberg", "privatelink", "security"]
---

## Problem Statement

RisingWave sources and sinks connect to external systems (Kafka, databases, object storage, Iceberg catalogs) using credentials and connection configurations. Managing these connections and secrets correctly prevents credential leaks, connectivity failures, and simplifies rotation.

## Connections

Connections define reusable network configurations (e.g., PrivateLink, SSH tunnels) that can be shared across multiple sources and sinks.

### List all connections

```sql
-- View all connections with their types and properties
SELECT * FROM rw_connections;
```

### Inspect a connection

```sql
SHOW CREATE CONNECTION my_kafka_connection;
```

### Create a PrivateLink connection

```sql
CREATE CONNECTION my_privatelink WITH (
  type = 'privatelink',
  provider = 'aws',
  service_name = 'com.amazonaws.vpce.us-east-1.vpce-svc-xxxx'
);
```

### Drop a connection

```sql
-- All dependent sources and sinks must be removed first
DROP CONNECTION my_kafka_connection;

-- Or drop with CASCADE (not supported for Iceberg connections)
DROP CONNECTION my_kafka_connection CASCADE;

-- Safe drop (no error if it doesn't exist)
DROP CONNECTION IF EXISTS my_kafka_connection;
```

### Troubleshooting connection issues

If a source or sink fails with connectivity errors:

```sql
-- 1. Check which connection the source/sink uses
SHOW CREATE SOURCE my_kafka_source;
-- Look for CONNECTION clause in the output

-- 2. Verify the connection exists and is configured correctly
SHOW CREATE CONNECTION my_connection;

-- 3. Check for errors in event logs
SELECT * FROM rw_event_logs
WHERE event_type LIKE '%SOURCE%' OR event_type LIKE '%SINK%'
ORDER BY timestamp DESC LIMIT 20;
```

## Secrets

Secrets store sensitive values (passwords, API keys, tokens) that are referenced by sources and sinks. Secret values are never displayed after creation.

### List all secrets

```sql
-- Shows secret names only (values are never displayed)
SELECT * FROM rw_secrets;
```

### Create a secret

```sql
CREATE SECRET my_kafka_password WITH ('actual-password-value');

CREATE SECRET my_s3_access_key WITH ('AKIAIOSFODNN7EXAMPLE');
CREATE SECRET my_s3_secret_key WITH ('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
```

### Use secrets in sources and sinks

```sql
-- Reference a secret in a source definition
CREATE SOURCE my_kafka_source (...)
WITH (
  connector = 'kafka',
  properties.bootstrap.server = 'broker:9092',
  properties.sasl.mechanism = 'PLAIN',
  properties.sasl.username = 'my-user',
  properties.sasl.password = SECRET my_kafka_password
);

-- Reference secrets in a sink definition
CREATE SINK my_iceberg_sink FROM my_mv WITH (
  connector = 'iceberg',
  s3.access.key = SECRET my_s3_access_key,
  s3.secret.key = SECRET my_s3_secret_key,
  ...
);
```

### Drop a secret

```sql
DROP SECRET my_kafka_password;
```

**Note**: You cannot drop a secret that is currently referenced by an active source or sink. Drop the dependent objects first.

### Rotating secrets

Use `ALTER SECRET` to update a secret's value in place:

```sql
ALTER SECRET my_kafka_password AS 'new-password-value';
```

**Important**: Altering a secret does not take effect in running streaming jobs until they are restarted. Existing sources and sinks continue using the old credential value until the next restart or recovery.

If `ALTER SECRET` is not available (older RisingWave versions), rotate by recreating:

1. Create a new secret with the updated value
2. Recreate the source/sink referencing the new secret
3. Drop the old secret

```sql
-- 1. Create new secret
CREATE SECRET my_kafka_password_v2 WITH ('new-password-value');

-- 2. Recreate the source (will trigger backfill for MVs downstream)
DROP SOURCE my_kafka_source CASCADE;
CREATE SOURCE my_kafka_source (...)
WITH (
  ...
  properties.sasl.password = SECRET my_kafka_password_v2
);

-- 3. Drop old secret
DROP SECRET my_kafka_password;
```

**Important**: Dropping a source with CASCADE also drops all downstream MVs. Plan for backfill time when rotating credentials on critical sources.

## Connector Lifecycle Management

Sources and tables with connectors have additional lifecycle operations beyond secrets and connections.

### Updating Connector Properties (Without Secrets)

Use `ALTER SOURCE ... CONNECTOR WITH` or `ALTER TABLE ... CONNECTOR WITH` to update connector properties without recreating the source or table. This works for any connector type (Kafka, Kinesis, CDC, etc.):

```sql
-- Rotate plaintext credentials on a Kafka source
ALTER SOURCE my_kafka_source CONNECTOR WITH (
  'properties.sasl.username' = 'new-user',
  'properties.sasl.password' = 'new-password'
);

-- Update broker address for a Kafka source
ALTER SOURCE my_kafka_source CONNECTOR WITH (
  'properties.bootstrap.server' = 'new-broker:9092'
);

-- Update properties on a table with connector
ALTER TABLE my_cdc_table CONNECTOR WITH (
  'hostname' = 'new-db-host.example.com',
  'password' = 'new-password'
);
```

**Important**: After altering connector properties, run `RECOVER;` (requires superuser) to force streaming jobs to pick up the new values. Without recovery, existing actors may continue using cached old values.

**Note**: `CONNECTOR WITH` updates **plaintext** properties. If the source uses `SECRET` references, use `ALTER SECRET` instead (see [Rotating secrets](#rotating-secrets) above).

### Dropping a Connector from a Table

If a table with a connector needs to become a standalone table (e.g., the upstream source was permanently deleted):

```sql
ALTER TABLE my_cdc_table DROP CONNECTOR;
```

**Warning**: This is **irreversible** — you cannot re-add a connector to a table after dropping it. The table becomes a regular RisingWave table that only accepts DML inserts.

**When to use**: When the external stream (e.g., a Kafka topic or CDC source) has been permanently deleted and the table is receiving `ResourceNotFoundException` or similar errors that stall the streaming graph. Dropping the connector stops the error loop while preserving the existing data and downstream MVs.

### Handling Deleted External Streams

If an external stream (Kafka topic, database table for CDC) is deleted while a RisingWave source or table references it, the connector will repeatedly fail with errors like `ResourceNotFoundException`, `UnknownTopicOrPartition`, or similar. This can cause barrier stalls.

**Resolution options:**
1. **Recreate the external stream** with the same name/configuration — the connector will reconnect automatically on the next recovery
2. **Drop the connector** (for tables only): `ALTER TABLE my_table DROP CONNECTOR;` — preserves data but stops ingestion
3. **Drop the source/table**: `DROP SOURCE my_source CASCADE;` — removes the source and all downstream MVs
4. **Pause ingestion temporarily**: `ALTER SOURCE my_source SET source_rate_limit = 0;` — stops reading but the error may still occur during barrier processing

## Best Practices

1. **Always use SECRET for credentials** — Avoids plaintext passwords in DDL definitions visible in `SHOW CREATE`
2. **Use connections for shared network config** — Avoid duplicating PrivateLink/SSH settings across sources
3. **Name secrets descriptively** — Include the service and purpose, e.g., `kafka_prod_sasl_password`
4. **Audit secrets periodically** — List secrets and verify each is still in use
5. **Use `CONNECTOR WITH` for non-secret property changes** — Avoids full source recreation and downstream backfill
6. **Always `RECOVER` after connector property changes** — Ensures running actors pick up the new values

## Reference

- [CREATE SECRET](https://docs.risingwave.com/sql/commands/sql-create-secret)
- [ALTER SECRET](https://docs.risingwave.com/sql/commands/sql-alter-secret)
- [CREATE CONNECTION](https://docs.risingwave.com/sql/commands/sql-create-connection)
- [PrivateLink Configuration](https://docs.risingwave.com/ingestion/sources/kafka-config#privatelink-configuration)
