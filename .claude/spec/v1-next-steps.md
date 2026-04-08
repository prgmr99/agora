# Agora V1 — Next Concrete Steps

작성일: 2026-04-07  
출처: 아키텍트 + 프로덕트 매니저 + 테스트 엔지니어 3-agent 검토 결과 종합

---

## 우선순위 순서

### 1. `agora_update_task` 툴 추가 (Quick Win)

**왜 먼저:** `in_progress`, `completed` 상태가 현재 어떤 MCP 툴로도 도달 불가능하다. 태스크 라이프사이클이 broken 상태.

**작업 위치:** `src/tools.ts`, `src/types.ts`

**구현 내용:**
- 새 툴 `agora_update_task(task_id, status, output?, error?)` 추가
- 허용 전이: `pending → in_progress`, `in_progress → completed | failed`
- 터미널 상태(`completed`, `failed`, `cancelled`, `timed_out`)에서의 전이는 에러 반환
- `db.updateTask()` 호출로 `output` JSON과 `completed_at` 기록

**수락 기준:** 에이전트가 태스크를 받은 후 결과를 `output`에 쓰고 `completed`로 마킹할 수 있다.

---

### 2. `agora_heartbeat` 툴 + 에이전트 헬스 스위퍼 (Quick Win)

**왜:** `last_seen_at`은 스키마에 존재하지만 등록 시 한 번만 기록된다. 오프라인 에이전트에도 계속 태스크가 라우팅된다.

**작업 위치:** `src/tools.ts`, `src/db.ts`, `src/server.ts`

**구현 내용:**
- `src/db.ts`에 `touchAgent(agent_id: string)` 추가
  - `UPDATE agents SET last_seen_at=? WHERE agent_id=?` (SELECT 없이 write-only)
  - `updateAgent()`의 SELECT-then-UPDATE 패턴 사용 금지 (`db.ts:288-304`)
- 새 툴 `agora_heartbeat(agent_id)` → `db.touchAgent()` 호출
- `src/server.ts`의 `createServer()`에 60초 간격 스위퍼 추가
  - 90초 이상 heartbeat 없는 에이전트를 `inactive`로 마킹
- `findBestAgents()`에서 `inactive` 에이전트 제외
- `config.json`에 `last_seen_threshold_ms` 필드 추가

**수락 기준:** 90초간 heartbeat 없는 에이전트에게 태스크가 라우팅되지 않는다.

---

### 3. HTTP Transport 지원 (V1 핵심)

**왜:** stdio는 동일 호스트 강제. 실제 멀티 에이전트 네트워크는 원격 에이전트가 필요하다.

**작업 위치:** `src/types.ts`, `src/executor.ts` (신규), `src/tools.ts`

**구현 내용:**

`src/types.ts` — `AgentTransport` 확장:
```ts
type AgentTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
```

`src/executor.ts` 신규 생성:
```ts
interface AgentClient {
  call(capability: string, input: unknown, signal: AbortSignal): Promise<unknown>
}
// 구현체: StdioAgentClient, HttpAgentClient
```

- `StdioAgentClient`: `@modelcontextprotocol/sdk/client/stdio.js`로 `transport.command` 실행
- `HttpAgentClient`: `StreamableHTTPClientTransport` 사용
- `agent_id` 키로 connection pool 관리 (stdio 프로세스 재사용)
- `agora_create_task`에서 DB 저장 후 `executor.dispatch(task, agent)` 호출

**수락 기준:** 원격 호스트의 HTTP 에이전트가 `agora_create_task`를 통해 태스크를 받아 완료할 수 있다.

---

### 4. Timeout 스위퍼 이동 (버그 수정)

**왜:** `expireTimedOutTasks()`가 현재 `agora_list_tasks` 사이드 이펙트로만 실행된다(`tools.ts:335`). list를 아무도 호출하지 않으면 태스크가 `in_progress`에 영구적으로 머문다.

**작업 위치:** `src/tools.ts`, `src/server.ts`, `src/db.ts`

**구현 내용:**
- `agora_list_tasks` 핸들러에서 `expireTimedOutTasks()` 호출 제거
- `server.ts`의 `createServer()`에 30초 간격 인터벌로 이동
- `db.ts:422`의 `julianday` 연산을 epoch ms(INTEGER)로 교체
  - `created_at` 컬럼을 epoch ms로 저장하거나 `created_at_ms` 컬럼 추가

**수락 기준:** list 호출 없이도 timeout된 태스크가 자동으로 `timed_out` 상태로 전환된다.

---

### 5. Task Retry 정책 (V1 완성)

**왜:** HTTP transport 도입 후 네트워크 실패가 실제로 발생한다. 현재 실패한 태스크는 호출자가 직접 재생성해야 한다.

**작업 위치:** `src/db.ts`, `src/types.ts`, `src/tools.ts`

**구현 내용:**
- `tasks` 테이블에 컬럼 추가: `attempts INTEGER DEFAULT 0`, `max_attempts INTEGER DEFAULT 1`, `next_retry_at INTEGER`
- `Task` 타입에 동일 필드 추가
- `agora_create_task` 할당 블록(`tools.ts:218-238`)을 `db.transaction(() => …)`으로 감싸기 (동시 이중 할당 방지)
- 재시도 로직: 지수 백오프 (1s → 4s → 16s), `max_attempts` 도달 시 `failed`
- 재시도 시 matcher 재실행 (원래 에이전트가 inactive일 수 있음)

**수락 기준:** 에이전트 실패 시 `max_retries` 횟수만큼 자동 재시도되고, `agora_get_task`에서 `retry_count`가 보인다.

---

## 테스트 보강 (병행 진행)

V1 구현과 함께 아래 테스트 케이스 추가 필요:

| 테스트 대상 | 시나리오 | 리스크 |
|------------|----------|--------|
| `db.ts:412` `expireTimedOutTasks` | timeout_ms:1인 오래된 태스크가 `timed_out`으로 전환되는지 확인 | 높음 |
| `db.ts:412` `expireTimedOutTasks` | 터미널 상태 태스크는 영향받지 않는지 확인 | 높음 |
| `db.ts:288` `updateAgent` | 부분 업데이트가 기존 필드를 덮어쓰지 않는지 확인 | 중간 |
| `db.ts:342` `listTasks` | `limit`/`offset` 페이지네이션 정확성 | 중간 |
| `tools.ts` | `agora_get_task`/`agora_cancel_task`의 TASK_NOT_FOUND 에러 경로 | 중간 |

---

## 참고 파일

| 파일 | 관련 내용 |
|------|----------|
| `src/types.ts:14-19` | stdio 전용 transport 타입 → HTTP union으로 확장 필요 |
| `src/tools.ts:87` | `status: 'active'` 등록 시 한 번만 설정, 이후 미갱신 |
| `src/tools.ts:218-255` | `agora_create_task` — 할당만 하고 실제 dispatch 없음 |
| `src/tools.ts:335` | `expireTimedOutTasks` 사이드 이펙트 위치 → server.ts로 이동 |
| `src/db.ts:288-304` | `updateAgent` SELECT-then-UPDATE → heartbeat에 부적합 |
| `src/db.ts:412-427` | `julianday` 연산 → epoch ms로 교체 |
| `src/server.ts:7-28` | 스위퍼 인터벌 시작 위치 |
| `src/matcher.ts:134` | `findBestAgents` — Matcher 인터페이스 추상화 지점 |
