// src/matcher.ts - Keyword-based capability matching engine

import { type Agent, type AgentCapability, type MatchResult } from './types.js';

// === Stopwords ===

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'this', 'that', 'these',
  'those', 'it', 'its', 'and', 'but', 'or', 'nor', 'not', 'so', 'if',
  'all', 'each',
]);

// === Weights ===

const WEIGHT_NAME = 3;
const WEIGHT_TAG = 2;
const WEIGHT_DESC = 1;
const REQUIRED_TAGS_BOOST = 1.5;

// === Helpers ===

/**
 * Tokenize a string into lowercase keywords, removing stopwords and splitting
 * on any non-alphanumeric character (spaces, punctuation, underscores, dashes).
 */
export function tokenize(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  return text
    .toLowerCase()
    .split(/[\s\p{P}_\-]+/u)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Count how many tokens from `queryTokens` appear in `targetTokens`.
 */
function countOverlap(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  const targetSet = new Set(targetTokens);
  return queryTokens.filter((t) => targetSet.has(t)).length;
}

/**
 * Score a single capability against tokenized query terms.
 * Returns raw score and a human-readable reason string.
 */
export function scoreCapability(
  tokens: string[],
  capability: AgentCapability,
): { score: number; reason: string } {
  if (tokens.length === 0) {
    return { score: 0, reason: 'No meaningful query terms after tokenization' };
  }

  const nameTokens = tokenize(capability.name);
  const descTokens = tokenize(capability.description);
  const tagTokens = capability.tags.map((t) => t.toLowerCase().trim());

  const nameHits = countOverlap(tokens, nameTokens);
  const descHits = countOverlap(tokens, descTokens);
  // Tags are matched as whole tokens against query tokens
  const tagHits = tokens.filter((t) => tagTokens.includes(t)).length;

  const score =
    nameHits * WEIGHT_NAME +
    tagHits * WEIGHT_TAG +
    descHits * WEIGHT_DESC;

  // Build reason string
  const parts: string[] = [];
  if (nameHits > 0) {
    const matched = tokens.filter((t) => nameTokens.includes(t));
    parts.push(`name matched [${matched.join(', ')}] (${nameHits}x${WEIGHT_NAME})`);
  }
  if (tagHits > 0) {
    const matched = tokens.filter((t) => tagTokens.includes(t));
    parts.push(`tags matched [${matched.join(', ')}] (${tagHits}x${WEIGHT_TAG})`);
  }
  if (descHits > 0) {
    const matched = tokens.filter((t) => descTokens.includes(t));
    parts.push(`description matched [${matched.join(', ')}] (${descHits}x${WEIGHT_DESC})`);
  }

  const reason = parts.length > 0
    ? parts.join('; ')
    : 'No keyword overlap found';

  return { score, reason };
}

/**
 * Compute the theoretical maximum score for a capability given a set of query tokens.
 * Used for normalization.
 */
function maxPossibleScore(tokens: string[], capability: AgentCapability): number {
  if (tokens.length === 0) return 1; // avoid division by zero

  // Best case: every query token matches name, tag, and description
  // In practice we cap at query token count per field
  const nameTokenCount = tokenize(capability.name).length;
  const descTokenCount = tokenize(capability.description).length;
  const tagCount = capability.tags.length;

  const maxNameHits = Math.min(tokens.length, nameTokenCount);
  const maxTagHits = Math.min(tokens.length, tagCount);
  const maxDescHits = Math.min(tokens.length, descTokenCount);

  const raw =
    maxNameHits * WEIGHT_NAME +
    maxTagHits * WEIGHT_TAG +
    maxDescHits * WEIGHT_DESC;

  // Fallback: if capability has no tokens at all, use query length * max weight
  return raw > 0 ? raw : tokens.length * WEIGHT_NAME;
}

// === Public API ===

/**
 * Find the best matching agents for a given task description.
 *
 * @param taskDescription  Natural-language description of the task.
 * @param agents           Pool of registered agents to score against.
 * @param options          Optional tuning parameters.
 * @returns                Sorted list of MatchResult (best first), filtered by minConfidence.
 */
export function findBestAgents(
  taskDescription: string,
  agents: Agent[],
  options?: {
    requiredTags?: string[];
    topK?: number;
    minConfidence?: number;
  },
): MatchResult[] {
  const topK = options?.topK ?? 3;
  const minConfidence = options?.minConfidence ?? 0.1;
  const requiredTags = options?.requiredTags?.map((t) => t.toLowerCase().trim()) ?? [];

  const tokens = tokenize(taskDescription);

  // Edge case: empty or all-stopword description
  if (tokens.length === 0) return [];

  const candidates: MatchResult[] = [];

  for (const agent of agents) {
    if (agent.status !== 'active') continue;
    if (!agent.capabilities || agent.capabilities.length === 0) continue;

    for (const capability of agent.capabilities) {
      // --- Required tags check ---
      if (requiredTags.length > 0) {
        const capTagsLower = capability.tags.map((t) => t.toLowerCase().trim());
        const allPresent = requiredTags.every((rt) => capTagsLower.includes(rt));
        if (!allPresent) {
          // Penalize: skip this capability entirely
          continue;
        }
      }

      const { score, reason } = scoreCapability(tokens, capability);

      if (score === 0) continue;

      // Normalize score to 0-1
      const maxScore = maxPossibleScore(tokens, capability);
      let confidence = score / maxScore;

      // Apply required-tags boost (all required tags matched, since we already filtered non-matching)
      if (requiredTags.length > 0) {
        confidence = Math.min(1, confidence * REQUIRED_TAGS_BOOST);
      }

      // Clamp to [0, 1]
      confidence = Math.min(1, Math.max(0, confidence));

      if (confidence < minConfidence) continue;

      const matchReason = requiredTags.length > 0
        ? `${reason}; required tags [${requiredTags.join(', ')}] all matched (+${((REQUIRED_TAGS_BOOST - 1) * 100).toFixed(0)}% boost)`
        : reason;

      candidates.push({
        agent_id: agent.agent_id,
        agent_name: agent.name,
        matched_capability: capability.name,
        confidence,
        match_reason: matchReason,
      });
    }
  }

  // Sort descending by confidence, then take top K
  candidates.sort((a, b) => b.confidence - a.confidence);

  return candidates.slice(0, topK);
}
