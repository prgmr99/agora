// src/cli.ts - Agora MVP CLI

import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgoraDB } from './db.js';
import { startServer } from './server.js';
import { PROTOCOL_VERSION } from './types.js';

// ANSI color codes
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const AGORA_DIR = path.join(os.homedir(), '.agora');
const CONFIG_PATH = path.join(AGORA_DIR, 'config.json');
const DB_PATH = path.join(AGORA_DIR, 'agora.db');

const DEFAULT_CONFIG = {
  protocol_version: '0.1.0',
  storage: { path: '~/.agora/agora.db' },
  transport: { type: 'stdio' },
  matching: {
    algorithm: 'keyword',
    min_confidence: 0.1,
    auto_assign_threshold: 0.5,
  },
  timeouts: {
    default_task_ms: 30000,
    agent_spawn_ms: 10000,
  },
};

// Known MCP config paths to scan during auto-discovery
const KNOWN_MCP_CONFIG_PATHS = [
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json'
  ),
  path.join(os.homedir(), '.cursor', 'mcp.json'),
  path.join(process.cwd(), '.mcp.json'),
];

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

function discoverMcpServers(): void {
  console.log(`\n${BOLD}${CYAN}Auto-discovering MCP servers...${RESET}`);

  let foundAny = false;

  for (const configPath of KNOWN_MCP_CONFIG_PATHS) {
    if (!fs.existsSync(configPath)) {
      continue;
    }

    let parsed: McpConfigFile;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      parsed = JSON.parse(raw) as McpConfigFile;
    } catch {
      console.log(`  ${YELLOW}Warning: Could not parse ${configPath}${RESET}`);
      continue;
    }

    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== 'object') {
      continue;
    }

    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
      continue;
    }

    foundAny = true;
    console.log(`\n  ${GREEN}Found config: ${configPath}${RESET}`);
    for (const name of serverNames) {
      const entry = servers[name];
      const cmd = entry.command ?? '(unknown)';
      const args = entry.args ? entry.args.join(' ') : '';
      console.log(`    ${CYAN}${name}${RESET}: ${cmd}${args ? ' ' + args : ''}`);
    }
  }

  if (!foundAny) {
    console.log(`  ${YELLOW}No existing MCP server configs found.${RESET}`);
  }
}

const program = new Command();

program
  .name('agora')
  .description('Agora - MCP-native smart task router for your AI agents')
  .version(PROTOCOL_VERSION);

program
  .command('init')
  .description('Initialize Agora configuration and database')
  // eslint-disable-next-line @typescript-eslint/require-await
  .action(async () => {
    console.log(`\n${BOLD}${CYAN}Initializing Agora...${RESET}\n`);

    // 1. Create ~/.agora/ directory
    if (!fs.existsSync(AGORA_DIR)) {
      fs.mkdirSync(AGORA_DIR, { recursive: true });
      console.log(`${GREEN}Created directory: ${AGORA_DIR}${RESET}`);
    } else {
      console.log(`${YELLOW}Directory already exists: ${AGORA_DIR}${RESET}`);
    }

    // 2. Create config.json with defaults (don't overwrite if exists)
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      console.log(`${GREEN}Created config: ${CONFIG_PATH}${RESET}`);
    } else {
      console.log(`${YELLOW}Config already exists: ${CONFIG_PATH}${RESET}`);
    }

    // 3. Initialize the SQLite database (AgoraDB constructor creates tables)
    try {
      const db = new AgoraDB(DB_PATH);
      db.close();
      console.log(`${GREEN}Initialized database: ${DB_PATH}${RESET}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31mFailed to initialize database: ${msg}\x1b[0m`);
      process.exit(1);
    }

    // 4. Auto-discover existing MCP servers
    discoverMcpServers();

    // 5. Print MCP client config snippet
    console.log(`
${BOLD}${CYAN}Add this to your MCP client config (e.g., claude_desktop_config.json):${RESET}

${YELLOW}{
  "mcpServers": {
    "agora": {
      "command": "npx",
      "args": ["-y", "@agora/mcp-server", "serve"]
    }
  }
}${RESET}
`);

    console.log(`${GREEN}${BOLD}Agora initialized successfully!${RESET}`);
  });

program
  .command('serve')
  .description('Start the Agora MCP server')
  .option('--db <path>', 'Path to SQLite database')
  .action(async (options: { db?: string }) => {
    await startServer(options.db);
  });

program.parse();
