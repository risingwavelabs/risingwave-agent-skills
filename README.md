# RisingWave Agent Skills

Official RisingWave agent skills for Claude Code, Claude Desktop, OpenAI Codex, GitHub Copilot, Cursor, and other AI coding assistants.

Agent skills are folders of instructions, scripts, and resources that AI coding agents can discover and use to work with RisingWave more effectively.

## Available Skills

| Skill | Description | References | Impact |
|-------|-------------|------------|--------|
| [risingwave-troubleshooting](skills/risingwave-troubleshooting/) | Production troubleshooting guides for barrier stuck, OOM, compaction, CDC, sinks, joins, MV design, DML, and cluster operations | 28 | 9 CRITICAL, 17 HIGH, 2 MEDIUM |
| [performance-tuning](skills/performance-tuning/) | Streaming SQL edge cases, MV architecture anti-patterns, EXPLAIN analysis workflow, and pre-deployment review checklist | 4 | 2 CRITICAL, 2 HIGH |
| [grafana-debugging](skills/grafana-debugging/) | Grafana-based debugging with CLI tool for rendering panels, dashboard traversal patterns, and visual metric interpretation | 4 | 2 CRITICAL, 2 HIGH |

## Installation

First, clone or download this repository:

```bash
git clone https://github.com/risingwavelabs/agent-skills.git
```

Then follow the instructions for your AI assistant below. The examples use `risingwave-troubleshooting` — repeat for any other skills you want to install (`performance-tuning`, `grafana-debugging`).

---

### Claude Code

Claude Code automatically discovers skills in `.claude/skills/` directories.

**Method 1: Copy to Skills Directory (Recommended)**

```bash
# Navigate to your RisingWave project
cd /path/to/your/project

# Create the skills directory
mkdir -p .claude/skills/

# Copy the skill(s) you need
cp -r /path/to/agent-skills/skills/risingwave-troubleshooting .claude/skills/
cp -r /path/to/agent-skills/skills/performance-tuning .claude/skills/
cp -r /path/to/agent-skills/skills/grafana-debugging .claude/skills/
```

Claude Code will automatically load the skills when working on relevant tasks.

**Method 2: Import in CLAUDE.md**

Add to your project's `CLAUDE.md` or `.claude/CLAUDE.md`:

```markdown
## RisingWave Troubleshooting Knowledge
@/path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md
```

**Method 3: Add as Rules (Always Loaded)**

```bash
# Create rules directory
mkdir -p .claude/rules/

# Copy as a rule file
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md .claude/rules/risingwave.md
```

---

### Claude Desktop

Claude Desktop discovers skills from `~/.claude/skills/` directories.

**Method 1: Install as Skill (Recommended)**

```bash
# Create the skill directory
mkdir -p ~/.claude/skills/risingwave-troubleshooting

# Copy skill manifest and consolidated content
cp /path/to/agent-skills/skills/risingwave-troubleshooting/SKILL.md ~/.claude/skills/risingwave-troubleshooting/
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md ~/.claude/skills/risingwave-troubleshooting/
```

Then add a reference link to the bottom of `~/.claude/skills/risingwave-troubleshooting/SKILL.md`:

```markdown
## Reference

For detailed troubleshooting guides, see [AGENTS.md](AGENTS.md)
```

After installation, type `/` in Claude Desktop to see `risingwave-troubleshooting` in the skill list, or ask a RisingWave question and Claude will auto-invoke it.

**Method 2: Attach File in Conversation**

When starting a conversation about RisingWave:
1. Click the attachment/file icon
2. Select the `AGENTS.md` file
3. Claude will use it as context for that conversation

---

### OpenAI Codex CLI

Codex CLI reads `AGENTS.md` files automatically. See [Codex documentation](https://developers.openai.com/codex/guides/agents-md).

**Method 1: Project-Level Instructions**

```bash
# Navigate to your RisingWave project
cd /path/to/your/project

# Copy AGENTS.md to your project root
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md ./AGENTS.md
```

Codex will automatically read this file when starting a session.

**Method 2: Global Instructions**

```bash
# Copy to Codex home directory for all projects
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md ~/.codex/AGENTS.md
```

**Method 3: Custom Fallback Filename**

If you want to use a different filename, add it to `~/.codex/config.toml`:

```toml
project_doc_fallback_filenames = ["RISINGWAVE.md", "AGENTS.md"]
```

Then copy the file with your preferred name:

```bash
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md ./RISINGWAVE.md
```

---

### GitHub Copilot

GitHub Copilot uses `.github/copilot-instructions.md` for repository-wide custom instructions. See [GitHub Docs](https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot).

**Method 1: Repository Instructions**

```bash
# Navigate to your RisingWave project
cd /path/to/your/project

# Create .github directory if it doesn't exist
mkdir -p .github

# Copy as Copilot instructions
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md .github/copilot-instructions.md
```

Copilot will automatically use these instructions for all chat requests in this repository.

**Method 2: Path-Specific Instructions**

For instructions that only apply to certain files, create a `.instructions.md` file with frontmatter:

```bash
# Create a RisingWave-specific instructions file
cat > .github/risingwave.instructions.md << 'EOF'
---
applyTo: "**/*.sql,**/docker-compose*.yml,**/risingwave/**"
---
EOF

# Append the AGENTS.md content
cat /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md >> .github/risingwave.instructions.md
```

**Verify It's Working**

After saving, check that `.github/copilot-instructions.md` appears in the "References" list when Copilot responds.

---

### Cursor

Cursor supports both legacy `.cursorrules` and the newer `.cursor/rules/` system. See [Cursor Docs](https://docs.cursor.com/context/rules-for-ai).

**Method 1: Project Rules (Recommended)**

```bash
# Navigate to your RisingWave project
cd /path/to/your/project

# Create the rules directory
mkdir -p .cursor/rules/

# Copy as a rule file (use .mdc extension for full features)
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md .cursor/rules/risingwave.mdc
```

For auto-attachment to specific files, add frontmatter to the `.mdc` file:

```bash
# Add frontmatter for SQL files
cat > .cursor/rules/risingwave.mdc << 'EOF'
---
description: "RisingWave troubleshooting knowledge"
globs: ["**/*.sql", "**/risingwave/**", "**/docker-compose*.yml"]
alwaysApply: false
---
EOF

# Append the AGENTS.md content
cat /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md >> .cursor/rules/risingwave.mdc
```

**Method 2: Legacy .cursorrules (Simpler)**

```bash
# Copy directly to .cursorrules
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md .cursorrules
```

Note: `.cursorrules` is deprecated and will be removed in future Cursor versions.

**Method 3: Global Rules**

For rules across all projects:
1. Open Cursor Settings
2. Go to **General > Rules for AI**
3. Paste the contents of `AGENTS.md`

---

### Windsurf

Windsurf uses a similar rules system to Cursor.

```bash
# Navigate to your project
cd /path/to/your/project

# Create rules directory
mkdir -p .windsurf/rules/

# Copy the skill
cp /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md .windsurf/rules/risingwave.md
```

---

### Other AI Editors

For other AI coding assistants, look for:
- Custom instructions or system prompt settings
- Project-level configuration files
- Context or rules directories

The key file to use is **`AGENTS.md`** — it contains all the consolidated knowledge in a single markdown file that most AI assistants can understand.

> **Tip: Installing multiple skills into a single-file tool**
>
> Tools like Codex CLI, GitHub Copilot, and Cursor (legacy) use a single instructions file. To include multiple skills, concatenate the `AGENTS.md` files:
> ```bash
> # GitHub Copilot
> mkdir -p .github
> cat /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md \
>     /path/to/agent-skills/skills/performance-tuning/AGENTS.md \
>     /path/to/agent-skills/skills/grafana-debugging/AGENTS.md \
>     > .github/copilot-instructions.md
>
> # OpenAI Codex CLI
> cat /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md \
>     /path/to/agent-skills/skills/performance-tuning/AGENTS.md \
>     /path/to/agent-skills/skills/grafana-debugging/AGENTS.md \
>     > ./AGENTS.md
>
> # Cursor (legacy)
> cat /path/to/agent-skills/skills/risingwave-troubleshooting/AGENTS.md \
>     /path/to/agent-skills/skills/performance-tuning/AGENTS.md \
>     /path/to/agent-skills/skills/grafana-debugging/AGENTS.md \
>     > .cursorrules
> ```

---

## Quick Reference

| AI Assistant | File Location | File Name |
|--------------|---------------|-----------|
| Claude Code | `.claude/skills/risingwave-troubleshooting/` | Full directory |
| Claude Code (rules) | `.claude/rules/` | `risingwave.md` |
| Claude Desktop | `~/.claude/skills/risingwave-troubleshooting/` | `SKILL.md` + `AGENTS.md` |
| Codex CLI | Project root | `AGENTS.md` |
| GitHub Copilot | `.github/` | `copilot-instructions.md` |
| Cursor | `.cursor/rules/` | `risingwave.mdc` |
| Cursor (legacy) | Project root | `.cursorrules` |
| Windsurf | `.windsurf/rules/` | `risingwave.md` |

---

## How It Works

Skills follow the [Agent Skills Open Standard](https://github.com/anthropics/agent-skills), making them compatible with multiple AI coding assistants.

### File Structure

Each skill follows the same structure:

```
skills/<skill-name>/
├── SKILL.md           # Skill manifest with metadata
├── AGENTS.md          # ⭐ Consolidated content - USE THIS FILE
├── README.md          # Skill documentation
├── _sections.md       # Category definitions
└── references/        # Individual reference guides (source files)
    ├── prefix-topic-a.md
    ├── prefix-topic-b.md
    └── ...
```

### Key Files

| File | Purpose |
|------|---------|
| **`AGENTS.md`** | **Primary file to load** — contains all consolidated knowledge in a single file |
| `SKILL.md` | Metadata about the skill (name, version, categories) |
| `references/*.md` | Individual reference guides (source files for AGENTS.md) |

## What's Included

### risingwave-troubleshooting — 28 reference guides

**Performance & Memory (CRITICAL/HIGH)** — 12 guides
- Barrier stuck diagnosis and resolution
- Compute Node OOM troubleshooting
- Join optimization and anti-pattern detection
- Temporal filters and watermark-based state management
- Window functions and aggregation optimization
- MV pipeline optimization and refactoring
- MV design patterns for efficient streaming
- Background DDL and MV creation management
- Parallelism management and adaptive scaling
- Streaming performance tuning
- DML best practices (phantom updates, write amplification, FLUSH)
- Index management for query acceleration

**Storage & Compaction (CRITICAL/HIGH)** — 2 guides
- L0 file accumulation and write stops
- Compaction configuration tuning

**Sources (HIGH)** — 1 guide
- Kafka SSL/TLS connection troubleshooting

**Sinks (CRITICAL/HIGH/MEDIUM)** — 3 guides
- Snowflake sink barrier stuck troubleshooting
- JDBC sink connection issues
- Iceberg sink issues

**CDC (HIGH)** — 2 guides
- CDC source troubleshooting (Postgres, MySQL, MongoDB)
- Sink decoupling configuration

**Cluster Operations (CRITICAL/HIGH)** — 3 guides
- Pod health and restart issues
- Connection and secret management
- User access control

**Operational Best Practices (CRITICAL)** — 1 guide
- Serving nodes and batch query management

**Diagnostics (HIGH)** — 3 guides
- Essential SQL queries for investigation
- EXPLAIN plan analysis for streaming jobs
- Benchmark environment setup and testing methodology

**Monitoring (MEDIUM)** — 1 guide
- Grafana metrics navigation

### performance-tuning — 4 reference guides

- Window function, aggregation, and UNION edge cases (CRITICAL)
- MV architecture anti-patterns: dedup placement, distribution skew (CRITICAL)
- Systematic EXPLAIN analysis workflow with red flags (HIGH)
- Pre-deployment MV performance review checklist (HIGH)

### grafana-debugging — 4 reference guides

- Dashboard traversal patterns for symptom diagnosis (CRITICAL)
- Systematic metrics investigation workflow (CRITICAL)
- grafana-cli tool usage guide (HIGH)
- Visual metric pattern recognition (HIGH)

## Creating Skills

Want to contribute a new skill? Check out:

1. The `skills/_template/` directory for the skill structure
2. [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines

## Development

```bash
# Install dependencies
npm install
cd packages/skills-build && npm install && cd ../..

# Build the tools
npm run build:tools

# Validate skills
npm run validate

# Build AGENTS.md files
npm run build

# Run tests
npm run test:sanity

# Lint and format
npm run ci:check
```

## License

MIT
