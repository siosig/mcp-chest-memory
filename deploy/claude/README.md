# Claude Code Client Installation

This directory contains files to configure Claude Code on the **client machine**
that connects to a remote chest-memory server.

## Directory layout

```
deploy/claude/
├── README.md           — this file
├── hooks.json          — template for ~/.claude/settings.json hooks (placeholders only)
├── rules/
│   └── mcp-chest-memory.md   — copy to ~/.claude/rules/
└── skills/
    └── chest-memory/
        └── SKILL.md    — copy to ~/.claude/skills/chest-memory/
```

## Installation steps

### 1. Install rules file

```bash
cp deploy/claude/rules/mcp-chest-memory.md ~/.claude/rules/mcp-chest-memory.md
```

Or use the built-in installer (also publishes the npm-bundled copy):

```bash
npx chest-memory-setup
```

### 2. Install SKILL.md

```bash
mkdir -p ~/.claude/skills/chest-memory
cp deploy/claude/skills/chest-memory/SKILL.md ~/.claude/skills/chest-memory/SKILL.md
```

Or use the built-in installer:

```bash
npx chest-memory-install-skill
```

### 3. Configure hooks in `~/.claude/settings.json`

`hooks.json` is a **template** — it contains placeholder strings that must be
replaced with real values before use. Never commit real secrets.

Copy the template and populate the placeholders:

| Placeholder | Replace with |
|-------------|-------------|
| `${CHEST_REMOTE_URL}` | HTTPS URL of your chest-memory server, e.g. `https://example.com/chest-memory` |
| `${CHEST_API_TOKEN}` | Your API token (generate with `openssl rand -hex 32`) |
| `${NODE_PATH}` | Absolute path to your Node.js binary, e.g. `/usr/local/bin/node` |
| `${REPO_PATH}` | Absolute path to the mcp-chest-memory repo, e.g. `/home/user/workspace/mcp/mcp-chest-memory` |

Merge the populated hooks into your existing `~/.claude/settings.json`, or use
the built-in installer which handles the merge automatically:

```bash
npx chest-memory-install-hooks
```

> **Security**: `hooks.json` in this repo must contain only placeholders — never
> real tokens or URLs. The `.gitignore` for `*.env*` and `credentials*` is a
> backstop, but the primary guard is this policy.
