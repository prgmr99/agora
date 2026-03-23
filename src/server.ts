import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgoraDB } from './db.js';
import { registerTools } from './tools.js';
import { PROTOCOL_VERSION } from './types.js';

export async function createServer(dbPath?: string): Promise<McpServer> {
  const db = new AgoraDB(dbPath);

  const server = new McpServer({
    name: 'agora',
    version: PROTOCOL_VERSION,
  });

  registerTools(server, db);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });

  return server;
}

export async function startServer(dbPath?: string): Promise<void> {
  const server = await createServer(dbPath);
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
