import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { AgoraDB } from '../src/db.js';
import { findBestAgents } from '../src/matcher.js';
import type { Agent, Task, TaskStatus } from '../src/types.js';

// Helper to create agents and tasks that mirror the tool-level data structures

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

// Simulate what agora_register_agent does
function registerAgent(db: AgoraDB, params: { name: string; description?: string; capabilities: Agent['capabilities']; transport: Agent['transport'] }): Agent {
  const existing = db.getAgentByName(params.name);
  if (existing) throw new Error(`AGENT_EXISTS: Agent "${params.name}" already registered`);

  const now = new Date().toISOString();
  const agent: Agent = {
    agent_id: uuidv4(),
    name: params.name,
    description: params.description ?? '',
    capabilities: params.capabilities,
    transport: params.transport,
    status: 'active',
    registered_at: now,
    last_seen_at: now,
    tasks_completed: 0,
  };
  db.insertAgent(agent);
  return agent;
}

// Simulate what agora_create_task does
function createTask(
  db: AgoraDB,
  params: {
    description: string;
    target_agent_id?: string;
    input?: Record<string, unknown>;
    timeout_ms?: number;
    priority?: Task['priority'];
  }
): { task: Task; error?: string } {
  const now = new Date().toISOString();
  const taskId = uuidv4();
  const timeoutMs = params.timeout_ms ?? 30000;
  const priority = params.priority ?? 'normal';

  let status: TaskStatus = 'pending';
  let assignedAgentId: string | undefined;
  let assignedAgentName: string | undefined;
  let matchedCapability: string | undefined;
  let matchConfidence: number | undefined;

  if (params.target_agent_id) {
    const agent = db.getAgentById(params.target_agent_id);
    if (!agent) return { task: null as unknown as Task, error: `AGENT_NOT_FOUND: Target agent "${params.target_agent_id}" not found` };
    assignedAgentId = agent.agent_id;
    assignedAgentName = agent.name;
    status = 'assigned';
  } else {
    const agents = db.listAgents({ status: 'active' });
    const matches = findBestAgents(params.description, agents, { topK: 1 });
    if (matches.length > 0 && matches[0].confidence >= 0.5) {
      const best = matches[0];
      assignedAgentId = best.agent_id;
      assignedAgentName = best.agent_name;
      matchedCapability = best.matched_capability;
      matchConfidence = best.confidence;
      status = 'assigned';
    }
  }

  const task: Task = {
    task_id: taskId,
    description: params.description,
    status,
    priority,
    input: params.input,
    assigned_agent_id: assignedAgentId,
    assigned_agent_name: assignedAgentName,
    matched_capability: matchedCapability,
    match_confidence: matchConfidence,
    timeout_ms: timeoutMs,
    created_at: now,
    updated_at: now,
  };

  db.insertTask(task);
  return { task };
}

// Simulate what agora_cancel_task does
function cancelTask(db: AgoraDB, taskId: string): { previous_status: TaskStatus; error?: string } {
  const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled', 'timed_out'];
  const task = db.getTask(taskId);
  if (!task) return { previous_status: 'pending', error: `TASK_NOT_FOUND: Task "${taskId}" not found` };
  if (TERMINAL.includes(task.status)) {
    return { previous_status: task.status, error: `TASK_ALREADY_TERMINAL: Task is already in terminal state "${task.status}"` };
  }

  const previousStatus = task.status;
  db.updateTask(taskId, { status: 'cancelled', updated_at: new Date().toISOString() });
  return { previous_status: previousStatus };
}

let db: AgoraDB;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/agora-tools-test-${Date.now()}.db`;
  db = new AgoraDB(dbPath);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const extra = dbPath + suffix;
    if (fs.existsSync(extra)) fs.unlinkSync(extra);
  }
});

describe('register agent flow', () => {
  it('register agent → list agents → should see the agent', () => {
    const agent = registerAgent(db, {
      name: 'my-fs-agent',
      description: 'Filesystem agent',
      capabilities: [{ name: 'read_file', description: 'Read a file', tags: ['filesystem', 'read'] }],
      transport: { type: 'stdio', command: 'node', args: ['agent.js'] },
    });

    const agents = db.listAgents({ status: 'active' });
    expect(agents.length).toBe(1);
    expect(agents[0].agent_id).toBe(agent.agent_id);
    expect(agents[0].name).toBe('my-fs-agent');
  });

  it('register agent with duplicate name → should get error in DB', () => {
    registerAgent(db, {
      name: 'unique-agent',
      capabilities: [{ name: 'op', description: 'Some op', tags: ['misc'] }],
      transport: { type: 'stdio', command: 'node' },
    });

    expect(() =>
      registerAgent(db, {
        name: 'unique-agent',
        capabilities: [{ name: 'op2', description: 'Another op', tags: ['misc'] }],
        transport: { type: 'stdio', command: 'node' },
      })
    ).toThrow(/AGENT_EXISTS/);
  });
});

describe('unregister agent flow', () => {
  it('unregister agent → should remove from list', () => {
    const agent = registerAgent(db, {
      name: 'removable-agent',
      capabilities: [{ name: 'task', description: 'Do task', tags: ['work'] }],
      transport: { type: 'stdio', command: 'node' },
    });

    db.deleteAgent(agent.agent_id);

    const agents = db.listAgents({ status: 'active' });
    expect(agents.find((a) => a.agent_id === agent.agent_id)).toBeUndefined();
  });
});

describe('find agent flow', () => {
  it('find agent → should return best match', () => {
    registerAgent(db, {
      name: 'github-agent',
      description: 'GitHub operations',
      capabilities: [
        { name: 'create_issue', description: 'Create a GitHub issue', tags: ['github', 'issue', 'create'] },
      ],
      transport: { type: 'stdio', command: 'node' },
    });

    const agents = db.listAgents({ status: 'active' });
    const matches = findBestAgents('create a github issue', agents, { topK: 3 });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].agent_name).toBe('github-agent');
    expect(matches[0].matched_capability).toBe('create_issue');
  });
});

describe('create task flow', () => {
  it('create task with auto-routing → should assign to best agent', () => {
    registerAgent(db, {
      name: 'fs-agent',
      description: 'Filesystem agent',
      capabilities: [
        { name: 'read_file', description: 'Read file contents', tags: ['filesystem', 'read', 'file'] },
      ],
      transport: { type: 'stdio', command: 'node' },
    });

    const { task, error } = createTask(db, { description: 'read a file from filesystem' });
    expect(error).toBeUndefined();
    expect(task.status).toBe('assigned');
    expect(task.assigned_agent_name).toBe('fs-agent');
  });

  it('create task with specific agent → should assign to that agent', () => {
    const agent = registerAgent(db, {
      name: 'specific-agent',
      capabilities: [{ name: 'do_thing', description: 'Do a thing', tags: ['thing'] }],
      transport: { type: 'stdio', command: 'node' },
    });

    const { task, error } = createTask(db, {
      description: 'do something arbitrary',
      target_agent_id: agent.agent_id,
    });

    expect(error).toBeUndefined();
    expect(task.status).toBe('assigned');
    expect(task.assigned_agent_id).toBe(agent.agent_id);
    expect(task.assigned_agent_name).toBe('specific-agent');
  });

  it('create task with non-existent agent → should return error', () => {
    const { error } = createTask(db, {
      description: 'do something',
      target_agent_id: 'nonexistent-agent-id',
    });

    expect(error).toMatch(/AGENT_NOT_FOUND/);
  });
});

describe('get task flow', () => {
  it('get task → should return task details', () => {
    const agent = registerAgent(db, {
      name: 'detail-agent',
      capabilities: [{ name: 'process', description: 'Process data', tags: ['process'] }],
      transport: { type: 'stdio', command: 'node' },
    });

    const { task } = createTask(db, {
      description: 'process some data',
      target_agent_id: agent.agent_id,
      input: { data: 'hello' },
    });

    const retrieved = db.getTask(task.task_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.task_id).toBe(task.task_id);
    expect(retrieved!.description).toBe('process some data');
    expect(retrieved!.input).toEqual({ data: 'hello' });
    expect(retrieved!.assigned_agent_id).toBe(agent.agent_id);
  });
});

describe('cancel task flow', () => {
  it('cancel task → should change status to cancelled', () => {
    const agent = registerAgent(db, {
      name: 'cancel-agent',
      capabilities: [{ name: 'work', description: 'Do work', tags: ['work'] }],
      transport: { type: 'stdio', command: 'node' },
    });

    const { task } = createTask(db, {
      description: 'task to cancel',
      target_agent_id: agent.agent_id,
    });

    const result = cancelTask(db, task.task_id);
    expect(result.error).toBeUndefined();
    expect(result.previous_status).toBe('assigned');

    const updated = db.getTask(task.task_id);
    expect(updated!.status).toBe('cancelled');
  });

  it('cancel completed task → should fail (terminal state)', () => {
    const task = createTestTask({ status: 'completed' });
    db.insertTask(task);

    const result = cancelTask(db, task.task_id);
    expect(result.error).toMatch(/TASK_ALREADY_TERMINAL/);
  });
});

describe('list tasks flow', () => {
  it('list tasks with status filter', () => {
    const agent = registerAgent(db, {
      name: 'list-agent',
      capabilities: [{ name: 'work', description: 'Do work', tags: ['work'] }],
      transport: { type: 'stdio', command: 'node' },
    });

    createTask(db, { description: 'first task', target_agent_id: agent.agent_id });
    createTask(db, { description: 'second task', target_agent_id: agent.agent_id });

    const completedTask = createTestTask({ status: 'completed', assigned_agent_id: agent.agent_id });
    db.insertTask(completedTask);

    const assigned = db.listTasks({ status: 'assigned' });
    expect(assigned.total).toBe(2);
    assigned.tasks.forEach((t) => expect(t.status).toBe('assigned'));

    const completed = db.listTasks({ status: 'completed' });
    expect(completed.total).toBe(1);
    expect(completed.tasks[0].status).toBe('completed');
  });
});
