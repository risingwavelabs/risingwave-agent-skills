---
title: "Use grafana-cli to search, list, and render Grafana panels"
impact: "HIGH"
impactDescription: "Enables visual metrics inspection without browser access"
tags: ["grafana", "cli", "render", "panel", "dashboard", "tool"]
---

## Problem Statement

Agents troubleshooting RisingWave production issues need to inspect Grafana metrics visually, but don't have browser access. The `grafana-cli` tool bridges this gap by searching dashboards, listing panels, and rendering individual panels to PNG images that agents can read and interpret.

## Best Practice

### Setup

Set required environment variables before using the tool:

```bash
export GRAFANA_URL="https://your-grafana-instance.com"
export GRAFANA_API_TOKEN="your-api-token-here"
```

The API token needs at minimum Viewer permissions on the dashboards you want to inspect.

### Command 1: Search Dashboards

Find dashboards by name:

```bash
grafana-cli search-dashboards --query "risingwave"
```

Output (JSON to stdout):
```json
[
  {
    "id": 1,
    "uid": "EpkBw5W4k",
    "title": "risingwave_dev_dashboard",
    "uri": "db/risingwave-dev-dashboard",
    "url": "/d/EpkBw5W4k/risingwave-dev-dashboard",
    "type": "dash-db",
    "tags": ["risingwave"],
    "isStarred": false
  }
]
```

Use the `uid` value from the output for subsequent commands.

### Command 2: List Panels

List all panels in a dashboard, or search by title:

```bash
# List all panels
grafana-cli list-panels --dashboard EpkBw5W4k

# Search for specific panels
grafana-cli list-panels --dashboard EpkBw5W4k --search "barrier latency"
```

Output (JSON to stdout):
```json
[
  {
    "id": 42,
    "title": "Barrier Latency",
    "description": "End-to-end barrier latency"
  }
]
```

The `--search` flag uses fuzzy matching — partial words work (e.g., "sst" matches "SSTable Count"). Returns up to 5 best matches.

### Command 3: Render Panel

Render a specific panel to a PNG image:

```bash
grafana-cli render-panel \
  --dashboard EpkBw5W4k \
  --panel 42 \
  --from now-1h \
  --to now \
  --var namespace=rwc-xxx-cluster-name \
  --var datasource=prometheus \
  --out barrier-latency.png
```

The command prints the output file path to stdout. Agents can then read the PNG image file to visually inspect the metric.

**Default values:**
- `--from`: `now-15m`
- `--to`: `now`
- `--width`: `1000`
- `--height`: `500`
- `--out`: `./panel-<id>.png`

### Common Variable Patterns for RisingWave

Most RisingWave Grafana dashboards use template variables:

```bash
# Specify the namespace (required for most dashboards)
--var namespace=rwc-xxx-cluster-name

# Specify the datasource
--var datasource=prometheus

# Multiple variables
--var namespace=rwc-xxx --var datasource=prometheus
```

## Additional Context

- **Cold cache retry**: The CLI automatically retries once (after 3 seconds) if the first render returns a suspiciously small image. This handles Grafana's cold PromQL cache where the first render warms the cache and the second gets actual data.
- **Time range tips**: Use `now-15m` for active/recent issues, `now-1h` for the last hour's context, `now-6h` for pattern analysis, `now-24h` for trend analysis.
- **Grafana image renderer**: The `render-panel` command requires the [Grafana Image Renderer](https://grafana.com/grafana/plugins/grafana-image-renderer/) plugin to be installed on the Grafana server.
- **File naming**: When investigating an issue, use descriptive output names (e.g., `barrier-latency-1h.png`, `memory-usage-24h.png`) to keep track of multiple renders.

## Reference

- [Grafana HTTP API - Dashboard](https://grafana.com/docs/grafana/latest/developers/http_api/dashboard/)
- [Grafana Image Rendering](https://grafana.com/docs/grafana/latest/setup-grafana/image-rendering/)
