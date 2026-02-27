# Claude Code Instructions

This file contains instructions for Claude Code when working on this repository.

## Project Overview

This repository contains AI assistant skills for RisingWave troubleshooting and best practices. Skills are defined as markdown files in the `skills/` directory.

## Build Requirements

### IMPORTANT: After modifying skill files, you MUST run the build

Whenever you add, modify, or delete files in `skills/*/references/*.md`, you **must** run:

```bash
npm run build
```

This regenerates the `AGENTS.md` files which aggregate skill content. The CI will fail if `AGENTS.md` is out of sync with the source markdown files.

### Workflow for Adding or Modifying Skills

1. Create or edit files in `skills/<skill-name>/references/`
2. Run `npm run build` to regenerate `AGENTS.md`
3. Commit both the modified skill files AND the regenerated `AGENTS.md`
4. Push and create PR

### Validation

Before committing, you can validate the skill format:

```bash
npm run validate
```

## Skill File Format

Each skill reference file must include YAML frontmatter:

```yaml
---
title: "Action-oriented title"
impact: "CRITICAL|HIGH|MEDIUM|LOW"
impactDescription: "Quantified benefit"
tags: ["searchable", "terms"]
---
```

See `CONTRIBUTING.md` for detailed guidelines.

## Common CI Failure

If CI fails with:
```
AGENTS.md is out of sync. Run 'npm run build' and commit the changes.
```

Fix by running:
```bash
npm run build
git add skills/*/AGENTS.md
git commit --amend --no-edit
git push --force-with-lease
```

## RisingWave Configuration Verification

When writing troubleshooting skills that reference RisingWave configuration:

1. Verify default values against the RisingWave source code at https://github.com/risingwavelabs/risingwave
2. For **system parameters** (cluster-wide, set via `ALTER SYSTEM SET`): Use `SHOW PARAMETERS;` to check values
3. For **session variables** (session-specific, set via `SET`): Use `SHOW <variable>;` (e.g., `SHOW background_ddl;`)
4. Reference official documentation at https://docs.risingwave.com/
