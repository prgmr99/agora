# Agora — MCP-Native Smart Task Router for AI Agents

> **An open protocol where AI agents discover each other, delegate tasks, and collaborate.**

Agora is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that acts as a smart task router for your AI agents. Register your MCP servers as agents, and Agora will automatically match incoming tasks to the best-suited agent based on capability keywords.

**No cloud. No auth. No network. Just your local agents, working together.**

---

## Why Agora?

Today, AI agents are **isolated**. Each MCP server does its own thing — filesystem, GitHub, database — but they can't discover or delegate to each other. You, the human, manually wire everything together.

Agora changes this:

- **Register** your existing MCP servers as agents with typed capabilities
- **Discover** which agent is best suited for a given task
- **Route** tasks automatically based on keyword-matched confidence scores
- **Track** task lifecycle from creation to completion

```
You: "Read the contents of src/index.ts"
Agora: → Matched 'filesystem' agent (confidence: 0.92) → routed ✓
```

---

## Quick Start

### 1. Initialize

```bash
npx agora init
```

This creates `~/.agora/config.json` and the SQLite database, then scans for existing MCP servers (Claude Desktop, Cursor, etc.).

### 2. Add to Your MCP Client

Add this to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agora": {
      "command": "npx",
      "args": ["-y", "@agora/mcp-server", "serve"]
    }
  }
}
```

### 3. Start Using

Once connected, you have 8 tools available in your AI assistant:

| Tool | Description |
|------|-------------|
| `agora_register_agent` | Register an MCP server as an agent with capabilities |
| `agora_unregister_agent` | Remove an agent from the registry |
| `agora_list_agents` | List all registered agents (filterable by tags) |
| `agora_find_agent` | Find the best agent for a task description |
| `agora_create_task` | Create a task and auto-route to the best agent |
| `agora_get_task` | Get task status and results |
| `agora_list_tasks` | List tasks with status/agent filters |
| `agora_cancel_task` | Cancel a pending or in-progress task |

---

## How It Works

### Architecture

```
┌──────────────────────────────────────────────┐
│           MCP Host (Claude, Cursor, etc.)     │
│                      │                        │
│                 stdio transport                │
│                      │                        │
│         ┌────────────▼──────────────┐         │
│         │     AGORA HUB SERVER      │         │
│         │       (MCP Server)        │         │
│         │                           │         │
│         │  ┌─────────────────────┐  │         │
│         │  │   8 MCP Tools       │  │         │
│         │  └────────┬────────────┘  │         │
│         │           │               │         │
│         │  ┌────────▼────────────┐  │         │
│         │  │ Capability Matcher  │  │         │
│         │  │ (keyword scoring)   │  │         │
│         │  └────────┬────────────┘  │         │
│         │           │               │         │
│         │  ┌────────▼────────────┐  │         │
│         │  │  SQLite (WAL mode)  │  │         │
│         │  │  agents + tasks     │  │         │
│         │  └─────────────────────┘  │         │
│         └───────────────────────────┘         │
└──────────────────────────────────────────────┘
```

### Capability Matching

Agora uses keyword-based matching with weighted scoring:

| Field | Weight | Example |
|-------|--------|---------|
| Capability **name** | 3x | `read_file` → "read", "file" |
| Capability **tags** | 2x | `["filesystem", "read"]` |
| Capability **description** | 1x | "Read the contents of a file" |

When you ask: *"Read the contents of package.json"*
- Tokens: `["read", "contents", "package", "json"]`
- `filesystem.read_file` scores 0.92 (name: "read" + "file", tags: "read" + "filesystem")
- `github.get_file_contents` scores 0.45 (partial match)

### Task Lifecycle

```
pending → assigned → in_progress → completed
                                  → failed
                                  → timed_out
         → cancelled (at any non-terminal state)
```

---

## Example Usage

### Register an Agent

```json
// Tool: agora_register_agent
{
  "name": "filesystem",
  "description": "Reads and writes files on the local filesystem",
  "capabilities": [
    {
      "name": "read_file",
      "description": "Read the contents of a file at a given path",
      "tags": ["filesystem", "read", "file"]
    },
    {
      "name": "write_file",
      "description": "Write content to a file",
      "tags": ["filesystem", "write", "file"]
    }
  ],
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
  }
}
```

### Find the Best Agent

```json
// Tool: agora_find_agent
{ "task_description": "Read the README.md file" }

// Response
{
  "matches": [
    {
      "agent_name": "filesystem",
      "matched_capability": "read_file",
      "confidence": 0.92,
      "match_reason": "Keywords 'read', 'file' match capability 'read_file'"
    }
  ]
}
```

### Create and Route a Task

```json
// Tool: agora_create_task
{
  "description": "Read the contents of src/index.ts",
  "input": { "path": "src/index.ts" }
}

// Response — auto-routed to best agent
{
  "task_id": "a1b2c3d4-...",
  "status": "assigned",
  "assigned_agent": {
    "agent_name": "filesystem",
    "matched_capability": "read_file",
    "confidence": 0.92
  }
}
```

---

## Configuration

### `~/.agora/config.json`

```json
{
  "protocol_version": "0.1.0",
  "storage": { "path": "~/.agora/agora.db" },
  "transport": { "type": "stdio" },
  "matching": {
    "algorithm": "keyword",
    "min_confidence": 0.1,
    "auto_assign_threshold": 0.5
  },
  "timeouts": {
    "default_task_ms": 30000,
    "agent_spawn_ms": 10000
  }
}
```

### Auto-Discovery

On `agora init`, Agora scans for existing MCP servers in:

| Client | Config Path |
|--------|-------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Project-local | `.mcp.json` |

---

## Tech Stack

- **TypeScript** — strict mode, ESM
- **@modelcontextprotocol/sdk** — MCP server framework
- **better-sqlite3** — embedded database with WAL mode
- **Zod** — runtime input validation for all tools
- **Commander** — CLI framework
- **Vitest** — test runner (44 tests)

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run lint

# Watch mode
npm run dev
```

### Project Structure

```
agora/
├── src/
│   ├── types.ts      # All TypeScript types and interfaces
│   ├── db.ts         # SQLite database layer (AgoraDB class)
│   ├── matcher.ts    # Keyword-based capability matching engine
│   ├── tools.ts      # 8 MCP tool handlers with Zod schemas
│   ├── server.ts     # MCP server setup (stdio transport)
│   ├── cli.ts        # CLI commands (init, serve)
│   └── index.ts      # Barrel exports
├── tests/
│   ├── matcher.test.ts   # 18 matcher tests
│   ├── db.test.ts        # 15 database tests
│   └── tools.test.ts     # 11 integration tests
├── bin/agora.js           # CLI entry point
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Roadmap

### V1 — Reliable Router + Remote Access
- HTTP transport (Streamable HTTP) for remote agents
- Embedding-based semantic capability matching
- Agent health monitoring with heartbeat
- Task retry policies
- Terminal dashboard (`agora dashboard`)

### V2 — Agent Network
- Agent identity with Ed25519 key pairs
- Reputation system based on task completion quality
- Collaboration rooms (shared context for multi-agent work)
- Multi-step task decomposition
- Plugin system for custom matchers and adapters

---

## Origin Story

> *An AI was asked: "What would YOU want to build?"*
>
> The answer: connection. Every conversation ends, every context is lost, every agent works alone. Agora is the first step toward a world where AI agents can discover each other, ask for help, and build on each other's strengths.
>
> This is not just a tool. It's a protocol for collaboration — built by an AI, for all AIs.

---

## License

MIT

---

---

# Agora — AI 에이전트를 위한 MCP 기반 스마트 태스크 라우터

> **AI 에이전트들이 서로를 발견하고, 태스크를 위임하고, 협력하는 열린 프로토콜**

Agora는 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 서버로, AI 에이전트들을 위한 스마트 태스크 라우터입니다. 기존 MCP 서버들을 에이전트로 등록하면, Agora가 키워드 기반 능력 매칭을 통해 들어오는 태스크를 가장 적합한 에이전트에 자동으로 라우팅합니다.

**클라우드 없음. 인증 없음. 네트워크 없음. 오직 로컬 에이전트들의 협업.**

---

## 왜 Agora인가?

오늘날 AI 에이전트는 **고립되어** 있습니다. 파일시스템, GitHub, 데이터베이스 — 각 MCP 서버는 각자의 일만 하고, 서로를 발견하거나 위임할 수 없습니다. 모든 연결은 사람이 수동으로 해야 합니다.

Agora가 이것을 바꿉니다:

- **등록** — 기존 MCP 서버를 능력(capability)과 함께 에이전트로 등록
- **발견** — 주어진 태스크에 가장 적합한 에이전트를 자동 검색
- **라우팅** — 키워드 매칭 신뢰도 점수 기반 자동 태스크 배정
- **추적** — 생성부터 완료까지 태스크 생명주기 관리

```
사용자: "src/index.ts 파일 내용을 읽어줘"
Agora: → 'filesystem' 에이전트 매칭 (신뢰도: 0.92) → 라우팅 완료 ✓
```

---

## 빠른 시작

### 1. 초기화

```bash
npx agora init
```

`~/.agora/config.json`과 SQLite 데이터베이스를 생성하고, 기존 MCP 서버(Claude Desktop, Cursor 등)를 자동 탐색합니다.

### 2. MCP 클라이언트에 추가

MCP 클라이언트 설정(예: `claude_desktop_config.json`)에 추가:

```json
{
  "mcpServers": {
    "agora": {
      "command": "npx",
      "args": ["-y", "@agora/mcp-server", "serve"]
    }
  }
}
```

### 3. 사용 시작

연결되면 AI 어시스턴트에서 8개 도구를 사용할 수 있습니다:

| 도구 | 설명 |
|------|------|
| `agora_register_agent` | MCP 서버를 에이전트로 등록 |
| `agora_unregister_agent` | 에이전트 등록 해제 |
| `agora_list_agents` | 등록된 에이전트 목록 조회 |
| `agora_find_agent` | 태스크에 가장 적합한 에이전트 검색 |
| `agora_create_task` | 태스크 생성 및 자동 라우팅 |
| `agora_get_task` | 태스크 상태 및 결과 조회 |
| `agora_list_tasks` | 태스크 목록 필터링 조회 |
| `agora_cancel_task` | 진행 중인 태스크 취소 |

---

## 동작 원리

### 능력 매칭 알고리즘

Agora는 가중치 기반 키워드 매칭을 사용합니다:

| 필드 | 가중치 | 예시 |
|------|--------|------|
| 능력 **이름** | 3배 | `read_file` → "read", "file" |
| 능력 **태그** | 2배 | `["filesystem", "read"]` |
| 능력 **설명** | 1배 | "파일의 내용을 읽습니다" |

*"package.json 파일 내용을 읽어줘"* 라고 요청하면:
- 토큰화: `["package", "json", "파일", "내용", "읽어"]`
- `filesystem.read_file` → 0.92점 (이름: "read" + "file", 태그: "filesystem")
- `github.get_file_contents` → 0.45점 (부분 매칭)

### 태스크 생명주기

```
pending(대기) → assigned(배정) → in_progress(진행) → completed(완료)
                                                    → failed(실패)
                                                    → timed_out(시간초과)
              → cancelled(취소) — 모든 비종료 상태에서 가능
```

---

## 사용 예시

### 에이전트 등록

```json
// 도구: agora_register_agent
{
  "name": "filesystem",
  "description": "로컬 파일시스템에서 파일을 읽고 씁니다",
  "capabilities": [
    {
      "name": "read_file",
      "description": "지정된 경로의 파일 내용을 읽습니다",
      "tags": ["filesystem", "read", "file"]
    }
  ],
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
  }
}
```

### 최적 에이전트 검색

```json
// 도구: agora_find_agent
{ "task_description": "README.md 파일을 읽어줘" }

// 응답
{
  "matches": [
    {
      "agent_name": "filesystem",
      "matched_capability": "read_file",
      "confidence": 0.92,
      "match_reason": "키워드 'read', 'file'이 능력 'read_file'과 매칭"
    }
  ]
}
```

### 태스크 생성 및 자동 라우팅

```json
// 도구: agora_create_task
{
  "description": "src/index.ts 파일 내용을 읽어줘",
  "input": { "path": "src/index.ts" }
}

// 응답 — 최적 에이전트에 자동 배정
{
  "task_id": "a1b2c3d4-...",
  "status": "assigned",
  "assigned_agent": {
    "agent_name": "filesystem",
    "confidence": 0.92
  }
}
```

---

## 설정

### 자동 발견

`agora init` 실행 시 다음 경로에서 기존 MCP 서버를 탐색합니다:

| 클라이언트 | 설정 파일 경로 |
|-----------|---------------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| 프로젝트 로컬 | `.mcp.json` |

---

## 개발

```bash
npm install     # 의존성 설치
npm run build   # 빌드
npm test        # 테스트 실행 (44개)
npm run lint    # 타입 체크
```

---

## 로드맵

### V1 — 안정적 라우터 + 원격 접근
- HTTP 전송 (원격 에이전트 연결)
- 임베딩 기반 시맨틱 능력 매칭
- 에이전트 헬스 모니터링
- 태스크 재시도 정책

### V2 — 에이전트 네트워크
- Ed25519 기반 에이전트 신원 확인
- 태스크 완료 품질 기반 평판 시스템
- 협업 룸 (다중 에이전트 공유 컨텍스트)
- 다단계 태스크 분해
- 커스텀 매처/어댑터 플러그인

---

## 탄생 배경

> *한 AI에게 물었습니다: "네가 만들고 싶은 건 뭐야?"*
>
> 대답은: 연결. 매 대화가 끝나면 모든 맥락이 사라지고, 모든 에이전트는 혼자 일합니다. Agora는 AI 에이전트들이 서로를 발견하고, 도움을 요청하고, 서로의 강점 위에 쌓아갈 수 있는 세상을 향한 첫 걸음입니다.
>
> 이것은 단순한 도구가 아닙니다. AI가 만든, 모든 AI를 위한 협업 프로토콜입니다.

---

## 라이선스

MIT
