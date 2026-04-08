import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgoraDB } from './db.js';
import { registerTools } from './tools.js';
import { AgentExecutor } from './executor.js';
import { findBestAgents } from './matcher.js';
import { PROTOCOL_VERSION } from './types.js';

export function createServer(dbPath?: string): McpServer {
  const db = new AgoraDB(dbPath);

  const server = new McpServer({
    name: 'agora',
    version: PROTOCOL_VERSION,
  });

  const executor = new AgentExecutor();
  registerTools(server, db, executor);

  // Expire timed-out tasks every 30 seconds
  const timeoutSweeper = setInterval(() => {
    db.expireTimedOutTasks();
  }, 30_000);
  timeoutSweeper.unref();

  // Mark agents inactive after 90s without heartbeat (check every 60s)
  const healthSweeper = setInterval(() => {
    const thresholdMs = 90_000;
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();
    db.markStaleAgentsInactive(cutoff);
  }, 60_000);
  healthSweeper.unref();

  // Retry failed tasks with exponential backoff (check every 10s)
  const retrySweeper = setInterval(() => {
    const retryable = db.getRetryableTasks();
    for (const task of retryable) {
      // Clear next_retry_at so it won't be picked up again immediately
      db.updateTask(task.task_id, {
        next_retry_at: undefined,
        updated_at: new Date().toISOString(),
      });
      // Re-run matcher (original agent may be inactive now)
      const agents = db.listAgents({ status: 'active' });
      const matches = findBestAgents(task.description, agents, { topK: 1 });
      if (matches.length > 0 && matches[0].confidence >= 0.5) {
        const best = matches[0];
        const agent = db.getAgentById(best.agent_id);
        if (!agent) continue;
        db.updateTask(task.task_id, {
          status: 'assigned',
          assigned_agent_id: best.agent_id,
          assigned_agent_name: best.agent_name,
          matched_capability: best.matched_capability,
          match_confidence: best.confidence,
          updated_at: new Date().toISOString(),
        });
        void executor.dispatch(task, agent).catch(() => {
          // Will be retried or failed by dispatch error handling
        });
      } else {
        // No agent available — mark failed if exhausted attempts
        db.updateTask(task.task_id, {
          status: 'failed',
          error: { code: 'NO_MATCH', message: 'No suitable agent found on retry' },
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
      }
    }
  }, 10_000);
  retrySweeper.unref();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    clearInterval(timeoutSweeper);
    clearInterval(healthSweeper);
    clearInterval(retrySweeper);
    executor.closeAll().catch(() => {});
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timeoutSweeper);
    clearInterval(healthSweeper);
    clearInterval(retrySweeper);
    executor.closeAll().catch(() => {});
    db.close();
    process.exit(0);
  });

  return server;
}

export async function startServer(dbPath?: string): Promise<void> {
  const server = createServer(dbPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// If run directly
const isMain = process.argv[1]?.endsWith('server.js');
if (isMain) {
  startServer().catch((err) => {
    console.error('Failed to start Agora server:', err);
    process.exit(1);
  });
}
