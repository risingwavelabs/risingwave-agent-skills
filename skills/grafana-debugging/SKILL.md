---
name: grafana-debugging
license: MIT
metadata:
  version: 1.0.0
  author: RisingWave Labs
description: |
  Grafana-based debugging and metrics investigation for RisingWave production systems.

  This skill helps agents with:
  - Using the grafana-cli tool to search dashboards, list panels, and render panel images
  - Systematically traversing RisingWave Grafana dashboards to diagnose issues
  - Interpreting visual metric patterns (spikes, flatlines, sawtooth, gradual climbs)
  - Correlating metrics across multiple dashboards to identify root causes
---

# Grafana Debugging

## Overview

This skill provides a systematic approach to investigating RisingWave production issues through Grafana metrics visualization. It combines a CLI tool for rendering panels with knowledge of which panels to check, in what order, and how to interpret the results.

## When to Use

Apply this skill when:
- Investigating RisingWave streaming performance issues using Grafana
- Diagnosing OOM, barrier stuck, compaction, or sink issues via metrics
- Needing to render and interpret Grafana panel images
- Performing systematic dashboard traversal for root cause analysis

## Prerequisites

The `grafana-cli` tool must be available. Set environment variables:
- `GRAFANA_URL` — Grafana instance URL
- `GRAFANA_API_TOKEN` — Grafana API token with viewer permissions

## Categories

| Category | Priority | Prefix | Description |
|----------|----------|--------|-------------|
| CLI Tool Usage | HIGH | `tool-` | How to invoke grafana-cli commands |
| Investigation Workflows | CRITICAL | `workflow-` | Structured debugging flows from symptom to root cause |
| Dashboard Traversal | CRITICAL | `dashboard-` | Panel sequences for each symptom category |
| Visual Pattern Recognition | HIGH | `visual-` | How to interpret rendered panel images |

## Usage

1. Set up `GRAFANA_URL` and `GRAFANA_API_TOKEN` environment variables
2. Use `grafana-cli search-dashboards` to find the relevant dashboard
3. Use `grafana-cli list-panels` to identify panels for your symptom
4. Use `grafana-cli render-panel` to render and visually inspect
5. Follow the traversal patterns to correlate across dashboards
