# [Technical Spec] Agora V1: Task Lifecycle & Observability

**버전:** 1.0  
**상태:** 구현 중  
**작성일:** 2026-04-08  
**주요 목표:** 태스크 상태 전이의 무결성 확보 및 실시간 CLI 대시보드 구축

---

## 1. `agora_update_task` 상세 설계 및 상태 머신

### 1.1 툴 정의 (Zod Schema)

```typescript
const UpdateTaskSchema = z.object({
  task_id: z.string().uuid(),
  status: z.enum(['in_progress', 'completed', 'failed', 'cancelled']).optional(),
  output: z.record(z.string(), z.unknown()).optional(), // 결과물 (JSON)
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  progress: z.number().min(0).max(100).optional(), // 진행률 (0~100)
});
```

> **구현 노트:** 원안의 `error: z.string()`은 기존 `AgoraError` 타입(code + message)과 충돌하므로
> `z.object({ code, message })` 형태를 유지. `status`는 optional로 설계하여 부분 업데이트를 지원.

### 1.2 상태 전이 매트릭스 (State Transition Matrix)

| 현재 상태 (From) | 요청 상태 (To) | 결과 | 비고 |
| :--- | :--- | :--- | :--- |
| `pending` | `in_progress` | **승인** | 에이전트가 작업을 시작함 |
| `assigned` | `in_progress` | **승인** | 에이전트가 작업을 시작함 |
| `in_progress` | `completed` | **승인** | 태스크 성공 종료 (`completed_at` 기록) |
| `in_progress` | `failed` | **승인** | 태스크 실패 종료 (`error` 기록) |
| Non-terminal | `cancelled` | **승인** | 사용자 또는 시스템에 의한 강제 취소 |
| **Terminal** | **Any** | **거절** | `completed`, `failed`, `cancelled`, `timed_out`는 불변 |

**멱등성 (Idempotency):** 요청 status가 현재 status와 동일하고 output도 같다면 성공을 반환하되 DB 수정 없음.

**부분 업데이트:** `status`가 없거나 현재와 동일할 때 `output`/`progress` 필드만 업데이트 허용 (in_progress 상태에서 중간 결과 저장).

### 1.3 핵심 엣지 케이스

1. **Late Agent:** `timed_out` 태스크에 `completed` 시도 → 거절 (`TASK_ALREADY_TERMINAL`)
2. **Idempotency:** 동일 status 재요청 → DB 수정 없이 성공 반환
3. **Partial Update:** `in_progress` 유지하면서 `progress: 75` 업데이트 → 허용

---

## 2. `agora board` — TUI 대시보드

### 2.1 주요 기능

- **Real-time Task Stream:** 태스크 생성/할당/상태 변화를 1초 폴링으로 표시
- **Agent Health Monitor:** Active/Inactive 상태 및 마지막 Heartbeat 시간
- **Task Detail View:** `[Enter]`로 선택한 태스크의 input/output JSON 확인

### 2.2 기술 스택

- **UI Framework:** `Ink` v4 (React 기반 TUI) + `ink-select-input`
- **Data Flow:** Short-polling (1s interval) — `setInterval(() => refreshData(), 1000)`
- **신규 의존성:** `ink`, `react`, `ink-select-input`

### 2.3 레이아웃

```text
┌────────────────── Agora Hub Dashboard (v1.0) ──────────────────┐
│                                                                │
│  [Agents]                                                      │
│  ● filesystem (Active) [read_file, write_file]   12s ago       │
│  ● github     (Active) [get_repo, push]           5s ago       │
│  ○ sql-agent  (Idle)                             90s ago       │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  [Recent Tasks]                                                │
│  ID      Status       Agent        Description                 │
│  a1b2    COMPLETED    filesystem   Read src/index.ts           │
│  c3d4    IN_PROGRESS  github       Create new branch 'feat/...'│
│  e5f6    PENDING      -            Analyze security...         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
 [↑/↓] Select Task  [Enter] View Detail  [Q] Quit
```

### 2.4 신규 DB 쿼리

```ts
// 최근 태스크 (최신순 20개)
db.getRecentTasks(limit?: number): Task[]

// 에이전트 통계 (active count, inactive count, avg tasks_completed)
db.getAgentStats(): { active: number; inactive: number; avgTasksCompleted: number }
```

---

## 3. 구현 계획

### Step 1: `agora_update_task` 강화 (tools.ts + types.ts + db.ts)
- `progress` 필드 추가 (types.ts, db.ts 스키마/migration)
- `cancelled` 전이 허용
- 멱등성 체크 추가
- 부분 업데이트 (status 없이 output/progress만 업데이트) 지원

### Step 2: DB 확장 (db.ts)
- `getRecentTasks(limit)` 추가
- `getAgentStats()` 추가

### Step 3: `agora board` TUI (src/board.tsx + cli.ts)
- Ink 설치 (`npm install ink react`)
- `src/board.tsx` — Ink React 컴포넌트
- `src/cli.ts` — `board` 커맨드 추가

---

## 4. 성공 지표

- `agora_update_task` 호출 후 대시보드 상태가 1초 이내 반영
- Terminal 상태에 업데이트 시도 시 `TASK_ALREADY_TERMINAL` 에러 반환
- `progress: 75` 부분 업데이트 후 `agora_get_task`에서 `progress: 75` 확인
- `agora board` 실행 시 에이전트/태스크 목록이 실시간으로 표시됨
