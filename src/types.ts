// src/types.ts - Agora MVP Core Types

export const PROTOCOL_VERSION = '0.1.0';

// === Agent Types ===

export interface AgentCapability {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
  tags: string[];
}

export type AgentTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface Agent {
  agent_id: string;
  name: string;
  description: string;
  capabilities: AgentCapability[];
  transport: AgentTransport;
  status: 'active' | 'inactive';
  registered_at: string;
  last_seen_at: string;
  tasks_completed: number;
}

// === Task Types ===

export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';

export interface Task {
  task_id: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  assigned_agent_id?: string;
  assigned_agent_name?: string;
  matched_capability?: string;
  match_confidence?: number;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  duration_ms?: number;
  error?: AgoraError;
  attempts: number;
  max_attempts: number;
  next_retry_at?: number;  // epoch ms; undefined means no retry scheduled
}

// === Error Types ===

export interface AgoraError {
  code: AgoraErrorCode;
  message: string;
}

export type AgoraErrorCode =
  | 'AGENT_EXISTS'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_BUSY'
  | 'AGENT_UNAVAILABLE'
  | 'INVALID_SCHEMA'
  | 'CAPABILITY_LIMIT'
  | 'NO_AGENTS'
  | 'NO_MATCH'
  | 'TASK_NOT_FOUND'
  | 'TASK_TIMEOUT'
  | 'TASK_ALREADY_TERMINAL'
  | 'INVALID_TRANSITION'
  | 'AGENT_ERROR'
  | 'SCHEMA_MISMATCH'
  | 'DB_ERROR'
  | 'INTERNAL_ERROR';

// === Matching Types ===

export interface MatchResult {
  agent_id: string;
  agent_name: string;
  matched_capability: string;
  confidence: number;
  match_reason: string;
}

// === Tool Input/Output Types ===

export interface RegisterAgentInput {
  name: string;
  description?: string;
  capabilities: AgentCapability[];
  transport: AgentTransport;
}

export interface RegisterAgentOutput {
  agent_id: string;
  name: string;
  registered_at: string;
  capabilities_count: number;
  status: 'active';
}

export interface UnregisterAgentInput {
  agent_id: string;
}

export interface UnregisterAgentOutput {
  agent_id: string;
  name: string;
  unregistered_at: string;
  pending_tasks_cancelled: number;
}

export interface ListAgentsInput {
  tags?: string[];
  status?: 'active' | 'inactive' | 'all';
}

export interface ListAgentsOutput {
  agents: Array<{
    agent_id: string;
    name: string;
    description: string;
    status: string;
    capabilities_count: number;
    capabilities: string[];
    tasks_completed: number;
    registered_at: string;
  }>;
  total: number;
}

export interface FindAgentInput {
  task_description: string;
  required_tags?: string[];
  top_k?: number;
}

export interface FindAgentOutput {
  matches: MatchResult[];
  total_candidates: number;
}

export interface CreateTaskInput {
  description: string;
  target_agent_id?: string;
  input?: Record<string, unknown>;
  timeout_ms?: number;
  priority?: TaskPriority;
}

export interface CreateTaskOutput {
  task_id: string;
  status: TaskStatus;
  assigned_agent?: {
    agent_id: string;
    agent_name: string;
    matched_capability: string;
    confidence: number;
  };
  created_at: string;
  result?: {
    data: unknown;
    completed_at: string;
    duration_ms: number;
  };
}

export interface GetTaskInput {
  task_id: string;
}

export interface GetTaskOutput {
  task_id: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_agent?: {
    agent_id: string;
    agent_name: string;
    matched_capability: string;
    confidence: number;
  };
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  duration_ms?: number;
  error?: AgoraError;
}

export interface ListTasksInput {
  status?: TaskStatus;
  agent_id?: string;
  limit?: number;
  offset?: number;
}

export interface ListTasksOutput {
  tasks: GetTaskOutput[];
  total: number;
}

export interface CancelTaskInput {
  task_id: string;
  reason?: string;
}

export interface CancelTaskOutput {
  task_id: string;
  previous_status: TaskStatus;
  cancelled_at: string;
}
