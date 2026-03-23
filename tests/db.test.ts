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
