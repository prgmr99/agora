import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { tokenize, scoreCapability, findBestAgents } from '../src/matcher.js';
import type { Agent } from '../src/types.js';

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

const filesystemAgent = createTestAgent({
  agent_id: uuidv4(),
  name: 'filesystem-agent',
  description: 'Agent for filesystem operations',
  capabilities: [
    {
      name: 'read_file',
      description: 'Read file contents',
      tags: ['filesystem', 'read', 'file'],
    },
    {
      name: 'write_file',
      description: 'Write content to file',
      tags: ['filesystem', 'write', 'file'],
    },
  ],
});

const githubAgent = createTestAgent({
  agent_id: uuidv4(),
  name: 'github-agent',
  description: 'Agent for GitHub operations',
  capabilities: [
    {
      name: 'list_prs',
      description: 'List pull requests',
      tags: ['github', 'pr', 'list'],
    },
    {
      name: 'create_issue',
      description: 'Create a GitHub issue',
      tags: ['github', 'issue', 'create'],
    },
  ],
});

describe('tokenize', () => {
  it('should split text into lowercase keywords and remove stopwords', () => {
    const result = tokenize('Read the file contents from disk');
    expect(result).toContain('read');
    expect(result).toContain('file');
    expect(result).toContain('contents');
    expect(result).toContain('disk');
    // stopwords removed
    expect(result).not.toContain('the');
    expect(result).not.toContain('from');
  });

  it('should handle empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('should handle all-stopword strings', () => {
    expect(tokenize('the a an is are')).toEqual([]);
  });

  it('should split on underscores and dashes', () => {
    const result = tokenize('read_file write-content');
    expect(result).toContain('read');
    expect(result).toContain('file');
    expect(result).toContain('write');
    expect(result).toContain('content');
  });

  it('should lowercase all tokens', () => {
    const result = tokenize('Read FILE Write');
    expect(result).toContain('read');
    expect(result).toContain('file');
    expect(result).toContain('write');
    expect(result).not.toContain('Read');
    expect(result).not.toContain('FILE');
  });
});

describe('scoreCapability', () => {
  it('should score higher for name matches than description matches', () => {
    const capWithNameMatch = {
      name: 'read_file',
      description: 'Performs some operation',
      tags: ['misc'],
    };
    const capWithDescMatch = {
      name: 'some_operation',
      description: 'Read file from disk',
      tags: ['misc'],
    };

    const tokens = tokenize('read file');
    const nameScore = scoreCapability(tokens, capWithNameMatch).score;
    const descScore = scoreCapability(tokens, capWithDescMatch).score;

    expect(nameScore).toBeGreaterThan(descScore);
  });

  it('should return zero score for empty tokens', () => {
    const cap = { name: 'read_file', description: 'Read a file', tags: ['file'] };
    const result = scoreCapability([], cap);
    expect(result.score).toBe(0);
  });

  it('should return a reason string explaining the match', () => {
    const tokens = tokenize('read file');
    const cap = { name: 'read_file', description: 'Read file contents', tags: ['file', 'read'] };
    const result = scoreCapability(tokens, cap);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('should give higher score for tag matches vs description matches', () => {
    const capWithTag = {
      name: 'some_op',
      description: 'Does something',
      tags: ['read', 'file'],
    };
    const capWithDesc = {
      name: 'some_op',
      description: 'Read a file',
      tags: ['misc'],
    };

    const tokens = tokenize('read file');
    const tagScore = scoreCapability(tokens, capWithTag).score;
    const descScore = scoreCapability(tokens, capWithDesc).score;

    expect(tagScore).toBeGreaterThan(descScore);
  });
});

describe('findBestAgents', () => {
  const agents = [filesystemAgent, githubAgent];

  it('should return agents sorted by confidence descending', () => {
    const results = findBestAgents('read a file from filesystem', agents);
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
    }
  });

  it('should filter by required_tags', () => {
    const results = findBestAgents('create something', agents, {
      requiredTags: ['github'],
    });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(r.agent_name).toBe('github-agent');
    });
  });

  it('should return empty array when no agents match', () => {
    const results = findBestAgents('quantum teleportation', agents, {
      minConfidence: 0.9,
    });
    expect(results).toEqual([]);
  });

  it('should return empty array for empty description', () => {
    const results = findBestAgents('', agents);
    expect(results).toEqual([]);
  });

  it('should return empty array for all-stopword description', () => {
    const results = findBestAgents('the a an is', agents);
    expect(results).toEqual([]);
  });

  it('should respect top_k parameter', () => {
    const manyAgents = Array.from({ length: 10 }, (_, i) =>
      createTestAgent({
        agent_id: uuidv4(),
        name: `agent-${i}`,
        capabilities: [
          {
            name: 'read_file',
            description: 'Read file contents',
            tags: ['filesystem', 'read', 'file'],
          },
        ],
      })
    );

    const results = findBestAgents('read a file', manyAgents, { topK: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('should skip inactive agents', () => {
    const inactiveAgent = createTestAgent({
      agent_id: uuidv4(),
      name: 'inactive-fs-agent',
      description: 'Inactive filesystem agent',
      status: 'inactive',
      capabilities: [
        {
          name: 'read_file',
          description: 'Read file contents',
          tags: ['filesystem', 'read', 'file'],
        },
      ],
    });

    const results = findBestAgents('read a file', [inactiveAgent]);
    expect(results).toEqual([]);
  });

  it('should match filesystem agent for file read tasks', () => {
    const results = findBestAgents('read a file from the filesystem', agents, { topK: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].agent_name).toBe('filesystem-agent');
  });

  it('should match github agent for PR tasks', () => {
    const results = findBestAgents('list pull requests on github', agents, { topK: 1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].agent_name).toBe('github-agent');
  });
});
