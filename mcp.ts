// The Model Context Protocol endpoint: JSON-RPC 2.0 over the streamable-HTTP transport, revision
// 2026-07-28 (server/discover) with the initialize handshake kept for older clients. The tools act on
// the same store REST serves, so an object created here reads back there unchanged.

import { VIEWER, createRepo, findRepo, listRepos, newIssueId, newPullId } from './store.ts';
import { issueJson, mergePull, pullConflict, pullJson, repoJson } from './rest.ts';

const REVISION = '2026-07-28';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

const TOOLS = [
  {
    name: 'create_repo',
    title: 'Create a repository',
    description: 'Create a repository on this forge, owned by the token holder.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    title: 'Get a repository',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    title: 'Create an issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create a pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge a pull request',
    description: 'Merge a pull request by number (squash), leaving the base branch advanced.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pulls',
    title: 'List pull requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function ok(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireRepo(args) {
  const repo = findRepo(args.owner, args.repo);
  if (repo === null) throw new Error(`repository ${args.owner}/${args.repo} not found`);
  return repo;
}

const HANDLERS = {
  create_repo(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (name === '') throw new Error('name is required');
    const repo = createRepo(VIEWER, name, { private: args.private === true, description: typeof args.description === 'string' ? args.description : '' });
    if (repo === null) {
      const existing = findRepo(VIEWER, name);
      if (existing !== null) return repoJson(existing);
      throw new Error(`could not create ${name}`);
    }
    return repoJson(repo);
  },
  get_repo(args) {
    return repoJson(requireRepo(args));
  },
  create_issue(args) {
    const repo = requireRepo(args);
    const title = typeof args.title === 'string' ? args.title : '';
    if (title === '') throw new Error('title is required');
    const number = repo.nextIssueNumber();
    const stamp = new Date().toISOString();
    const issue = { id: newIssueId(), number, title, body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], createdAt: stamp, updatedAt: stamp, closedAt: null, author: VIEWER };
    repo.addIssue(issue);
    return issueJson(repo, issue);
  },
  list_issues(args) {
    const repo = requireRepo(args);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return { total_count: list.length, issues: list.map((issue) => issueJson(repo, issue)) };
  },
  create_pull_request(args) {
    const repo = requireRepo(args);
    const headRef = typeof args.head === 'string' ? args.head : '';
    const baseRef = typeof args.base === 'string' ? args.base : '';
    const headSha = repo.tip(`refs/heads/${headRef}`);
    const baseSha = repo.tip(`refs/heads/${baseRef}`);
    if (headSha === null) throw new Error(`head branch ${headRef} does not exist`);
    if (baseSha === null) throw new Error(`base branch ${baseRef} does not exist`);
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    if (existing !== undefined) return pullJson(repo, existing);
    const number = repo.nextPullNumber();
    const stamp = new Date().toISOString();
    const pull = { id: newPullId(), number, title: typeof args.title === 'string' ? args.title : '', body: typeof args.body === 'string' ? args.body : '', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, createdAt: stamp, updatedAt: stamp, closedAt: null, author: VIEWER };
    repo.pulls.push(pull);
    return pullJson(repo, pull);
  },
  merge_pull_request(args) {
    const repo = requireRepo(args);
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) throw new Error(`pull request #${args.pull_number} not found`);
    if (pull.merged === true) return { ...pullJson(repo, pull), merged: true, message: 'Pull request already merged' };
    if (pullConflict(repo, pull)) throw new Error('pull request is not mergeable');
    const sha = mergePull(repo, pull);
    if (sha === null) throw new Error('pull request is not mergeable');
    return { ...pullJson(repo, pull), merged: true, sha, message: 'Pull request successfully merged' };
  },
  list_pulls(args) {
    const repo = requireRepo(args);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    return { total_count: list.length, pulls: list.map((pull) => pullJson(repo, pull)) };
  },
};

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** Answer one POST /mcp. `authorized` is false when the request carried no (or a wrong) bearer token. */
export function handleMcp(body, authorized) {
  if (!authorized) return { status: 401, json: rpcError(null, -32001, 'Unauthorized: a bearer token is required') };
  let message;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(message)) {
    const answers = message.map((entry) => answer(entry));
    return { status: 200, json: answers.filter((entry) => entry !== null) };
  }
  const answerOne = answer(message);
  if (answerOne === null) return { status: 202 };
  return { status: 200, json: answerOne };
}

function answer(message) {
  if (typeof message !== 'object' || message === null) return rpcError(null, -32600, 'Invalid Request');
  const id = message.id;
  const method = message.method;
  const params = typeof message.params === 'object' && message.params !== null ? message.params : {};
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const notification = id === undefined || id === null;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' && SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : REVISION;
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {};
    const handler = HANDLERS[name];
    if (typeof name !== 'string' || handler === undefined) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
    const schema = TOOLS.find((tool) => tool.name === name);
    const missing = (schema?.inputSchema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    try {
      return rpcResult(id, ok(handler(args)));
    } catch (err) {
      return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }
  if (notification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export { TOOLS as MCP_TOOLS };
