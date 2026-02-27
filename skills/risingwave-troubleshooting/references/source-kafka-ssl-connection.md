---
title: "Troubleshoot Kafka source SSL/TLS connection issues"
impact: "HIGH"
impactDescription: "Restore Kafka connectivity, enable secure data ingestion"
tags: ["kafka", "source", "ssl", "tls", "certificate", "sasl", "schema-registry"]
---

## Problem Statement

Kafka sources using SSL/TLS can fail to connect due to certificate issues, file path problems, or authentication errors. Common scenarios include missing CA certificates, self-signed certificates in schema registry, and SASL authentication bugs.

## Common Issues and Solutions

### Issue 1: CA Certificate File Not Found

**Symptoms**:
```
ssl.ca.location failed: error:05880002:x509 certificate routines::system lib
ERROR librdkafka: SSL: error:80000002:system library::No such file or directory
```

**Cause**: The CA certificate file path specified in `properties.ssl.ca.location` doesn't exist or isn't mounted in the container.

**Solutions**:

1. **Verify certificate file exists and is mounted**:
```bash
# Check if the file exists in the compute node container
kubectl exec -it compute-node-0 -- ls -la /rwcert/
```

2. **Correct the source definition**:
```sql
CREATE SOURCE my_kafka_source (...)
WITH (
  connector = 'kafka',
  topic = 'my-topic',
  properties.bootstrap.server = 'kafka-broker:9093',
  properties.security.protocol = 'SASL_SSL',
  properties.sasl.mechanism = 'PLAIN',
  properties.sasl.username = '...',
  properties.sasl.password = SECRET my_password,
  -- Ensure this path matches the mounted volume
  properties.ssl.ca.location = '/rwcert/ca.crt'
) FORMAT PLAIN ENCODE JSON;
```

3. **For Kubernetes deployments**: Verify the volume mount in your deployment config:
```yaml
volumeMounts:
  - name: certs
    mountPath: /rwcert
    readOnly: true
volumes:
  - name: certs
    secret:
      secretName: kafka-ca-cert
```

### Issue 2: Schema Registry SSL Certificate Error

**Symptoms**:
```
connector error: all request confluent registry all timeout
error sending request for url https://...
client error Connect: error:0A000086:SSL routines:
tls_post_process_server_certificate:certificate verify failed
self-signed certificate in certificate chain
```

**Cause**: Schema registry uses a self-signed or private CA certificate that isn't trusted.

**Solutions**:

1. **Use the `schema.registry.ssl.ca.location` option** (if supported in your version):
```sql
CREATE SOURCE my_source (...)
WITH (
  connector = 'kafka',
  topic = 'my-topic',
  properties.bootstrap.server = 'kafka:9092',
  ...
) FORMAT PLAIN ENCODE AVRO (
  schema.registry = 'https://schema-registry:8081',
  schema.registry.username = '...',
  schema.registry.password = SECRET sr_password,
  schema.registry.ssl.ca.location = '/rwcert/ca.crt'
);
```

2. **Do NOT disable certificate validation (`schema.registry.ca = 'ignore'`)**:

   Disabling TLS certificate checks for the schema registry (for example by setting
   `schema.registry.ca = 'ignore'`) exposes clients to man-in-the-middle attacks and
   credential interception. This option must **never** be used in production and is
   strongly discouraged even in test environments.

   If your schema registry uses a self-signed or private CA certificate, the recommended
   fix is to:

   - Configure the correct CA bundle via `schema.registry.ssl.ca.location` (see example above), or
   - Upgrade to a RisingWave version that supports `schema.registry.ssl.ca.location`, or
   - Terminate TLS in a trusted proxy that presents a certificate signed by a trusted CA.

**Note**: The `schema.registry.ssl.ca.location` option was added in a later version. Check your RisingWave version for support.

### Issue 3: All Brokers Down Error

**Symptoms**:
```
librdkafka: Global error: AllBrokersDown Local: All broker connections are down: 4/4 brokers are down
```

**Cause**: Various connectivity issues including:
- Network unreachable
- Incorrect `advertised.listeners` configuration in Kafka
- SSL/SASL authentication failures
- Firewall blocking connections

**Diagnosis**:

1. **Check Kafka broker advertised addresses**:
   - The count (e.g., "4/4") includes bootstrap brokers + discovered brokers
   - May show more brokers than your cluster due to metadata discovery

2. **Verify network connectivity**:
```bash
# From compute node
kubectl exec -it compute-node-0 -- nc -zv kafka-broker 9093
```

3. **Check Kafka `advertised.listeners`**:
   - Ensure advertised addresses are reachable from RisingWave pods
   - May need to use internal Kubernetes DNS names

**Solutions**:

1. **Use PrivateLink for cloud deployments**:
```sql
CREATE SOURCE my_source (...)
WITH (
  connector = 'kafka',
  topic = 'my-topic',
  properties.bootstrap.server = 'private-endpoint:9092',
  privatelink.targets = '[{"port": 9092}]',
  privatelink.endpoint = 'vpce-xxxx'
);
```

2. **Enable detailed Kafka logging**:
```bash
# Set rust log level in meta node
rustLog=INFO,librdkafka=debug
```

### Issue 4: SASL/SCRAM Authentication Bug

**Symptoms**: Authentication fails with SASL_SSL and SCRAM mechanism on Kafka 3.8.1+.

**Cause**: Bug in librdkafka fixed in v2.6.1 where client-side nonce was incorrectly concatenated.

**Solution**: Upgrade to RisingWave v2.6.1 or later.

**Reference**: [librdkafka PR #4895](https://github.com/confluentinc/librdkafka/pull/4895)

## Source Parallelism and Partitions

**Best Practice**: Match source parallelism to Kafka topic partition count for optimal performance.

```sql
-- Check current parallelism
SELECT * FROM rw_streaming_parallelism WHERE name = 'my_source';

-- Source throughput is limited by partition count
-- If parallelism > partition count, some executors will be idle
```

## Diagnosis Queries

```sql
-- Check source status
SELECT * FROM rw_sources WHERE name = 'my_source';

-- Check source throughput in Grafana
-- Panel: Source Throughput (rows/s and bytes/s)

-- Check for connection errors in logs
-- Meta node log: source_manager::worker errors
```

## Prevention

1. **Test connectivity before creating source**: Verify CA certs, network, and authentication
2. **Use secrets for credentials**: Don't hardcode passwords in source definitions
3. **Monitor source throughput**: Set alerts for throughput drops
4. **Document certificate paths**: Ensure ops team knows where certs are mounted

## Reference

- [Kafka Source Configuration](https://docs.risingwave.com/ingestion/sources/kafka)
- [Kafka Configuration Options](https://docs.risingwave.com/ingestion/sources/kafka-config)
- [PrivateLink Configuration](https://docs.risingwave.com/ingestion/sources/kafka-config#privatelink-configuration)
