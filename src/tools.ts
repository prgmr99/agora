// src/tools.ts - Agora MVP MCP Tool Handlers

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgoraDB } from './db.js';
import { findBestAgents } from './matcher.js';
import type {
  Agent,
  Task,
  TaskStatus,
  TaskPriority,
  AgoraErrorCode,
} from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorResult(code: AgoraErrorCode, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true as const,
  };
}

function okResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled', 'timed_out'];

// ─── Zod sub-schemas ──────────────────────────────────────────────────────────

const CapabilitySchema = z.object({
  name: z.string().describe('Capability name'),
  description: z.string().describe('What this capability does'),
  tags: z.array(z.string()).describe('Tags for matching'),
  input_schema: z.record(z.string(), z.unknown()).optional().describe('Optional JSON schema for capability input'),
});

const TransportSchema = z.object({
  type: z.literal('stdio').describe('Transport type (only stdio supported)'),
  command: z.string().describe('Command to run the agent'),
  args: z.array(z.string()).optional().describe('Command arguments'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
});

// ─── registerTools ────────────────────────────────────────────────────────────

export function registerTools(server: McpServer, db: AgoraDB): void {

  // ── 1. agora_register_agent ─────────────────────────────────────────────────
  server.tool(
    'agora_register_agent',
    'Register an agent (MCP server) with its capabilities',
    {
      name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).describe('Unique agent name'),
      description: z.string().max(512).optional().describe('Human-readable agent description'),
      capabilities: z.array(CapabilitySchema).min(1).max(100).describe('List of capabilities this agent offers'),
      transport: TransportSchema.describe('How to connect to this agent'),
    },
    async (params) => {
      try {
        const existing = db.getAgentByName(params.name);
        if (existing) {
          return errorResult('AGENT_EXISTS', `Agent with name "${params.name}" is already registered`);
        }

        const now = new Date().toISOString();
        const agent: Agent = {
          agent_id: uuidv4(),
          name: params.name,
          description: params.description ?? '',
          capabilities: params.capabilities.map((c) => ({
            name: c.name,
            description: c.description,
            tags: c.tags,
            ...(c.input_schema !== undefined ? { input_schema: c.input_schema } : {}),
          })),
          transport: {
            type: 'stdio',
            command: params.transport.command,
            ...(params.transport.args !== undefined ? { args: params.transport.args } : {}),
            ...(params.transport.env !== undefined ? { env: params.transport.env as Record<string, string> } : {}),
          },
          status: 'active',
          registered_at: now,
          last_seen_at: now,
          tasks_completed: 0,
        };

        db.insertAgent(agent);

        return okResult({
          agent_id: agent.agent_id,
          name: agent.name,
          registered_at: agent.registered_at,
          capabilities_count: agent.capabilities.length,
          status: 'active',
        });
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );

  // ── 2. agora_unregister_agent ───────────────────────────────────────────────
  server.tool(
    'agora_unregister_agent',
    'Unregister an agent and cancel its pending tasks',
    {
      agent_id: z.string().describe('ID of the agent to unregister'),
    },
    async (params) => {
      try {
        const agent = db.getAgentById(params.agent_id);
        if (!agent) {
          return errorResult('AGENT_NOT_FOUND', `Agent "${params.agent_id}" not found`);
        }

        const cancelled = db.cancelPendingTasksForAgent(params.agent_id);
        db.deleteAgent(params.agent_id);

        return okResult({
          agent_id: params.agent_id,
          name: agent.name,
          unregistered_at: new Date().toISOString(),
          pending_tasks_cancelled: cancelled,
        });
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );

  // ── 3. agora_list_agents ────────────────────────────────────────────────────
  server.tool(
    'agora_list_agents',
    'List registered agents with optional filters',
    {
      tags: z.array(z.string()).optional().describe('Filter agents that have at least one capability with these tags'),
      status: z.enum(['active', 'inactive', 'all']).optional().describe('Filter by agent status (default: active)'),
    },
    async (params) => {
      try {
        const agents = db.listAgents({
          status: params.status ?? 'active',
          tags: params.tags,
        });

        const result = agents.map((a) => ({
          agent_id: a.agent_id,
          name: a.name,
          description: a.description,
          status: a.status,
          capabilities_count: a.capabilities.length,
          capabilities: a.capabilities.map((c) => c.name),
          tasks_completed: a.tasks_completed,
          registered_at: a.registered_at,
        }));

        return okResult({ agents: result, total: result.length });
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );

  // ── 4. agora_find_agent ─────────────────────────────────────────────────────
  server.tool(
    'agora_find_agent',
    'Find the best matching agents for a task description',
    {
      task_description: z.string().describe('Natural-language description of the task'),
      required_tags: z.array(z.string()).optional().describe('Tags that matched capabilities must have'),
      top_k: z.number().int().positive().optional().describe('Maximum number of matches to return (default: 3)'),
    },
    async (params) => {
      try {
        const agents = db.listAgents({ status: 'active' });
        const matches = findBestAgents(params.task_description, agents, {
          requiredTags: params.required_tags,
          topK: params.top_k ?? 3,
        });

        return okResult({ matches, total_candidates: agents.length });
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );

  // ── 5. agora_create_task ────────────────────────────────────────────────────
  server.tool(
    'agora_create_task',
    'Create a task and optionally route it to an agent',
    {
      description: z.string().describe('What needs to be done'),
      target_agent_id: z.string().optional().describe('Assign directly to this agent ID'),
      input: z.record(z.string(), z.unknown()).optional().describe('Input data for the task'),
      timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds (default: 30000)'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Task priority (default: normal)'),
    },
    async (params) => {
      try {
        const now = new Date().toISOString();
        const taskId = uuidv4();
        const timeoutMs = params.timeout_ms ?? 30000;
        const priority: TaskPriority = params.priority ?? 'normal';

        let status: TaskStatus = 'pending';
        let assignedAgentId: string | undefined;
        let assignedAgentName: string | undefined;
        let matchedCapability: string | undefined;
        let matchConfidence: number | undefined;

        if (params.target_agent_id) {
          const agent = db.getAgentById(params.target_agent_id);
          if (!agent) {
            return errorResult('AGENT_NOT_FOUND', `Target agent "${params.target_agent_id}" not found`);
          }
          assignedAgentId = agent.agent_id;
          assignedAgentName = agent.name;
          status = 'assigned';
        } else {
          // Auto-route via matcher
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

        const response: Record<string, unknown> = {
          task_id: taskId,
          status,
          created_at: now,
        };

        if (assignedAgentId) {
          response.assigned_agent = {
            agent_id: assignedAgentId,
            agent_name: assignedAgentName,
            matched_capability: matchedCapability ?? null,
            confidence: matchConfidence ?? null,
          };
        }

        return okResult(response);
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );

  // ── 6. agora_get_task ───────────────────────────────────────────────────────
  server.tool(
    'agora_get_task',
    'Get full details of a task by ID',
    {
      task_id: z.string().describe('ID of the task to retrieve'),
    },
    async (params) => {
      try {
        const task = db.getTask(params.task_id);
        if (!task) {
          return errorResult('TASK_NOT_FOUND', `Task "${params.task_id}" not found`);
        }

        const response: Record<string, unknown> = {
          task_id: task.task_id,
          description: task.description,
          status: task.status,
          priority: task.priority,
          input: task.input,
          output: task.output,
          created_at: task.created_at,
          updated_at: task.updated_at,
          completed_at: task.completed_at,
          duration_ms: task.duration_ms,
          error: task.error,
        };

        if (task.assigned_agent_id) {
          response.assigned_agent = {
            agent_id: task.assigned_agent_id,
            agent_name: task.assigned_agent_name,
            matched_capability: task.matched_capability ?? null,
            confidence: task.match_confidence ?? null,
          };
        }

        return okResult(response);
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );

  // ── 7. agora_list_tasks ─────────────────────────────────────────────────────
  server.tool(
    'agora_list_tasks',
    'List tasks with optional filters',
    {
      status: z.enum(['pending', 'assigned', 'in_progress', 'completed', 'failed', 'timed_out', 'cancelled']).optional().describe('Filter by task status'),
      agent_id: z.string().optional().describe('Filter tasks assigned to this agent'),
      limit: z.number().int().positive().optional().describe('Maximum tasks to return (default: 20)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default: 0)'),
    },
    async (params) => {
      try {
        db.expireTimedOutTasks();

        const limit = params.limit ?? 20;
        const offset = params.offset ?? 0;

        const { tasks, total } = db.listTasks({
          status: params.status,
          agent_id: params.agent_id,
          limit,
          offset,
        });

        const mapped = tasks.map((task) => {
          const item: Record<string, unknown> = {
            task_id: task.task_id,
            description: task.description,
            status: task.status,
            priority: task.priority,
            input: task.input,
            output: task.output,
            created_at: task.created_at,
            updated_at: task.updated_at,
            completed_at: task.completed_at,
            duration_ms: task.duration_ms,
            error: task.error,
          };

          if (task.assigned_agent_id) {
            item.assigned_agent = {
              agent_id: task.assigned_agent_id,
              agent_name: task.assigned_agent_name,
              matched_capability: task.matched_capability ?? null,
              confidence: task.match_confidence ?? null,
            };
          }

          return item;
        });

        return okResult({ tasks: mapped, total, limit, offset });
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );

  // ── 8. agora_cancel_task ────────────────────────────────────────────────────
  server.tool(
    'agora_cancel_task',
    'Cancel a task that has not yet reached a terminal state',
    {
      task_id: z.string().describe('ID of the task to cancel'),
      reason: z.string().optional().describe('Optional reason for cancellation'),
    },
    async (params) => {
      try {
        const task = db.getTask(params.task_id);
        if (!task) {
          return errorResult('TASK_NOT_FOUND', `Task "${params.task_id}" not found`);
        }

        if (TERMINAL_STATUSES.includes(task.status)) {
          return errorResult(
            'TASK_ALREADY_TERMINAL',
            `Task "${params.task_id}" is already in terminal state "${task.status}"`
          );
        }

        const previousStatus = task.status;
        const now = new Date().toISOString();

        db.updateTask(params.task_id, {
          status: 'cancelled',
          updated_at: now,
        });

        return okResult({
          task_id: params.task_id,
          previous_status: previousStatus,
          cancelled_at: now,
          ...(params.reason ? { reason: params.reason } : {}),
        });
      } catch (err) {
        return errorResult('INTERNAL_ERROR', `Unexpected error: ${String(err)}`);
      }
    }
  );
}
