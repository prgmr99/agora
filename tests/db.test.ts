import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { AgoraDB } from '../src/db.js';
import type { Agent, Task } from '../src/types.js';

function createTestAgent(overrides?: Partial<Agent>): Agent {
  return {
    agent_id: uuidv4(),
    name: 'test-agent',
    description: 'Test agent',
    capabilities: [{ name: 'test', description: 'Test capability', tags: ['test'] }],
    transport: { type: 'stdio', command: 'echo', args: ['hello'] },
    status: 'active',
    registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    tasks_completed: 0,
    ...overrides,
  };
}

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    task_id: uuidv4(),
    description: 'Test task',
    status: 'pending',
    priority: 'normal',
    timeout_ms: 30000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attempts: 0,
    max_attempts: 1,
    ...overrides,
  };
}

let db: AgoraDB;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/agora-test-${Date.now()}.db`;
  db = new AgoraDB(dbPath);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  // Also remove WAL and SHM files if present
  for (const suffix of ['-wal', '-shm']) {
    const extra = dbPath + suffix;
    if (fs.existsSync(extra)) fs.unlinkSync(extra);
  }
});

describe('AgoraDB initialization', () => {
  it('should create database and tables on init', () => {
    // If constructor didn't throw, schema was created. Verify by doing a basic operation.
    const agents = db.listAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBe(0);
  });
});

describe('AgoraDB agent operations', () => {
  it('should insert and retrieve an agent', () => {
    const agent = createTestAgent({ name: 'my-agent' });
    db.insertAgent(agent);

    const retrieved = db.getAgentById(agent.agent_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.agent_id).toBe(agent.agent_id);
    expect(retrieved!.name).toBe('my-agent');
    expect(retrieved!.description).toBe(agent.description);
    expect(retrieved!.status).toBe('active');
    expect(retrieved!.tasks_completed).toBe(0);
  });

  it('should enforce unique agent names', () => {
    const agent1 = createTestAgent({ name: 'duplicate-agent' });
    const agent2 = createTestAgent({ agent_id: uuidv4(), name: 'duplicate-agent' });

    db.insertAgent(agent1);
    expect(() => db.insertAgent(agent2)).toThrow();
  });

  it('should list agents with status filter', () => {
    const activeAgent = createTestAgent({ agent_id: uuidv4(), name: 'active-agent', status: 'active' });
    const inactiveAgent = createTestAgent({ agent_id: uuidv4(), name: 'inactive-agent', status: 'inactive' });

    db.insertAgent(activeAgent);
    db.insertAgent(inactiveAgent);

    const active = db.listAgents({ status: 'active' });
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('active-agent');

    const inactive = db.listAgents({ status: 'inactive' });
    expect(inactive.length).toBe(1);
    expect(inactive[0].name).toBe('inactive-agent');

    const all = db.listAgents({ status: 'all' });
    expect(all.length).toBe(2);
  });

  it('should list agents with tag filter', () => {
    const fsAgent = createTestAgent({
      agent_id: uuidv4(),
      name: 'fs-agent',
      capabilities: [{ name: 'read_file', description: 'Read file', tags: ['filesystem', 'read'] }],
    });
    const ghAgent = createTestAgent({
      agent_id: uuidv4(),
      name: 'gh-agent',
      capabilities: [{ name: 'list_prs', description: 'List PRs', tags: ['github', 'pr'] }],
    });

    db.insertAgent(fsAgent);
    db.insertAgent(ghAgent);

    const result = db.listAgents({ tags: ['filesystem'] });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('fs-agent');
  });

  it('should delete an agent', () => {
    const agent = createTestAgent({ name: 'delete-me' });
    db.insertAgent(agent);

    expect(db.getAgentById(agent.agent_id)).not.toBeNull();

    db.deleteAgent(agent.agent_id);

    expect(db.getAgentById(agent.agent_id)).toBeNull();
  });

  it('should retrieve agent by name', () => {
    const agent = createTestAgent({ name: 'named-agent' });
    db.insertAgent(agent);

    const found = db.getAgentByName('named-agent');
    expect(found).not.toBeNull();
    expect(found!.agent_id).toBe(agent.agent_id);
  });

  it('should return null for non-existent agent', () => {
    expect(db.getAgentById('nonexistent-id')).toBeNull();
    expect(db.getAgentByName('nonexistent-name')).toBeNull();
  });
});

describe('AgoraDB task operations', () => {
  let agent: Agent;

  beforeEach(() => {
    agent = createTestAgent({ name: 'task-agent' });
    db.insertAgent(agent);
  });

  it('should insert and retrieve a task', () => {
    const task = createTestTask({
      description: 'Do something important',
      assigned_agent_id: agent.agent_id,
      assigned_agent_name: agent.name,
    });
    db.insertTask(task);

    const retrieved = db.getTask(task.task_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.task_id).toBe(task.task_id);
    expect(retrieved!.description).toBe('Do something important');
    expect(retrieved!.status).toBe('pending');
    expect(retrieved!.assigned_agent_id).toBe(agent.agent_id);
  });

  it('should update task status', () => {
    const task = createTestTask({ assigned_agent_id: agent.agent_id });
    db.insertTask(task);

    const now = new Date().toISOString();
    db.updateTask(task.task_id, { status: 'in_progress', updated_at: now });

    const updated = db.getTask(task.task_id);
    expect(updated!.status).toBe('in_progress');
  });

  it('should cancel pending tasks for an agent', () => {
    const task1 = createTestTask({ task_id: uuidv4(), assigned_agent_id: agent.agent_id, status: 'pending' });
    const task2 = createTestTask({ task_id: uuidv4(), assigned_agent_id: agent.agent_id, status: 'assigned' });
    const task3 = createTestTask({ task_id: uuidv4(), assigned_agent_id: agent.agent_id, status: 'completed' });

    db.insertTask(task1);
    db.insertTask(task2);
    db.insertTask(task3);

    const cancelled = db.cancelPendingTasksForAgent(agent.agent_id);
    expect(cancelled).toBe(2);

    expect(db.getTask(task1.task_id)!.status).toBe('cancelled');
    expect(db.getTask(task2.task_id)!.status).toBe('cancelled');
    expect(db.getTask(task3.task_id)!.status).toBe('completed'); // unchanged
  });

  it('should increment tasks_completed counter', () => {
    expect(db.getAgentById(agent.agent_id)!.tasks_completed).toBe(0);

    db.incrementTasksCompleted(agent.agent_id);
    expect(db.getAgentById(agent.agent_id)!.tasks_completed).toBe(1);

    db.incrementTasksCompleted(agent.agent_id);
    expect(db.getAgentById(agent.agent_id)!.tasks_completed).toBe(2);
  });

  it('should return null for non-existent task', () => {
    expect(db.getTask('nonexistent-task-id')).toBeNull();
  });

  it('should list tasks with status filter', () => {
    const pending = createTestTask({ task_id: uuidv4(), status: 'pending' });
    const completed = createTestTask({ task_id: uuidv4(), status: 'completed' });
    const failed = createTestTask({ task_id: uuidv4(), status: 'failed' });

    db.insertTask(pending);
    db.insertTask(completed);
    db.insertTask(failed);

    const result = db.listTasks({ status: 'pending' });
    expect(result.total).toBe(1);
    expect(result.tasks[0].status).toBe('pending');
  });

  it('should preserve task input and output as JSON', () => {
    const input = { key: 'value', count: 42 };
    const output = { result: 'success', items: [1, 2, 3] };
    const task = createTestTask({
      input,
      output,
      assigned_agent_id: agent.agent_id,
    });
    db.insertTask(task);

    const retrieved = db.getTask(task.task_id);
    expect(retrieved!.input).toEqual(input);
    expect(retrieved!.output).toEqual(output);
  });
});

describe('AgoraDB expireTimedOutTasks', () => {
  let agent: Agent;

  beforeEach(() => {
    agent = createTestAgent({ name: 'expire-agent' });
    db.insertAgent(agent);
  });

  it('should mark assigned tasks as timed_out when past deadline', () => {
    const oldCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const task = createTestTask({
      status: 'assigned',
      timeout_ms: 1,
      created_at: oldCreatedAt,
      assigned_agent_id: agent.agent_id,
    });
    db.insertTask(task);

    const expired = db.expireTimedOutTasks();
    expect(expired).toBe(1);

    const updated = db.getTask(task.task_id);
    expect(updated!.status).toBe('timed_out');
  });

  it('should not affect terminal state tasks', () => {
    const oldCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const completed = createTestTask({ task_id: uuidv4(), status: 'completed', timeout_ms: 1, created_at: oldCreatedAt });
    const cancelled = createTestTask({ task_id: uuidv4(), status: 'cancelled', timeout_ms: 1, created_at: oldCreatedAt });
    const timedOut = createTestTask({ task_id: uuidv4(), status: 'timed_out', timeout_ms: 1, created_at: oldCreatedAt });
    db.insertTask(completed);
    db.insertTask(cancelled);
    db.insertTask(timedOut);

    const expired = db.expireTimedOutTasks();
    expect(expired).toBe(0);

    expect(db.getTask(completed.task_id)!.status).toBe('completed');
    expect(db.getTask(cancelled.task_id)!.status).toBe('cancelled');
    expect(db.getTask(timedOut.task_id)!.status).toBe('timed_out');
  });

  it('should not expire tasks that are still within timeout', () => {
    const task = createTestTask({
      status: 'in_progress',
      timeout_ms: 999_999,
    });
    db.insertTask(task);

    const expired = db.expireTimedOutTasks();
    expect(expired).toBe(0);
    expect(db.getTask(task.task_id)!.status).toBe('in_progress');
  });
});

describe('AgoraDB heartbeat operations', () => {
  it('touchAgent should update last_seen_at', async () => {
    const agent = createTestAgent({ name: 'heartbeat-agent' });
    const originalLastSeen = new Date(Date.now() - 5000).toISOString();
    db.insertAgent({ ...agent, last_seen_at: originalLastSeen });

    await new Promise((r) => setTimeout(r, 10));
    db.touchAgent(agent.agent_id);

    const updated = db.getAgentById(agent.agent_id);
    expect(updated!.last_seen_at > originalLastSeen).toBe(true);
  });

  it('markStaleAgentsInactive should mark old agents inactive', () => {
    const staleLastSeen = new Date(Date.now() - 200_000).toISOString();
    const freshLastSeen = new Date().toISOString();

    const staleAgent = createTestAgent({ agent_id: uuidv4(), name: 'stale-agent', last_seen_at: staleLastSeen });
    const freshAgent = createTestAgent({ agent_id: uuidv4(), name: 'fresh-agent', last_seen_at: freshLastSeen });
    db.insertAgent(staleAgent);
    db.insertAgent(freshAgent);

    const cutoff = new Date(Date.now() - 90_000).toISOString();
    const changed = db.markStaleAgentsInactive(cutoff);

    expect(changed).toBe(1);
    expect(db.getAgentById(staleAgent.agent_id)!.status).toBe('inactive');
    expect(db.getAgentById(freshAgent.agent_id)!.status).toBe('active');
  });
});

describe('AgoraDB getRecentTasks + getAgentStats', () => {
  it('getRecentTasks should return tasks ordered by created_at DESC', () => {
    const task1 = createTestTask({ task_id: uuidv4(), description: 'first', created_at: new Date(Date.now() - 2000).toISOString() });
    const task2 = createTestTask({ task_id: uuidv4(), description: 'second', created_at: new Date(Date.now() - 1000).toISOString() });
    const task3 = createTestTask({ task_id: uuidv4(), description: 'third', created_at: new Date().toISOString() });
    db.insertTask(task1);
    db.insertTask(task2);
    db.insertTask(task3);

    const recent = db.getRecentTasks(3);
    expect(recent.length).toBe(3);
    expect(recent[0].description).toBe('third');
    expect(recent[1].description).toBe('second');
    expect(recent[2].description).toBe('first');
  });

  it('getRecentTasks should respect limit', () => {
    for (let i = 0; i < 5; i++) {
      db.insertTask(createTestTask({ task_id: uuidv4(), description: `task ${i}` }));
    }
    const recent = db.getRecentTasks(3);
    expect(recent.length).toBe(3);
  });

  it('getAgentStats should count active/inactive agents', () => {
    const a1 = createTestAgent({ agent_id: uuidv4(), name: 'a1', status: 'active', tasks_completed: 5 });
    const a2 = createTestAgent({ agent_id: uuidv4(), name: 'a2', status: 'active', tasks_completed: 3 });
    const a3 = createTestAgent({ agent_id: uuidv4(), name: 'a3', status: 'inactive', tasks_completed: 10 });
    db.insertAgent(a1);
    db.insertAgent(a2);
    db.insertAgent(a3);

    const stats = db.getAgentStats();
    expect(stats.active).toBe(2);
    expect(stats.inactive).toBe(1);
    expect(stats.avgTasksCompleted).toBeCloseTo((5 + 3 + 10) / 3, 1);
  });

  it('getAgentStats should return zeros when no agents', () => {
    const stats = db.getAgentStats();
    expect(stats.active).toBe(0);
    expect(stats.inactive).toBe(0);
    expect(stats.avgTasksCompleted).toBe(0);
  });
});

describe('AgoraDB listTasks pagination', () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) {
      db.insertTask(createTestTask({ task_id: uuidv4(), description: `task ${i}` }));
    }
  });

  it('should respect limit', () => {
    const result = db.listTasks({ limit: 2 });
    expect(result.tasks.length).toBe(2);
    expect(result.total).toBe(5);
  });

  it('should respect offset', () => {
    const all = db.listTasks({ limit: 5 });
    const paged = db.listTasks({ limit: 2, offset: 2 });
    expect(paged.tasks.length).toBe(2);
    expect(paged.tasks[0].task_id).toBe(all.tasks[2].task_id);
  });
});

describe('AgoraDB task lease operations', () => {
  it('reclaimExpiredLeases should reclaim in_progress tasks with expired leases', () => {
    const expiredLease = Date.now() - 1000; // expired 1s ago
    const task = createTestTask({
      status: 'in_progress',
      lease_expires_at: expiredLease,
    });
    db.insertTask(task);

    const reclaimed = db.reclaimExpiredLeases();
    expect(reclaimed).toBe(1);

    const updated = db.getTask(task.task_id)!;
    expect(updated.status).toBe('pending');
    expect(updated.assigned_agent_id).toBeUndefined();
    expect(updated.lease_expires_at).toBeUndefined();
  });

  it('reclaimExpiredLeases should not reclaim tasks with valid leases', () => {
    const validLease = Date.now() + 30_000; // expires in 30s
    const task = createTestTask({
      status: 'in_progress',
      lease_expires_at: validLease,
    });
    db.insertTask(task);

    const reclaimed = db.reclaimExpiredLeases();
    expect(reclaimed).toBe(0);
    expect(db.getTask(task.task_id)!.status).toBe('in_progress');
  });

  it('reclaimExpiredLeases should not affect tasks without a lease', () => {
    const task = createTestTask({ status: 'in_progress' }); // no lease
    db.insertTask(task);

    const reclaimed = db.reclaimExpiredLeases();
    expect(reclaimed).toBe(0);
    expect(db.getTask(task.task_id)!.status).toBe('in_progress');
  });

  it('renewTaskLease should extend lease_expires_at', async () => {
    const initialLease = Date.now() + 5_000;
    const task = createTestTask({
      status: 'in_progress',
      lease_expires_at: initialLease,
      lease_duration_ms: 30_000,
    });
    db.insertTask(task);

    await new Promise((r) => setTimeout(r, 10));
    const renewed = db.renewTaskLease(task.task_id, 30_000);
    expect(renewed).toBe(true);

    const updated = db.getTask(task.task_id)!;
    expect(updated.lease_expires_at!).toBeGreaterThan(initialLease);
  });

  it('renewTaskLease should return false for non-in_progress tasks', () => {
    const task = createTestTask({ status: 'pending' });
    db.insertTask(task);

    const renewed = db.renewTaskLease(task.task_id, 30_000);
    expect(renewed).toBe(false);
  });

  it('lease fields should round-trip through insert/get', () => {
    const leaseExpiry = Date.now() + 30_000;
    const task = createTestTask({
      lease_expires_at: leaseExpiry,
      lease_duration_ms: 30_000,
      attempt_count: 2,
    });
    db.insertTask(task);

    const retrieved = db.getTask(task.task_id)!;
    expect(retrieved.lease_expires_at).toBe(leaseExpiry);
    expect(retrieved.lease_duration_ms).toBe(30_000);
    expect(retrieved.attempt_count).toBe(2);
  });
});

describe('AgoraDB progress field', () => {
  it('should persist and retrieve progress field', () => {
    const task = createTestTask({ progress: 42 });
    db.insertTask(task);

    const retrieved = db.getTask(task.task_id);
    expect(retrieved!.progress).toBe(42);
  });

  it('should update progress field', () => {
    const task = createTestTask({ progress: 0 });
    db.insertTask(task);

    db.updateTask(task.task_id, { progress: 75, updated_at: new Date().toISOString() });

    const updated = db.getTask(task.task_id);
    expect(updated!.progress).toBe(75);
  });

  it('should allow undefined progress', () => {
    const task = createTestTask();
    db.insertTask(task);

    const retrieved = db.getTask(task.task_id);
    expect(retrieved!.progress).toBeUndefined();
  });
});
