---
title: "Diagnose and resolve pod health issues"
impact: "CRITICAL"
impactDescription: "Restore cluster availability, prevent service outages"
tags: ["cluster", "kubernetes", "pod", "health", "crashloop", "pending"]
---

## Problem Statement

Pod health issues (not healthy, pending, crashlooping) can cause service disruption. Quick diagnosis and resolution is essential to maintain cluster availability.

## Common Pod States and Solutions

### State 1: RisingWavePodNotHealthy

**Symptoms**: Pod is running but failing health checks.

**Diagnosis**:
```bash
kubectl describe pod <pod-name> -n <namespace>
kubectl logs <pod-name> -n <namespace> --tail=100
```

**Common causes**:
1. **Extension image missing** - Container image not available
2. **Resource exhaustion** - CPU/memory limits hit
3. **Startup probe timeout** - Service taking too long to start

**Solutions**:
```bash
# Check events
kubectl get events -n <namespace> --sort-by='.lastTimestamp'

# If image missing, trigger rebuild
# Check container registry for image availability

# If resource exhaustion, check limits
kubectl get pod <pod-name> -n <namespace> -o yaml | grep -A 10 resources
```

### State 2: RisingWavePodPending

**Symptoms**: Pod stuck in Pending state, not scheduled.

**Diagnosis**:
```bash
kubectl describe pod <pod-name> -n <namespace>
# Look for "Events" section at the bottom
```

**Common causes and solutions**:

1. **Insufficient resources**:
```bash
# Check node resources
kubectl describe nodes | grep -A 5 "Allocated resources"
# Solution: Scale nodes or reduce pod resource requests
```

2. **PVC pending**:
```bash
kubectl get pvc -n <namespace>
# Solution: Check storage class, ensure volume can be provisioned
```

3. **Node selector/affinity not satisfied**:
```bash
kubectl get pod <pod-name> -o yaml | grep -A 10 nodeSelector
# Solution: Ensure nodes with matching labels exist
```

4. **Taints and tolerations**:
```bash
kubectl describe nodes | grep Taints
# Solution: Add tolerations to pod spec if needed
```

### State 3: RisingWavePodCrashLooping

**Symptoms**: Pod repeatedly starting and crashing.

**Diagnosis**:
```bash
# Check crash logs
kubectl logs <pod-name> -n <namespace> --previous

# Check exit code
kubectl describe pod <pod-name> | grep -A 5 "Last State"
```

**Exit codes**:
- **Exit 137 (OOM Killed)**: Out of memory
- **Exit 1**: Application error
- **Exit 255**: Unknown/generic failure

**Solutions by exit code**:

**OOM (137)**:
```yaml
# Increase memory limits in deployment
resources:
  limits:
    memory: "8Gi"  # Increase as needed
```
See [perf-compute-node-oom](./perf-compute-node-oom.md) for detailed OOM troubleshooting.

**Application Error (1)**:
```bash
# Check logs for panic or error messages
kubectl logs <pod-name> --previous | grep -i "panic\|error\|fatal"
```

### State 4: Pod Phase Unknown

**Symptoms**: Pod shows "Unknown" phase.

**Cause**: Usually node communication issues.

**Diagnosis**:
```bash
# Check node status
kubectl get nodes
kubectl describe node <node-name>
```

**Solutions**:
```bash
# If node is NotReady, may need to drain and replace
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
# Then delete the node and let autoscaler provision new one
```

## Component-Specific Issues

### Meta Node CrashLooping

**Critical**: Meta is the control plane - issues cascade everywhere.

```bash
# Check meta logs
kubectl logs meta-0 --previous

# Common issues:
# - ETCD connection failure
# - Insufficient resources
# - State corruption (rare)
```

### Compute Node CrashLooping

Most often OOM or panic in streaming operators.

```bash
# Check if OOM
kubectl describe pod compute-0 | grep OOMKilled

# Check for panics
kubectl logs compute-0 --previous | grep panic
```

### Compactor CrashLooping

Usually resource issues or object store connectivity.

```bash
# Check compactor logs
kubectl logs compactor-0 --previous

# Verify object store access
# Check AWS/GCS/Azure credentials and connectivity
```

## Emergency Recovery

### Force Delete Stuck Pod

```bash
kubectl delete pod <pod-name> -n <namespace> --force --grace-period=0
```

### Recreate Node

When node is unhealthy:
```bash
# Drain the node
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# Delete the node
kubectl delete node <node-name>

# If using autoscaler, new node will be provisioned
# Otherwise, manually provision replacement
```

### Check Cloud Provider Status

External issues affecting pod health:

```bash
# Check node conditions
kubectl describe node <node-name> | grep -A 10 Conditions

# Network issues
# Disk pressure
# Memory pressure
```

## Monitoring Pod Health

```bash
# Watch pod status
kubectl get pods -n <namespace> -w

# Check all pod events
kubectl get events -n <namespace> --sort-by='.lastTimestamp' | tail -50
```

## Additional Context

- Pod health issues often have cascading effects
- Meta node issues affect the entire cluster
- Always check events and logs together
- Consider cluster autoscaling for resource issues

## Reference

- [Kubernetes Troubleshooting](https://kubernetes.io/docs/tasks/debug/)
- [RisingWave Cloud](https://docs.risingwave.com/cloud/intro)
