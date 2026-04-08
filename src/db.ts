import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import type { Agent, AgentCapability, AgentTransport, AgoraError, Task } from './types.js';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.agora', 'agora.db');

// Row types as returned from SQLite (all JSON fields are strings)
interface AgentRow {
  agent_id: string;
  name: string;
  description: string;
  capabilities: string;
  transport: string;
  status: string;
  registered_at: string;
  last_seen_at: string;
  tasks_completed: number;
}

interface TaskRow {
  task_id: string;
  description: string;
  status: string;
  priority: string;
  input: string | null;
  output: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  matched_capability: string | null;
  match_confidence: number | null;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  progress: number | null;
  lease_expires_at: number | null;
  lease_duration_ms: number | null;
  attempt_count: number;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    agent_id: row.agent_id,
    name: row.name,
    description: row.description,
    capabilities: JSON.parse(row.capabilities) as AgentCapability[],
    transport: JSON.parse(row.transport) as AgentTransport,
    status: row.status as Agent['status'],
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
    tasks_completed: row.tasks_completed,
  };
}

function rowToTask(row: TaskRow): Task {
  return {
    task_id: row.task_id,
    description: row.description,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    input: row.input != null ? (JSON.parse(row.input) as Record<string, unknown>) : undefined,
    output: row.output != null ? (JSON.parse(row.output) as Record<string, unknown>) : undefined,
    assigned_agent_id: row.assigned_agent_id ?? undefined,
    assigned_agent_name: row.assigned_agent_name ?? undefined,
    matched_capability: row.matched_capability ?? undefined,
    match_confidence: row.match_confidence ?? undefined,
    timeout_ms: row.timeout_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? undefined,
    duration_ms: row.duration_ms ?? undefined,
    error: row.error != null ? (JSON.parse(row.error) as AgoraError) : undefined,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_retry_at: row.next_retry_at ?? undefined,
    progress: row.progress ?? undefined,
    lease_expires_at: row.lease_expires_at ?? undefined,
    lease_duration_ms: row.lease_duration_ms ?? undefined,
    attempt_count: row.attempt_count ?? 0,
  };
}

export class AgoraDB {
  private db: BetterSqlite3.Database;

  // Prepared statements - agents
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtInsertAgent!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtGetAgentById!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtGetAgentByName!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtUpdateAgent!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtDeleteAgent!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtIncrementTasksCompleted!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtTouchAgent!: BetterSqlite3.Statement<any[]>;

  // Prepared statements - tasks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtInsertTask!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtGetTask!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtUpdateTask!: BetterSqlite3.Statement<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtCancelPendingTasksForAgent!: BetterSqlite3.Statement<any[]>;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
    this.prepareStatements();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        capabilities TEXT NOT NULL,
        transport TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        tasks_completed INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'assigned', 'in_progress', 'completed', 'failed', 'timed_out', 'cancelled')),
        priority TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
        input TEXT,
        output TEXT,
        assigned_agent_id TEXT,
        assigned_agent_name TEXT,
        matched_capability TEXT,
        match_confidence REAL,
        timeout_ms INTEGER DEFAULT 30000,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 1,
        next_retry_at INTEGER,
        progress INTEGER CHECK(progress >= 0 AND progress <= 100),
        lease_expires_at INTEGER,
        lease_duration_ms INTEGER DEFAULT 30000,
        attempt_count INTEGER DEFAULT 0,
        FOREIGN KEY (assigned_agent_id) REFERENCES agents(agent_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
    `);

    // Migrate: add retry columns if not present (idempotent)
    const cols = (this.db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(c => c.name);
    if (!cols.includes('attempts')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN attempts INTEGER DEFAULT 0`);
    }
    if (!cols.includes('max_attempts')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN max_attempts INTEGER DEFAULT 1`);
    }
    if (!cols.includes('next_retry_at')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN next_retry_at INTEGER`);
    }
    if (!cols.includes('progress')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN progress INTEGER CHECK(progress >= 0 AND progress <= 100)`);
    }
    if (!cols.includes('lease_expires_at')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER`);
    }
    if (!cols.includes('lease_duration_ms')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN lease_duration_ms INTEGER DEFAULT 30000`);
    }
    if (!cols.includes('attempt_count')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN attempt_count INTEGER DEFAULT 0`);
    }
  }

  private prepareStatements(): void {
    this.stmtInsertAgent = this.db.prepare(`
      INSERT INTO agents (agent_id, name, description, capabilities, transport, status, registered_at, last_seen_at, tasks_completed)
      VALUES (@agent_id, @name, @description, @capabilities, @transport, @status, @registered_at, @last_seen_at, @tasks_completed)
    `);

    this.stmtGetAgentById = this.db.prepare(`
      SELECT * FROM agents WHERE agent_id = ?
    `);

    this.stmtGetAgentByName = this.db.prepare(`
      SELECT * FROM agents WHERE name = ?
    `);

    this.stmtUpdateAgent = this.db.prepare(`
      UPDATE agents
      SET name = @name,
          description = @description,
          capabilities = @capabilities,
          transport = @transport,
          status = @status,
          registered_at = @registered_at,
          last_seen_at = @last_seen_at,
          tasks_completed = @tasks_completed
      WHERE agent_id = @agent_id
    `);

    this.stmtDeleteAgent = this.db.prepare(`
      DELETE FROM agents WHERE agent_id = ?
    `);

    this.stmtIncrementTasksCompleted = this.db.prepare(`
      UPDATE agents SET tasks_completed = tasks_completed + 1 WHERE agent_id = ?
    `);

    this.stmtTouchAgent = this.db.prepare(`
      UPDATE agents SET last_seen_at = ? WHERE agent_id = ?
    `);

    this.stmtInsertTask = this.db.prepare(`
      INSERT INTO tasks (task_id, description, status, priority, input, output, assigned_agent_id, assigned_agent_name,
                         matched_capability, match_confidence, timeout_ms, created_at, updated_at, completed_at, duration_ms, error,
                         attempts, max_attempts, next_retry_at, progress, lease_expires_at, lease_duration_ms, attempt_count)
      VALUES (@task_id, @description, @status, @priority, @input, @output, @assigned_agent_id, @assigned_agent_name,
              @matched_capability, @match_confidence, @timeout_ms, @created_at, @updated_at, @completed_at, @duration_ms, @error,
              @attempts, @max_attempts, @next_retry_at, @progress, @lease_expires_at, @lease_duration_ms, @attempt_count)
    `);

    this.stmtGetTask = this.db.prepare(`
      SELECT * FROM tasks WHERE task_id = ?
    `);

    this.stmtUpdateTask = this.db.prepare(`
      UPDATE tasks
      SET description = @description,
          status = @status,
          priority = @priority,
          input = @input,
          output = @output,
          assigned_agent_id = @assigned_agent_id,
          assigned_agent_name = @assigned_agent_name,
          matched_capability = @matched_capability,
          match_confidence = @match_confidence,
          timeout_ms = @timeout_ms,
          updated_at = @updated_at,
          completed_at = @completed_at,
          duration_ms = @duration_ms,
          error = @error,
          attempts = @attempts,
          max_attempts = @max_attempts,
          next_retry_at = @next_retry_at,
          progress = @progress,
          lease_expires_at = @lease_expires_at,
          lease_duration_ms = @lease_duration_ms,
          attempt_count = @attempt_count
      WHERE task_id = @task_id
    `);

    this.stmtCancelPendingTasksForAgent = this.db.prepare(`
      UPDATE tasks
      SET status = 'cancelled', updated_at = @updated_at
      WHERE assigned_agent_id = @agent_id
        AND status IN ('pending', 'assigned', 'in_progress')
    `);
  }

  // ─── Agent operations ────────────────────────────────────────────────────────

  insertAgent(agent: Agent): void {
    this.stmtInsertAgent.run({
      agent_id: agent.agent_id,
      name: agent.name,
      description: agent.description,
      capabilities: JSON.stringify(agent.capabilities),
      transport: JSON.stringify(agent.transport),
      status: agent.status,
      registered_at: agent.registered_at,
      last_seen_at: agent.last_seen_at,
      tasks_completed: agent.tasks_completed,
    });
  }

  getAgentById(id: string): Agent | null {
    const row = this.stmtGetAgentById.get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  getAgentByName(name: string): Agent | null {
    const row = this.stmtGetAgentByName.get(name) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(filter?: { status?: string; tags?: string[] }): Agent[] {
    let query = 'SELECT * FROM agents';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status && filter.status !== 'all') {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY registered_at ASC';

    const rows = this.db.prepare(query).all(...params) as AgentRow[];
    let agents = rows.map(rowToAgent);

    // Filter by tags in-memory (capabilities is a JSON array)
    if (filter?.tags && filter.tags.length > 0) {
      const requiredTags = filter.tags;
      agents = agents.filter((agent) =>
        agent.capabilities.some((cap) =>
          cap.tags?.some((tag) => requiredTags.includes(tag))
        )
      );
    }

    return agents;
  }

  updateAgent(id: string, updates: Partial<Agent>): void {
    const existing = this.getAgentById(id);
    if (!existing) return;

    const merged: Agent = { ...existing, ...updates };
    this.stmtUpdateAgent.run({
      agent_id: id,
      name: merged.name,
      description: merged.description,
      capabilities: JSON.stringify(merged.capabilities),
      transport: JSON.stringify(merged.transport),
      status: merged.status,
      registered_at: merged.registered_at,
      last_seen_at: merged.last_seen_at,
      tasks_completed: merged.tasks_completed,
    });
  }

  deleteAgent(id: string): void {
    this.stmtDeleteAgent.run(id);
  }

  incrementTasksCompleted(id: string): void {
    this.stmtIncrementTasksCompleted.run(id);
  }

  touchAgent(id: string): void {
    this.stmtTouchAgent.run(new Date().toISOString(), id);
  }

  markStaleAgentsInactive(cutoffIso: string): number {
    const result = this.db
      .prepare(
        `UPDATE agents SET status = 'inactive'
         WHERE status = 'active' AND last_seen_at < ?`
      )
      .run(cutoffIso);
    return result.changes;
  }

  // ─── Task operations ─────────────────────────────────────────────────────────

  insertTask(task: Task): void {
    this.stmtInsertTask.run({
      task_id: task.task_id,
      description: task.description,
      status: task.status,
      priority: task.priority,
      input: task.input != null ? JSON.stringify(task.input) : null,
      output: task.output != null ? JSON.stringify(task.output) : null,
      assigned_agent_id: task.assigned_agent_id ?? null,
      assigned_agent_name: task.assigned_agent_name ?? null,
      matched_capability: task.matched_capability ?? null,
      match_confidence: task.match_confidence ?? null,
      timeout_ms: task.timeout_ms,
      created_at: task.created_at,
      updated_at: task.updated_at,
      completed_at: task.completed_at ?? null,
      duration_ms: task.duration_ms ?? null,
      error: task.error != null ? JSON.stringify(task.error) : null,
      attempts: task.attempts ?? 0,
      max_attempts: task.max_attempts ?? 1,
      next_retry_at: task.next_retry_at ?? null,
      progress: task.progress ?? null,
      lease_expires_at: task.lease_expires_at ?? null,
      lease_duration_ms: task.lease_duration_ms ?? null,
      attempt_count: task.attempt_count ?? 0,
    });
  }

  getTask(id: string): Task | null {
    const row = this.stmtGetTask.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(filter?: {
    status?: string;
    agent_id?: string;
    limit?: number;
    offset?: number;
  }): { tasks: Task[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    if (filter?.agent_id) {
      conditions.push('assigned_agent_id = ?');
      params.push(filter.agent_id);
    }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM tasks${where}`)
      .get(...params) as { count: number };
    const total = countRow.count;

    const limit = filter?.limit ?? 100;
    const offset = filter?.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM tasks${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as TaskRow[];

    return { tasks: rows.map(rowToTask), total };
  }

  updateTask(id: string, updates: Partial<Task>): void {
    const existing = this.getTask(id);
    if (!existing) return;

    const merged: Task = { ...existing, ...updates };
    this.stmtUpdateTask.run({
      task_id: id,
      description: merged.description,
      status: merged.status,
      priority: merged.priority,
      input: merged.input != null ? JSON.stringify(merged.input) : null,
      output: merged.output != null ? JSON.stringify(merged.output) : null,
      assigned_agent_id: merged.assigned_agent_id ?? null,
      assigned_agent_name: merged.assigned_agent_name ?? null,
      matched_capability: merged.matched_capability ?? null,
      match_confidence: merged.match_confidence ?? null,
      timeout_ms: merged.timeout_ms,
      updated_at: merged.updated_at,
      completed_at: merged.completed_at ?? null,
      duration_ms: merged.duration_ms ?? null,
      error: merged.error != null ? JSON.stringify(merged.error) : null,
      attempts: merged.attempts ?? 0,
      max_attempts: merged.max_attempts ?? 1,
      next_retry_at: merged.next_retry_at ?? null,
      progress: merged.progress ?? null,
      lease_expires_at: merged.lease_expires_at ?? null,
      lease_duration_ms: merged.lease_duration_ms ?? null,
      attempt_count: merged.attempt_count ?? 0,
    });
  }

  cancelPendingTasksForAgent(agentId: string): number {
    const result = this.stmtCancelPendingTasksForAgent.run({
      agent_id: agentId,
      updated_at: new Date().toISOString(),
    });
    return result.changes;
  }

  expireTimedOutTasks(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'timed_out', updated_at = ?
         WHERE status IN ('assigned', 'in_progress')
           AND (CAST(strftime('%s', created_at) AS INTEGER) * 1000 + timeout_ms) < ?`
      )
      .run(new Date().toISOString(), now);
    return result.changes;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getRetryableTasks(): Task[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'pending'
           AND next_retry_at IS NOT NULL
           AND next_retry_at <= ?`
      )
      .all(now) as TaskRow[];
    return rows.map(rowToTask);
  }

  reclaimExpiredLeases(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'pending',
             assigned_agent_id = NULL,
             assigned_agent_name = NULL,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE status = 'in_progress'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?`
      )
      .run(new Date().toISOString(), now);
    return result.changes;
  }

  renewTaskLease(taskId: string, extendMs: number): boolean {
    const task = this.getTask(taskId);
    if (!task || task.status !== 'in_progress' || task.lease_expires_at == null) {
      return false;
    }
    const newExpiry = Date.now() + extendMs;
    this.db
      .prepare(`UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE task_id = ?`)
      .run(newExpiry, new Date().toISOString(), taskId);
    return true;
  }

  getRecentTasks(limit = 20): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  getAgentStats(): { active: number; inactive: number; avgTasksCompleted: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
           AVG(tasks_completed) AS avgTasksCompleted
         FROM agents`
      )
      .get() as { active: number | null; inactive: number | null; avgTasksCompleted: number | null };
    return {
      active: row.active ?? 0,
      inactive: row.inactive ?? 0,
      avgTasksCompleted: row.avgTasksCompleted ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

export default AgoraDB;
