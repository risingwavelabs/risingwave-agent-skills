# Contributing to RisingWave Agent Skills

Thank you for your interest in contributing to RisingWave Agent Skills! This guide will help you get started.

## Getting Started

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   npm install
   cd packages/skills-build && npm install && cd ../..
   npm run build:tools
   ```

## Adding a New Reference

References are individual best practice documents within a skill.

### 1. Copy the Template

```bash
cp skills/_template/references/_template.md skills/your-skill/references/prefix-topic-name.md
```

### 2. Fill in the Content

Each reference file must include:

**Frontmatter (required):**
```yaml
---
title: "Action-oriented title"
impact: "CRITICAL|HIGH|MEDIUM|LOW"
impactDescription: "Quantified benefit"
tags: ["searchable", "terms"]
---
```

**Content Sections (required):**
- `## Problem Statement` - Why this matters
- `## Incorrect Example` or `## Anti-Pattern` - What to avoid
- `## Correct Example` or `## Best Practice` - The recommended approach

**Optional Sections:**
- `## Additional Context` - Edge cases, trade-offs
- `## Reference` - Links to documentation

### 3. Validate and Build

```bash
npm run validate
npm run build
```

**Important:** `npm run build` regenerates the `AGENTS.md` files. You must commit the updated `AGENTS.md` along with your changes — CI will fail if they are out of sync.

### 4. Submit a Pull Request

Ensure all checks pass before submitting.

## Creating a New Skill

### 1. Create the Skill Directory

```bash
mkdir -p skills/your-skill-name/references
```

### 2. Create Required Files

Copy from the template:
```bash
cp skills/_template/SKILL.md skills/your-skill-name/
cp skills/_template/_sections.md skills/your-skill-name/
cp skills/_template/README.md skills/your-skill-name/
```

### 3. Update SKILL.md

Fill in the frontmatter:
```yaml
---
name: your-skill-name
license: MIT
metadata:
  version: 1.0.0
  author: Your Name
description: |
  Description of your skill.
---
```

### 4. Define Sections

Update `_sections.md` with your categories:
```
- prefix1- | Category Name | CRITICAL
- prefix2- | Another Category | HIGH
```

### 5. Add References

Add reference files following the naming convention:
- `prefix1-topic-name.md`
- `prefix2-another-topic.md`

### 6. Register in marketplace.json

Add your skill to `.claude-plugin/marketplace.json`:
```json
{
  "plugins": [
    {
      "name": "your-skill-name",
      "description": "Your skill description",
      "source": "./",
      "strict": false,
      "skills": "./skills/your-skill-name"
    }
  ]
}
```

### 7. Validate, Build, and Test

```bash
npm run validate
npm run build
npm run test:sanity
```

**Important:** `npm run build` regenerates the `AGENTS.md` files. You must commit the updated `AGENTS.md` along with your changes — CI will fail if they are out of sync.

## Writing Guidelines

### Impact Levels

- **CRITICAL**: Core functionality, security, or major performance (10x+ improvement)
- **HIGH**: Significant performance or reliability improvements
- **MEDIUM**: Good practices with moderate benefits
- **LOW**: Nice-to-have optimizations

### Code Examples

- Show concrete, runnable examples
- Include comments explaining the "why"
- Quantify improvements where possible (e.g., "3x faster", "50% less memory")

### Tags

Use consistent, searchable tags:
- Technology-specific: `streaming`, `materialized-view`, `connector`
- Concern-specific: `performance`, `memory`, `latency`
- Pattern-specific: `join`, `aggregation`, `window`

## Code of Conduct

Be respectful and constructive. All contributions are subject to the project's MIT license.

## Questions?

Open a discussion or issue on GitHub.
