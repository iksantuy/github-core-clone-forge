// GraphQL v4: a small parser and executor over the same store REST reads. The documents are the ones
// `gh` and github-mcp-server send, so the root fields, the connections (nodes, pageInfo, cursors),
// the mutations and the __type introspection probes are what this implements.

import { VIEWER, findRepo, globalId, newIssueId, newPullId, parseGlobalId, repos } from './store.ts';
import { pullConflict, mergePull } from './rest.ts';

// ---------------------------------------------------------------- lexer and parser

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ t: 'spread' });
      i += 3;
      continue;
    }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === '!' || c === '$' || c === '@' || c === '=' || c === '|' || c === '&') {
      tokens.push({ t: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source[i + 1] === '"' && source[i + 2] === '"') {
        const end = source.indexOf('"""', i + 3);
        const value = end < 0 ? '' : source.slice(i + 3, end);
        tokens.push({ t: 'str', v: value });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escape = source[j + 1];
          out += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match !== null) {
        tokens.push({ t: 'num', v: Number(match[0]) });
        i += match[0].length;
        continue;
      }
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (name !== null) {
      tokens.push({ t: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

export function parseDocument(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isName = (value) => {
    const token = peek();
    return token !== undefined && token.t === 'name' && (value === undefined || token.v === value);
  };
  const expect = (type) => {
    const token = next();
    if (token === undefined || token.t !== type) throw new Error(`graphql: expected ${type}`);
    return token;
  };

  function parseValue() {
    const token = peek();
    if (token === undefined) throw new Error('graphql: unexpected end of document');
    if (token.t === '$') {
      next();
      return { kind: 'var', name: expect('name').v };
    }
    if (token.t === 'num') {
      next();
      return { kind: 'const', value: token.v };
    }
    if (token.t === 'str') {
      next();
      return { kind: 'const', value: token.v };
    }
    if (token.t === 'name') {
      next();
      if (token.v === 'true') return { kind: 'const', value: true };
      if (token.v === 'false') return { kind: 'const', value: false };
      if (token.v === 'null') return { kind: 'const', value: null };
      return { kind: 'const', value: token.v };
    }
    if (token.t === '[') {
      next();
      const items = [];
      while (peek() !== undefined && peek().t !== ']') items.push(parseValue());
      expect(']');
      return { kind: 'list', items };
    }
    if (token.t === '{') {
      next();
      const fields = {};
      while (peek() !== undefined && peek().t !== '}') {
        const name = expect('name').v;
        expect(':');
        fields[name] = parseValue();
      }
      expect('}');
      return { kind: 'object', fields };
    }
    throw new Error('graphql: bad value');
  }

  function parseArguments() {
    const args = {};
    if (peek() === undefined || peek().t !== '(') return args;
    next();
    while (peek() !== undefined && peek().t !== ')') {
      const name = expect('name').v;
      expect(':');
      args[name] = parseValue();
    }
    expect(')');
    return args;
  }

  function skipDirectives() {
    while (peek() !== undefined && peek().t === '@') {
      next();
      expect('name');
      parseArguments();
    }
  }

  function parseSelectionSet() {
    expect('{');
    const selections = [];
    while (peek() !== undefined && peek().t !== '}') {
      if (peek().t === 'spread') {
        next();
        if (isName('on')) {
          next();
          const on = expect('name').v;
          selections.push({ kind: 'inline', on, selection: parseSelectionSet() });
        } else if (peek() !== undefined && peek().t === 'name') {
          const fragment = next().v;
          selections.push({ kind: 'fragment', name: fragment });
        } else {
          selections.push({ kind: 'inline', on: null, selection: parseSelectionSet() });
        }
        continue;
      }
      let alias = null;
      let name = expect('name').v;
      if (peek() !== undefined && peek().t === ':') {
        next();
        alias = name;
        name = expect('name').v;
      }
      const args = parseArguments();
      skipDirectives();
      const selection = peek() !== undefined && peek().t === '{' ? parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    expect('}');
    return selections;
  }

  const operations = [];
  const fragments = new Map();
  while (pos < tokens.length) {
    if (isName('fragment')) {
      next();
      const name = expect('name').v;
      if (isName('on')) {
        next();
        expect('name');
      }
      fragments.set(name, parseSelectionSet());
      continue;
    }
    let type = 'query';
    let name = null;
    if (isName('query') || isName('mutation') || isName('subscription')) {
      type = next().v;
      if (peek() !== undefined && peek().t === 'name') name = next().v;
      const variables = {};
      if (peek() !== undefined && peek().t === '(') {
        next();
        while (peek() !== undefined && peek().t !== ')') {
          expect('$');
          const variable = expect('name').v;
          expect(':');
          // Type reference: name, brackets and a bang.
          while (peek() !== undefined && (peek().t === 'name' || peek().t === '[' || peek().t === ']' || peek().t === '!')) next();
          if (peek() !== undefined && peek().t === '=') {
            next();
            variables[variable] = parseValue();
          }
        }
        expect(')');
      }
      skipDirectives();
      operations.push({ type, name, variables, selection: parseSelectionSet() });
      continue;
    }
    if (peek() !== undefined && peek().t === '{') {
      operations.push({ type: 'query', name: null, variables: {}, selection: parseSelectionSet() });
      continue;
    }
    next();
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- values

function evalValue(node, variables) {
  if (node === undefined) return undefined;
  if (node.kind === 'var') return variables[node.name];
  if (node.kind === 'const') return node.value;
  if (node.kind === 'list') return node.items.map((item) => evalValue(item, variables));
  if (node.kind === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
    return out;
  }
  return undefined;
}

function evalArgs(args, variables) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) out[key] = evalValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- the schema

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'stateReason', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'mergeStateStatus', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'files', 'commits', 'additions', 'deletions', 'changedFiles', 'author', 'url', 'repository'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'stargazerCount', 'forkCount', 'visibility', 'isFork', 'isArchived', 'labels', 'ref', 'refs', 'object', 'milestones', 'releases', 'languages', 'primaryLanguage', 'hasWikiEnabled', 'hasProjectsEnabled', 'diskUsage', 'isEmpty'];
const SEARCH_ENUM = ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'];
const TYPES = {
  Issue: { fields: ISSUE_FIELDS },
  PullRequest: { fields: PULL_FIELDS },
  Repository: { fields: REPO_FIELDS },
  SearchType: { enumValues: SEARCH_ENUM },
  User: { fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'isViewer', 'databaseId'] },
  Label: { fields: ['id', 'name', 'color', 'description'] },
  IssueComment: { fields: ['id', 'body', 'author', 'createdAt', 'url'] },
  Ref: { fields: ['id', 'name', 'target', 'prefix', 'repository'] },
  Commit: { fields: ['oid', 'id', 'message', 'messageHeadline', 'committedDate', 'author', 'tree'] },
  PageInfo: { fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
};

function introspection(name) {
  const type = TYPES[name];
  if (type === undefined) return null;
  return {
    __type: '__Type',
    name,
    kind: type.enumValues !== undefined ? 'ENUM' : 'OBJECT',
    fields: (type.fields ?? []).map((field) => ({ __type: '__Field', name: field })),
    enumValues: (type.enumValues ?? []).map((value) => ({ __type: '__EnumValue', name: value })),
  };
}

function repoById(id) {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

function issueNode(repo, issue) {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo, pull) {
  return { __type: 'PullRequest', repo, pull };
}

function connection(nodes, hasNext, cursor) {
  return { __type: 'Connection', nodes, pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: false, endCursor: cursor ?? null, startCursor: null } };
}

function cursorOf(value) {
  return Buffer.from(`cursor:${value}`, 'utf8').toString('base64');
}

function cursorValue(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const at = text.indexOf(':');
    const value = Number(text.slice(at + 1));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

const RESOLVERS = {
  User: {
    id: (node) => globalId('User', node.id ?? 1000),
    login: (node) => node.login,
    name: (node) => node.login,
    email: (node) => `${node.login}@example.invalid`,
    databaseId: (node) => node.id ?? 1000,
    isViewer: (node) => node.login === VIEWER,
    url: (node) => `https://github.com/${node.login}`,
    avatarUrl: () => 'https://avatars.githubusercontent.com/u/1?v=4',
  },
  Repository: {
    id: (node) => globalId('Repository', node.repo.id),
    databaseId: (node) => node.repo.id,
    name: (node) => node.repo.name,
    nameWithOwner: (node) => node.repo.fullName(),
    owner: (node) => ({ __type: 'User', login: node.repo.owner, id: 1000 }),
    description: (node) => node.repo.description,
    isPrivate: (node) => node.repo.private,
    visibility: (node) => (node.repo.private ? 'PRIVATE' : 'PUBLIC'),
    isFork: () => false,
    isArchived: () => false,
    isEmpty: (node) => node.repo.refs.size === 0,
    defaultBranchRef: (node) => {
      const tip = node.repo.tip(`refs/heads/${node.repo.defaultBranch}`);
      return tip === null ? null : { __type: 'Ref', name: node.repo.defaultBranch, target: { __type: 'Commit', oid: tip } };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasWikiEnabled: () => false,
    hasProjectsEnabled: () => false,
    createdAt: (node) => node.repo.createdAt,
    updatedAt: (node) => node.repo.updatedAt,
    pushedAt: (node) => node.repo.pushedAt,
    url: (node) => `https://github.com/${node.repo.fullName()}`,
    stargazerCount: () => 0,
    forkCount: () => 0,
    diskUsage: () => 0,
    labels: (node) => [...node.repo.labels.values()].map((label) => ({ __type: 'Label', label })),
    issue: (node, args) => {
      const issue = node.repo.issues.find((entry) => entry.number === args.number);
      return issue === undefined ? null : issueNode(node.repo, issue);
    },
    issues: (node, args) => {
      let list = [...node.repo.issues];
      const states = Array.isArray(args.states) ? args.states : null;
      if (states !== null && states.length > 0) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
      const order = args.orderBy ?? {};
      if (order.field === 'CREATED_AT' || order.field === undefined) list.sort((a, b) => b.number - a.number);
      if (order.direction === 'ASC') list.reverse();
      const after = cursorValue(args.after);
      if (after !== null) list = list.filter((issue) => issue.number < after);
      const first = Number.isInteger(args.first) ? args.first : 100;
      const page = list.slice(0, first);
      const hasNext = list.length > page.length;
      return connection(page.map((issue) => issueNode(node.repo, issue)), hasNext, page.length > 0 ? cursorOf(page[page.length - 1].number) : null);
    },
    pullRequests: (node, args) => {
      let list = [...node.repo.pulls];
      const states = Array.isArray(args.states) ? args.states : null;
      if (states !== null && states.length > 0) list = list.filter((pull) => states.includes(pull.merged === true ? 'MERGED' : pull.state.toUpperCase()));
      list.sort((a, b) => b.number - a.number);
      const first = Number.isInteger(args.first) ? args.first : 100;
      const page = list.slice(0, first);
      return connection(page.map((pull) => pullNode(node.repo, pull)), list.length > page.length, page.length > 0 ? cursorOf(page[page.length - 1].number) : null);
    },
    pullRequest: (node, args) => {
      const pull = node.repo.pulls.find((entry) => entry.number === args.number);
      return pull === undefined ? null : pullNode(node.repo, pull);
    },
  },
  Issue: {
    id: (node) => globalId('Issue', node.issue.id),
    number: (node) => node.issue.number,
    title: (node) => node.issue.title,
    body: (node) => node.issue.body ?? '',
    state: (node) => (node.issue.state === 'closed' ? 'CLOSED' : 'OPEN'),
    stateReason: () => 'COMPLETED',
    createdAt: (node) => node.issue.createdAt,
    updatedAt: (node) => node.issue.updatedAt,
    closedAt: (node) => node.issue.closedAt ?? null,
    url: (node) => `https://github.com/${node.repo.fullName()}/issues/${node.issue.number}`,
    author: (node) => ({ __type: 'User', login: node.issue.author ?? VIEWER, id: 1000 }),
    labels: (node) => node.issue.labels.map((name) => ({ __type: 'Label', label: node.repo.labels.get(name) ?? { id: 0, name, color: 'ededed' } })),
    comments: (node) => connection(node.repo.comments.filter((comment) => comment.issueNumber === node.issue.number).map((comment) => ({ __type: 'IssueComment', comment })), false, null),
    repository: (node) => ({ __type: 'Repository', repo: node.repo }),
  },
  PullRequest: {
    id: (node) => globalId('PullRequest', node.pull.id),
    number: (node) => node.pull.number,
    title: (node) => node.pull.title,
    body: (node) => node.pull.body ?? '',
    state: (node) => (node.pull.merged === true ? 'MERGED' : node.pull.state === 'closed' ? 'CLOSED' : 'OPEN'),
    merged: (node) => node.pull.merged === true,
    mergeable: (node) => (pullConflict(node.repo, node.pull) ? 'CONFLICTING' : 'MERGEABLE'),
    mergeStateStatus: () => 'CLEAN',
    headRefName: (node) => node.pull.headRef,
    baseRefName: (node) => node.pull.baseRef,
    headRefOid: (node) => node.repo.tip(`refs/heads/${node.pull.headRef}`) ?? node.pull.headSha,
    baseRefOid: (node) => node.repo.tip(`refs/heads/${node.pull.baseRef}`) ?? node.pull.baseSha,
    createdAt: (node) => node.pull.createdAt,
    updatedAt: (node) => node.pull.updatedAt,
    closedAt: (node) => node.pull.closedAt ?? null,
    mergedAt: (node) => node.pull.mergedAt ?? null,
    additions: () => 0,
    deletions: () => 0,
    changedFiles: () => 0,
    commits: () => connection([], false, null),
    url: (node) => `https://github.com/${node.repo.fullName()}/pull/${node.pull.number}`,
    author: (node) => ({ __type: 'User', login: node.pull.author ?? VIEWER, id: 1000 }),
    repository: (node) => ({ __type: 'Repository', repo: node.repo }),
    files: (node, args) => {
      const base = node.repo.filesOf(node.pull.baseSha);
      const head = node.repo.filesOf(node.repo.tip(`refs/heads/${node.pull.headRef}`) ?? node.pull.headSha);
      const paths = new Set([...base.keys(), ...head.keys()]);
      const files = [];
      for (const path of [...paths].sort()) if (base.get(path) !== head.get(path)) files.push({ __type: 'PullRequestFile', path, status: base.get(path) === undefined ? 'ADDED' : head.get(path) === undefined ? 'DELETED' : 'MODIFIED' });
      const first = Number.isInteger(args.first) ? args.first : 100;
      const page = files.slice(0, first);
      return connection(page, files.length > page.length, null);
    },
  },
  PullRequestFile: {
    path: (node) => node.path,
    status: (node) => node.status,
    additions: () => 1,
    deletions: () => 0,
  },
  Ref: {
    id: (node) => globalId('Ref', node.name.length),
    name: (node) => node.name,
    prefix: () => 'refs/heads/',
    target: (node) => node.target,
  },
  Commit: {
    oid: (node) => node.oid,
    id: (node) => globalId('Commit', node.oid.length),
    message: (node) => node.message ?? '',
    messageHeadline: (node) => (node.message ?? '').split('\n')[0],
    committedDate: () => new Date(0).toISOString(),
  },
  Label: {
    id: (node) => globalId('Label', node.label.id),
    name: (node) => node.label.name,
    color: (node) => node.label.color ?? 'ededed',
    description: () => null,
  },
  IssueComment: {
    id: (node) => globalId('IssueComment', node.comment.id),
    body: (node) => node.comment.body,
    createdAt: (node) => node.comment.createdAt,
    author: (node) => ({ __type: 'User', login: node.comment.author ?? VIEWER, id: 1000 }),
  },
  Connection: {
    nodes: (node) => node.nodes,
    edges: (node) => node.nodes.map((child, index) => ({ __type: 'Edge', node: child, cursor: cursorOf(index) })),
    pageInfo: (node) => node.pageInfo,
    totalCount: (node) => node.nodes.length,
  },
  Edge: {
    node: (node) => node.node,
    cursor: (node) => node.cursor,
  },
  PageInfo: {
    hasNextPage: (node) => node.hasNextPage === true,
    hasPreviousPage: (node) => node.hasPreviousPage === true,
    startCursor: (node) => node.startCursor ?? null,
    endCursor: (node) => node.endCursor ?? null,
  },
  __Type: {
    name: (node) => node.name,
    kind: (node) => node.kind,
    fields: (node) => node.fields ?? [],
    enumValues: (node) => node.enumValues ?? [],
  },
  __Field: {
    name: (node) => node.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (node) => node.name,
    description: () => null,
    isDeprecated: () => false,
  },
  CreateIssuePayload: { issue: (node) => node.issue },
  CloseIssuePayload: { issue: (node) => node.issue },
  CreatePullRequestPayload: { pullRequest: (node) => node.pullRequest },
  MergePullRequestPayload: { pullRequest: (node) => node.pullRequest },
  AddCommentPayload: { commentEdge: (node) => ({ __type: 'Edge', node: node.comment, cursor: null }) },
};

function findIssue(issueGlobalId) {
  const parsed = parseGlobalId(issueGlobalId);
  if (parsed === null || parsed.type !== 'Issue') return null;
  for (const repo of repos.values()) {
    const issue = repo.issues.find((entry) => entry.id === parsed.id);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPull(pullGlobalId) {
  const parsed = parseGlobalId(pullGlobalId);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  for (const repo of repos.values()) {
    const pull = repo.pulls.find((entry) => entry.id === parsed.id);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

const ROOT = {
  viewer: () => ({ __type: 'User', login: VIEWER, id: 1000 }),
  repository: (args) => {
    const repo = findRepo(args.owner, args.name);
    return repo === null ? null : { __type: 'Repository', repo };
  },
  node: (args) => {
    const parsed = parseGlobalId(args.id);
    if (parsed === null) return null;
    if (parsed.type === 'Repository') {
      const repo = repoById(parsed.id);
      return repo === null ? null : { __type: 'Repository', repo };
    }
    if (parsed.type === 'Issue') {
      const found = findIssue(args.id);
      return found === null ? null : issueNode(found.repo, found.issue);
    }
    if (parsed.type === 'PullRequest') {
      const found = findPull(args.id);
      return found === null ? null : pullNode(found.repo, found.pull);
    }
    return null;
  },
  __type: (args) => introspection(args.name),
  createIssue: (args) => {
    const input = args.input ?? {};
    const repo = repoById(Number(parseGlobalId(input.repositoryId)?.id));
    if (repo === null) throw new Error('Could not resolve to a Repository with that id');
    const number = repo.nextIssueNumber();
    const stamp = new Date().toISOString();
    const issue = { id: newIssueId(), number, title: input.title ?? '', body: input.body ?? '', state: 'open', labels: [], createdAt: stamp, updatedAt: stamp, closedAt: null, author: VIEWER };
    repo.issues.push(issue);
    return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
  },
  closeIssue: (args) => {
    const found = findIssue(args.input?.issueId);
    if (found === null) throw new Error('Could not resolve to an Issue with that id');
    found.issue.state = 'closed';
    found.issue.closedAt = new Date().toISOString();
    found.issue.updatedAt = found.issue.closedAt;
    return { __type: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
  },
  createPullRequest: (args) => {
    const input = args.input ?? {};
    const repo = repoById(Number(parseGlobalId(input.repositoryId)?.id));
    if (repo === null) throw new Error('Could not resolve to a Repository with that id');
    const headRef = input.headRefName;
    const baseRef = input.baseRefName;
    const headSha = repo.tip(`refs/heads/${headRef}`);
    const baseSha = repo.tip(`refs/heads/${baseRef}`);
    if (headSha === null) throw new Error(`No commits between ${baseRef} and ${headRef}`);
    if (baseSha === null) throw new Error(`Could not resolve to a base branch ${baseRef}`);
    const number = repo.nextPullNumber();
    const stamp = new Date().toISOString();
    const pull = { id: newPullId(), number, title: input.title ?? '', body: input.body ?? '', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, createdAt: stamp, updatedAt: stamp, closedAt: null, author: VIEWER };
    repo.pulls.push(pull);
    return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
  },
  mergePullRequest: (args) => {
    const found = findPull(args.input?.pullRequestId);
    if (found === null) throw new Error('Could not resolve to a PullRequest with that id');
    if (pullConflict(found.repo, found.pull)) throw new Error('Pull request is not mergeable');
    const sha = mergePull(found.repo, found.pull);
    if (sha === null) throw new Error('Pull request is not mergeable');
    return { __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
  },
  addComment: (args) => {
    const found = findIssue(args.input?.subjectId);
    if (found === null) throw new Error('Could not resolve to an Issue with that id');
    const comment = { id: 900000 + found.repo.comments.length + 1, issueNumber: found.issue.number, body: args.input?.body ?? '', createdAt: new Date().toISOString(), author: VIEWER };
    found.repo.comments.push(comment);
    found.issue.commentCount = (found.issue.commentCount ?? 0) + 1;
    return { __type: 'AddCommentPayload', comment: { __type: 'IssueComment', comment } };
  },
};

function project(value, selection, context) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, selection, context));
  if (typeof value === 'object') {
    if (selection === null || selection === undefined) return null;
    return executeSelection(value, selection, context);
  }
  return value;
}

function executeSelection(node, selection, context) {
  const out = {};
  const typeName = node.__type;
  for (const field of selection) {
    if (field.kind === 'inline') {
      if (field.on === null || field.on === typeName) Object.assign(out, executeSelection(node, field.selection, context));
      continue;
    }
    if (field.kind === 'fragment') {
      const fragment = context.fragments.get(field.name);
      if (fragment !== undefined) Object.assign(out, executeSelection(node, fragment, context));
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolvers = RESOLVERS[typeName];
    const resolver = resolvers === undefined ? undefined : resolvers[field.name];
    if (resolver === undefined) {
      context.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, locations: [{ line: 1, column: 1 }], path: [key] });
      out[key] = null;
      continue;
    }
    try {
      const value = resolver(node, evalArgs(field.args, context.variables));
      out[key] = project(value, field.selection, context);
    } catch (err) {
      context.errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
      out[key] = null;
    }
  }
  return out;
}

/** Run one GraphQL document: {data, errors?} as GitHub answers it. */
export function executeGraphQL(query, variables, operationName) {
  const context = { variables: variables ?? {}, errors: [], fragments: new Map() };
  let document;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  context.fragments = document.fragments;
  let operation = document.operations.find((entry) => entry.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found in the document' }] };
  const merged = { ...context.variables };
  for (const [name, node] of Object.entries(operation.variables)) if (merged[name] === undefined) merged[name] = evalValue(node, merged);
  context.variables = merged;
  const data = {};
  for (const field of operation.selection) {
    const key = field.alias ?? field.name;
    if (field.kind !== 'field') continue;
    const resolver = ROOT[field.name];
    if (resolver === undefined) {
      context.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'`, path: [key] });
      data[key] = null;
      continue;
    }
    try {
      const value = resolver(evalArgs(field.args, context.variables));
      data[key] = project(value, field.selection, context);
    } catch (err) {
      context.errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
      data[key] = null;
    }
  }
  const result = { data };
  if (context.errors.length > 0) result.errors = context.errors;
  return result;
}

/** POST /api/graphql: one document, or a JSON array of documents answered in order. */
export function handleGraphQL(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, json: { message: 'Problems parsing JSON' } };
  }
  const one = (entry) => {
    if (typeof entry !== 'object' || entry === null || typeof entry.query !== 'string') return { errors: [{ message: 'query is required' }] };
    return executeGraphQL(entry.query, entry.variables ?? {}, entry.operationName ?? null);
  };
  if (Array.isArray(parsed)) return { status: 200, json: parsed.map(one) };
  return { status: 200, json: one(parsed) };
}
