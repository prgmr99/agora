// src/executor.ts - Agent dispatch layer
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Agent, Task } from './types.js';

export interface AgentClient {
  call(toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

class StdioAgentClient implements AgentClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(agent: Agent & { transport: { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } }) {
    this.transport = new StdioClientTransport({
      command: agent.transport.command,
      args: agent.transport.args ?? [],
      env: agent.transport.env,
    });
    this.client = new Client({ name: 'agora-executor', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async call(toolName: string, input: Record<string, unknown>, _signal: AbortSignal): Promise<unknown> {
    const result = await this.client.callTool({ name: toolName, arguments: input });
    return result;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class HttpAgentClient implements AgentClient {
  private client: Client;
  private connected = false;
  private agentTransport: { type: 'http'; url: string; headers?: Record<string, string> };

  constructor(agent: Agent & { transport: { type: 'http'; url: string; headers?: Record<string, string> } }) {
    this.agentTransport = agent.transport;
    this.client = new Client({ name: 'agora-executor', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    try {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const transport = new StreamableHTTPClientTransport(
        new URL(this.agentTransport.url),
        this.agentTransport.headers ? { requestInit: { headers: this.agentTransport.headers } } : undefined
      );
      await this.client.connect(transport);
      this.connected = true;
    } catch (err) {
      throw new Error(`Failed to connect to HTTP agent at ${this.agentTransport.url}: ${String(err)}`);
    }
  }

  async call(toolName: string, input: Record<string, unknown>, _signal: AbortSignal): Promise<unknown> {
    if (!this.connected) await this.connect();
    const result = await this.client.callTool({ name: toolName, arguments: input });
    return result;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class AgentExecutor {
  private pool = new Map<string, AgentClient>();

  private async getClient(agent: Agent): Promise<AgentClient> {
    const existing = this.pool.get(agent.agent_id);
    if (existing) return existing;

    let client: AgentClient;
    if (agent.transport.type === 'stdio') {
      const sc = new StdioAgentClient(agent as Agent & { transport: { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } });
      await sc.connect();
      client = sc;
    } else {
      const hc = new HttpAgentClient(agent as Agent & { transport: { type: 'http'; url: string; headers?: Record<string, string> } });
      await hc.connect();
      client = hc;
    }

    this.pool.set(agent.agent_id, client);
    return client;
  }

  async dispatch(task: Task, agent: Agent): Promise<unknown> {
    const signal = AbortSignal.timeout(task.timeout_ms);
    const client = await this.getClient(agent);
    return client.call(task.matched_capability ?? task.description, task.input ?? {}, signal);
  }

  async closeAgent(agentId: string): Promise<void> {
    const client = this.pool.get(agentId);
    if (client) {
      await client.close();
      this.pool.delete(agentId);
    }
  }

  async closeAll(): Promise<void> {
    for (const [id, client] of this.pool) {
      await client.close();
      this.pool.delete(id);
    }
  }
}
