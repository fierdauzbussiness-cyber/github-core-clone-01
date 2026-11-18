// mcp.ts — Model Context Protocol server over JSON-RPC 2.0 (POST /mcp).
// Modern era 2026-07-28 preferred, legacy initialize supported. Six tools
// that mirror the forge's REST surface. Node stdlib only.
import { VIEWER_LOGIN, hasMergeConflict, squashMerge } from './store.ts';
import type { Repo, Store } from './store.ts';

export const SERVER_NAME = 'github-core-clone-01-forge';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Frozen at module load so tools/list returns byte-identical arrays.
export const TOOLS_JSON = JSON.stringify(TOOLS);

export interface RepoJson {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: { login: string; id: number; type: string };
  private: boolean;
  description: string;
  default_branch: string;
  html_url: string;
  url: string;
  created_at: string;
  updated_at: string;
}

export function repoJson(repo: Repo): RepoJson {
  return {
    id: repo.id,
    node_id: `R:${repo.owner}/${repo.name}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `https://api.github.com/repos/${repo.fullName}`,
    created_at: new Date(1700000000000 + repo.seq * 1000).toISOString(),
    updated_at: new Date(1700000000000 + repo.seq * 1000).toISOString(),
  };
}

export function issueJson(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdSeq: number }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN, id: 1000 },
    created_at: new Date(1700000000000 + issue.createdSeq * 1000).toISOString(),
    updated_at: new Date(1700000000000 + issue.createdSeq * 1000).toISOString(),
    url: `https://api.github.com/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pr: { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headBranch: string; baseBranch: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headBranch, sha: repo.branchTip(pr.headBranch) ?? null, label: `${repo.owner}:${pr.headBranch}` },
    base: { ref: pr.baseBranch, sha: repo.branchTip(pr.baseBranch) ?? null, label: `${repo.owner}:${pr.baseBranch}` },
    user: { login: VIEWER_LOGIN, id: 1000 },
    created_at: new Date(1700000000000 + pr.createdSeq * 1000).toISOString(),
    updated_at: new Date(1700000000000 + pr.createdSeq * 1000).toISOString(),
    url: `https://api.github.com/repos/${repo.fullName}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
  };
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
  isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function missingArgs(tool: McpTool, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
}

export function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw { code: -32601, message: `unknown tool: ${name}` };
  const missing = missingArgs(tool, args);
  if (missing.length) {
    throw { code: -32602, message: `missing required arguments: ${missing.join(', ')}` };
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const repo = store.createRepo(VIEWER_LOGIN, repoName, String(args.description ?? ''), Boolean(args.private ?? false));
      if (!repo) return errorResult(`Repository already exists: ${VIEWER_LOGIN}/${repoName}`);
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult(`Repository not found: ${args.owner}/${args.repo}`);
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const n = ++repo.issueSeq;
      const issue = {
        id: store.nextGlobalId(), number: n, title: String(args.title),
        body: String(args.body ?? ''), state: 'open' as const, labels: [] as string[],
        seq: store.nextSeq(), createdSeq: store.nextSeq(),
      };
      repo.issues.set(n, issue);
      return textResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const state = String(args.state ?? 'open').toLowerCase();
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return textResult(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.branchTip(head) || !repo.branchTip(base)) return errorResult(`Branch not found: ${head} or ${base}`);
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headBranch === head && p.baseBranch === base) {
          return errorResult('A pull request already exists for this head and base');
        }
      }
      const n = ++repo.issueSeq;
      const pr = {
        id: store.nextGlobalId(), number: n, title: String(args.title),
        body: String(args.body ?? ''), state: 'open' as const, merged: false,
        mergedAt: null as string | null, mergeCommitSha: null as string | null,
        headBranch: head, baseBranch: base, seq: store.nextSeq(), createdSeq: store.nextSeq(),
      };
      repo.pulls.set(n, pr);
      return textResult(pullJson(repo, pr));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const pr = repo.pulls.get(Number(args.pull_number));
      if (!pr) return errorResult(`Pull request not found: ${args.pull_number}`);
      if (pr.state !== 'open' || pr.merged) return errorResult('Pull request is not open');
      const baseTip = repo.branchTip(pr.baseBranch);
      const headTip = repo.branchTip(pr.headBranch);
      if (!baseTip || !headTip) return errorResult('Branch not found');
      if (hasMergeConflict(repo, baseTip, headTip)) return errorResult('Merge conflict');
      const sha = squashMerge(repo, pr);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = new Date().toISOString();
      pr.mergeCommitSha = sha;
      return textResult({ merged: true, sha, number: pr.number });
    }
    default:
      throw { code: -32601, message: `unknown tool: ${name}` };
  }
}

// Handle one JSON-RPC request object. Returns { status, body } where body is
// null for a 202 notification acknowledgement.
export function handleMcpRequest(
  store: Store,
  req: unknown,
  protocolVersionHeader?: string,
): { status: number; body: unknown } {
  const fail = (id: unknown, code: number, message: string, data?: unknown) => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return fail(null, -32600, 'invalid request');
  }
  const r = req as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const hasId = r.id !== undefined && r.id !== null;
  const id = r.id ?? null;
  if (typeof r.method !== 'string') return fail(id, -32600, 'invalid request: missing method');
  // Notification (no id): only notifications/initialized is expected.
  if (!hasId) {
    if (r.method === 'notifications/initialized') return { status: 202, body: null };
    return { status: 202, body: null };
  }
  switch (r.method) {
    case 'server/discover': {
      if (protocolVersionHeader && !SUPPORTED_VERSIONS.includes(protocolVersionHeader)) {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id,
            error: { code: -32022, message: 'unsupported protocol version', data: { supported: SUPPORTED_VERSIONS } },
          },
        };
      }
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: SUPPORTED_VERSIONS,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {} },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
          },
        },
      };
    }
    case 'initialize': {
      const params = (r.params ?? {}) as { protocolVersion?: string };
      const requested = String(params.protocolVersion ?? '');
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        },
      };
    }
    case 'ping': {
      return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
    }
    case 'tools/list': {
      return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
    }
    case 'tools/call': {
      const params = (r.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (typeof params.name !== 'string') return fail(id, -32602, 'missing tool name');
      try {
        const result = callTool(store, params.name, params.arguments ?? {});
        return { status: 200, body: { jsonrpc: '2.0', id, result } };
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err) {
          const e = err as { code: number; message: string };
          return fail(id, e.code, e.message);
        }
        return fail(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }
    default:
      return fail(id, -32601, `method not found: ${r.method}`);
  }
}
