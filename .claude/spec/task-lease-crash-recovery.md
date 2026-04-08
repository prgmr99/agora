# [Technical Spec] Phase 1: Task Lease + 크래시 복구

**버전:** 1.0  
**상태:** 구현 예정  
**작성일:** 2026-04-08  
**목표:** 에이전트가 크래시해도 태스크가 자동으로 복구되는 신뢰성 확보

---

## 문제

현재 에이전트가 `in_progress` 중 죽으면 태스크가 영원히 `in_progress`에 멈춥니다.  
기존 `timed_out`은 생성 시각 기준 만료라 실제 실행 중 크래시를 감지 못합니다.

---

## 해결: Task Lease (임대)

에이전트가 태스크를 시작할 때 **임대(lease)** 를 받습니다.  
임대는 N초마다 갱신해야 하며, 갱신이 없으면 태스크가 자동으로 `pending`으로 복귀합니다.

```
agora_update_task(in_progress)
    → lease_expires_at = now + 30s 설정

agora_renew_lease(task_id)        ← 에이전트가 주기적으로 호출
    → lease_expires_at = now + 30s 연장

서버 5초 스위퍼:
    lease_expires_at < now AND status = in_progress
    → status = pending (re-queue)
    → assigned_agent_id 초기화 (재라우팅 허용)
```

---

## 신규 DB 컬럼

```sql
lease_expires_at INTEGER,   -- epoch ms, in_progress일 때만 유효
lease_duration_ms INTEGER DEFAULT 30000,  -- 임대 기간 (기본 30초)
attempt_count INTEGER DEFAULT 0,  -- 총 시도 횟수 (재라우팅 횟수)
```

---

## 신규 MCP 툴: `agora_renew_lease`

```typescript
{
  task_id: z.string(),
  extend_ms: z.number().optional()  // 기본값: lease_duration_ms
}
```

**동작:**
- `in_progress` 태스크만 갱신 허용
- `lease_expires_at` 연장
- 다른 에이전트가 소유한 태스크 갱신 시도 → 거절

---

## `agora_update_task` 변경

`status: in_progress` 전환 시:
- `lease_expires_at = now + lease_duration_ms` 자동 설정
- `attempt_count += 1`

---

## 서버 스위퍼 (5초 간격)

```typescript
db.reclaimExpiredLeases()
// in_progress이고 lease_expires_at < now인 태스크를
// pending으로 되돌리고 assigned_agent_id = null
// → 자동 재라우팅 대상이 됨
```

---

## 구현 순서

1. `src/types.ts` — Task에 lease 필드 추가
2. `src/db.ts` — 컬럼, migration, reclaimExpiredLeases()
3. `src/tools.ts` — agora_update_task 수정 + agora_renew_lease 추가
4. `src/server.ts` — 5초 lease 스위퍼 추가
5. 테스트 추가

---

## 성공 기준

- 에이전트 크래시 시뮬레이션 → 30초 내 태스크 `pending` 복귀
- `agora_renew_lease` 호출 시 임대 연장 확인
- 다른 에이전트의 태스크 임대 갱신 시도 → 거절
- 기존 67개 테스트 모두 통과
