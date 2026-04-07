# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode (tsc --watch)
npm test             # Run all tests (vitest)
npm run test:watch   # Watch test mode
npm run lint         # Type check only (tsc --noEmit)
npm run lint:eslint  # ESLint check
npm run serve        # Start MCP server via node dist/server.js
```

Run a single test file:
```bash
npx vitest run tests/matcher.test.ts
```

Pre-commit hook runs `npm run lint` → `lint-staged` (eslint --fix on staged .ts) → `npm test`.

## Architecture

Agora is an MCP server that acts as a smart task router for AI agents. Agents register their capabilities; when a task is created, Agora keyword-matches it to the best agent and tracks the lifecycle.

**Three-layer structure:**

1. **`src/tools.ts`** — 8 MCP tool handlers (`agora_register_agent`, `agora_unregister_agent`, `agora_list_agents`, `agora_find_agent`, `agora_create_task`, `agora_get_task`, `agora_list_tasks`, `agora_cancel_task`). All inputs are validated with Zod schemas inline.

2. **`src/matcher.ts`** — Keyword scoring engine. Tokenizes text, strips stopwords, then scores each agent capability by name (weight ×3), tags (×2), description (×1). Returns `MatchResult[]` sorted by normalized confidence (0–1). No ML/embeddings — pure keyword overlap.

3. **`src/db.ts`** — SQLite via `better-sqlite3` with WAL mode. `AgoraDB` class holds all prepared statements. Two tables: `agents` (capabilities/transport as JSON columns) and `tasks` (full lifecycle + assignment + match metadata).

**Entry points:**
- `src/server.ts` — Creates `McpServer`, registers tools, connects via `StdioServerTransport`
- `src/cli.ts` — `agora init` (writes `~/.agora/config.json` + SQLite DB, auto-discovers Claude Desktop / Cursor / `.mcp.json`) and `agora serve`
- `bin/agora.js` — CLI shim

**Type definitions:** All interfaces live in `src/types.ts`. `src/index.ts` re-exports the public API.

## Key Conventions

- **ESM throughout** — `"type": "module"` in package.json, TypeScript targets ES2022 with `NodeNext` module resolution. Always use `.js` extensions in import paths (even for `.ts` source files).
- **Strict TypeScript** — `strict: true`. No `any` unless unavoidable.
- **Task status flow:** `pending → assigned → in_progress → completed | failed | timed_out | cancelled`
- **Config location:** `~/.agora/config.json`; DB default: `~/.agora/agora.db`
- **Matching threshold:** `min_confidence: 0.1`, auto-assign at `0.5` (configurable in config)
