// The REST v3 surface: repositories, branches, refs, commits, contents, labels, issues, comments and
// pull requests (with files and merge). Every reply is JSON; every error carries a string message.
// The API root, the pagination Link header and the pull-request shapes follow GitHub's own.

import {
  VIEWER,
  VIEWER_NAME,
  VIEWER_EMAIL,
  createRepo,
  deleteRepo,
  findRepo,
  globalId,
  listRepos,
  newCommentId,
  newIssueId,
  newLabelId,
  newPullId,
  newRefId,
  parseCommit,
  parseTree,
} from './store.ts';

const VERSION = '1.0.0';

function nowIso() {
  return new Date().toISOString();
}

function fail(status, message) {
  return { status, json: { message } };
}

export function repoJson(repo) {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName(),
    private: repo.private,
    owner: { login: repo.owner, id: 1000, type: 'User', site_admin: false },
    html_url: `https://github.com/${repo.fullName()}`,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: openIssues,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo, label) {
  return { id: label.id, node_id: globalId('Label', label.id), name: label.name, color: label.color ?? 'ededed', default: false, description: null, url: `${repo.fullName()}/labels/${label.name}` };
}

export function issueJson(repo, issue) {
  const full = repo.fullName();
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map((name) => labelJson(repo, repo.labels.get(name) ?? { id: newLabelId(), name })),
    user: { login: issue.author ?? VIEWER, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.commentCount ?? 0,
    locked: false,
    author_association: 'OWNER',
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt ?? null,
    closed_by: null,
    html_url: `https://github.com/${full}/issues/${issue.number}`,
    url: `/api/v3/repos/${full}/issues/${issue.number}`,
  };
}

/**
 * Everything `issueJson` renders, in one comparable string. A cached body is reused only while this
 * is unchanged, so a title, body, state, label set, comment count or timestamp edit always re-renders
 * — and a label created after the first render changes `labelGen`, so it cannot go stale either.
 */
function issueSignature(repo, issue) {
  const labels = issue.labels.length === 0 ? '' : issue.labels.join('\u0001');
  return `${repo.owner}/${repo.name}\u0000${repo.labelGen}\u0000${issue.id}\u0000${issue.number}\u0000${issue.state}\u0000${issue.title}\u0000${issue.body ?? ''}\u0000${labels}\u0000${issue.author ?? ''}\u0000${issue.commentCount ?? 0}\u0000${issue.createdAt}\u0000${issue.updatedAt}\u0000${issue.closedAt ?? ''}`;
}

function commentJson(repo, comment) {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: { login: comment.author ?? VIEWER, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.fullName()}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
  };
}

function headShaOf(repo, pull) {
  const tip = repo.tip(`refs/heads/${pull.headRef}`);
  return tip === null ? pull.headSha : tip;
}

function baseShaOf(repo, pull) {
  const tip = repo.tip(`refs/heads/${pull.baseRef}`);
  return tip === null ? pull.baseSha : tip;
}

export function pullJson(repo, pull) {
  const headSha = headShaOf(repo, pull);
  const baseSha = baseShaOf(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    draft: false,
    merged: pull.merged === true,
    mergeable: pull.merged === true ? null : true,
    mergeable_state: pull.merged === true ? 'unknown' : 'clean',
    merged_at: pull.mergedAt ?? null,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: 1000, type: 'User' } },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: 1000, type: 'User' } },
    user: { login: pull.author ?? VIEWER, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt ?? null,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    html_url: `https://github.com/${repo.fullName()}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName()}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- trees and contents

function resolveCommit(repo, ref) {
  if (ref === undefined || ref === null || ref === '') return repo.defaultTip();
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (repo.hasObject(ref)) return ref;
  return null;
}

function listDir(repo, commitOid, dirPath) {
  let tree = repo.treeOf(commitOid);
  if (tree === null) return null;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const object = repo.getObject(tree);
      if (object === undefined) return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return null;
      tree = entry.oid;
    }
  }
  const object = repo.getObject(tree);
  if (object === undefined) return null;
  return parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    mode: entry.mode === '40000' ? '040000' : entry.mode,
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.getObject(entry.oid)?.data.length ?? 0),
  }));
}

function contentJson(repo, path, oid) {
  const object = repo.getObject(oid);
  const data = object === undefined ? Buffer.alloc(0) : object.data;
  const name = path.split('/').pop();
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: `/api/v3/repos/${repo.fullName()}/contents/${path}`,
    html_url: `https://github.com/${repo.fullName()}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.fullName()}/git/blobs/${oid}`,
  };
}

function diffFiles(repo, baseSha, headSha) {
  const base = repo.filesOf(baseSha);
  const head = repo.filesOf(headSha);
  const out = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === after) continue;
    const beforeText = before === undefined ? '' : repo.getObject(before)?.data.toString('utf8') ?? '';
    const afterText = after === undefined ? '' : repo.getObject(after)?.data.toString('utf8') ?? '';
    const beforeLines = beforeText === '' ? 0 : beforeText.split('\n').length;
    const afterLines = afterText === '' ? 0 : afterText.split('\n').length;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const additions = status === 'added' ? afterLines : status === 'removed' ? 0 : Math.max(1, afterLines - (beforeLines > 0 ? 1 : 0));
    const deletions = status === 'removed' ? beforeLines : status === 'added' ? 0 : Math.max(0, beforeLines - 1);
    out.push({
      filename: path,
      status,
      additions: Math.max(additions, status === 'modified' ? 1 : 0),
      deletions: Math.max(deletions, 0),
      changes: Math.max(additions, 0) + Math.max(deletions, 0),
      sha: after ?? before,
      blob_url: `https://github.com/${repo.fullName()}/blob/${repo.defaultBranch}/${path}`,
      raw_url: `https://github.com/${repo.fullName()}/raw/${repo.defaultBranch}/${path}`,
    });
  }
  return out;
}

export function pullConflict(repo, pull) {
  const baseTip = repo.tip(`refs/heads/${pull.baseRef}`);
  const headTip = repo.tip(`refs/heads/${pull.headRef}`);
  if (baseTip === null || headTip === null) return false;
  if (baseTip === pull.baseSha) return false;
  const base = repo.filesOf(pull.baseSha);
  const tip = repo.filesOf(baseTip);
  const head = repo.filesOf(headTip);
  for (const [path, oid] of head) {
    if (base.get(path) === oid) continue;
    if (tip.get(path) !== base.get(path)) return true;
  }
  for (const [path, oid] of base) {
    if (head.has(path)) continue;
    if (tip.get(path) !== oid) return true;
  }
  return false;
}

/** Squash the pull's head onto the base branch; returns the new commit sha. */
export function mergePull(repo, pull) {
  const baseTip = repo.tip(`refs/heads/${pull.baseRef}`);
  const headTip = repo.tip(`refs/heads/${pull.headRef}`);
  if (baseTip === null || headTip === null) return null;
  const base = repo.filesOf(pull.baseSha);
  const head = repo.filesOf(headTip);
  const files = new Map(repo.filesOf(baseTip));
  for (const [path, oid] of head) if (base.get(path) !== oid) files.set(path, oid);
  for (const path of base.keys()) if (!head.has(path)) files.delete(path);
  const message = `${pull.title} (#${pull.number})`;
  const sha = repo.commitFiles(files, message, [baseTip]);
  repo.setRef(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = sha;
  return sha;
}

// ---------------------------------------------------------------- the router

function linkHeader(origin, path, query, page, lastPage) {
  const build = (target) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (key !== 'page') params.set(key, String(value));
    params.set('page', String(target));
    return `<${origin}${path}?${params.toString()}>`;
  };
  const parts = [];
  if (page < lastPage) parts.push(`${build(page + 1)}; rel="next"`, `${build(lastPage)}; rel="last"`);
  if (page > 1) parts.push(`${build(1)}; rel="first"`, `${build(page - 1)}; rel="prev"`);
  return parts.join(', ');
}

function paginate(items, query) {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), page, perPage, lastPage: Math.max(1, Math.ceil(items.length / perPage)) };
}

function parseBody(body) {
  if (body === undefined || body === null) return {};
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) return {};
    const text = body.toString('utf8').trim();
    if (text === '') return {};
    return JSON.parse(text);
  }
  return body;
}

/**
 * Handle one /api/v3 request. `segments` are the decoded path parts after the prefix, `query` the
 * parsed query string, `body` the raw request body, `origin` the request's scheme://host.
 */
export function handleRest(method, segments, query, body, origin) {
  const path = segments.join('/');
  const json = (status, value, headers) => ({ status, json: value, headers });
  /** A reply whose body is already the exact bytes to write (see Repo.renderCached). */
  const raw = (status, buf, headers) => ({ status, body: buf, headers: headers ?? {} });
  let input;
  try {
    input = parseBody(body);
  } catch {
    return fail(400, 'Problems parsing JSON');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) input = {};

  if (path === '' && method === 'GET') {
    return json(200, { current_user_url: `${origin}/api/v3/user`, repository_url: `${origin}/api/v3/repos/{owner}/{repo}`, user_url: `${origin}/api/v3/users/{user}`, rate_limit_url: `${origin}/api/v3/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (path === 'meta' && method === 'GET') return json(200, { installed_version: VERSION, verifiable_password_authentication: false });
  if (path === 'rate_limit' && method === 'GET') return json(200, { resources: {}, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
  if (path === 'user' && method === 'GET') {
    return json(200, { login: VIEWER, id: 1000, node_id: globalId('User', 1000), name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User', site_admin: false, public_repos: 0, followers: 0, following: 0 });
  }
  if (path === 'users' && method === 'GET') return json(200, []);
  if (segments[0] === 'users' && segments.length === 2 && method === 'GET') {
    const login = segments[1];
    return json(200, { login, id: login === VIEWER ? 1000 : 1002, node_id: globalId('User', 1002), name: login, type: 'User' });
  }

  if (path === 'user/repos') {
    if (method === 'GET') {
      const all = listRepos(VIEWER);
      const page = paginate(all, query);
      const headers = {};
      if (page.lastPage > 1) headers.link = linkHeader(origin, '/api/v3/user/repos', query, page.page, page.lastPage);
      return json(200, page.slice.map(repoJson), headers);
    }
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '') return fail(422, 'Repository creation failed: name is required');
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return fail(422, 'Repository creation failed: name is invalid');
      const created = createRepo(VIEWER, name, { private: input.private === true, description: typeof input.description === 'string' ? input.description : '' });
      if (created === null) return fail(422, 'Repository creation failed: name already exists on this account');
      if (input.auto_init === true) {
        const blob = created.putObject('blob', Buffer.from(`# ${name}\n`, 'utf8'));
        const commit = created.commitFiles(new Map([['README.md', blob]]), 'Initial commit', []);
        created.setRef(`refs/heads/${created.defaultBranch}`, commit);
      }
      return json(201, repoJson(created));
    }
    return fail(405, 'Method not allowed');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return fail(404, 'Not Found');

  const owner = segments[1];
  const name = segments[2];
  const repo = findRepo(owner, name);
  if (repo === null) return fail(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      if (typeof input.name === 'string' && input.name !== repo.name) {
        const renamed = createRepo(repo.owner, input.name, { private: repo.private, description: repo.description });
        if (renamed === null) return fail(422, 'Repository rename failed: name already exists');
        renamed.objects = repo.objects;
        renamed.refs = repo.refs;
        renamed.issues = repo.issues;
        renamed.issueIndex = repo.issueIndex;
        renamed.issueSeq = repo.issueSeq;
        renamed.comments = repo.comments;
        renamed.pulls = repo.pulls;
        renamed.pullSeq = repo.pullSeq;
        renamed.labels = repo.labels;
        renamed.treeCache = repo.treeCache;
        renamed.commitCache = repo.commitCache;
        deleteRepo(repo.owner, repo.name);
        return json(200, repoJson(renamed));
      }
      repo.updatedAt = nowIso();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return fail(405, 'Method not allowed');
  }

  if (rest[0] === 'branches') {
    if (method !== 'GET') return fail(405, 'Method not allowed');
    if (rest.length === 1) {
      return json(200, repo.branches().map((branch) => ({ name: branch.name, commit: { sha: branch.sha, url: `${origin}/api/v3/repos/${repo.fullName()}/commits/${branch.sha}` }, protected: false })));
    }
    const branch = repo.branches().find((entry) => entry.name === rest.slice(1).join('/'));
    if (branch === undefined) return fail(404, 'Branch not found');
    return json(200, { name: branch.name, commit: { sha: branch.sha }, protected: false });
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        return json(200, [...repo.refs].map(([ref, sha]) => ({ ref, node_id: globalId('Ref', newRefId()), url: `${origin}/api/v3/repos/${repo.fullName()}/git/refs`, object: { type: 'commit', sha, url: `${origin}/api/v3/repos/${repo.fullName()}/git/commits/${sha}` } })));
      }
      if (method === 'POST') {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!/^refs\/heads\/.+/.test(ref)) return fail(422, 'Reference update failed: ref must be refs/heads/<branch>');
        if (!repo.hasObject(sha)) return fail(422, `Reference update failed: object ${sha} does not exist`);
        if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
        repo.setRef(ref, sha);
        return json(201, { ref, node_id: globalId('Ref', newRefId()), url: `${origin}/api/v3/repos/${repo.fullName()}/git/refs`, object: { type: 'commit', sha } });
      }
      return fail(405, 'Method not allowed');
    }
    const ref = rest.slice(2).join('/');
    const oid = repo.refs.get(ref);
    if (oid === undefined) return fail(404, 'Not Found');
    if (method === 'GET') return json(200, { ref, node_id: globalId('Ref', newRefId()), object: { type: 'commit', sha: oid } });
    if (method === 'PATCH') {
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!repo.hasObject(sha)) return fail(422, 'Reference update failed: object does not exist');
      repo.setRef(ref, sha);
      return json(200, { ref, object: { type: 'commit', sha } });
    }
    if (method === 'DELETE') {
      repo.deleteRef(ref);
      return { status: 204 };
    }
    return fail(405, 'Method not allowed');
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET') return fail(405, 'Method not allowed');
    const sha = typeof query.sha === 'string' ? query.sha : undefined;
    const tip = resolveCommit(repo, sha);
    if (tip === null) return fail(404, 'Not Found');
    const history = repo.history(tip, Math.min(1000, Number.parseInt(query.per_page ?? '30', 10) || 30));
    return json(200, history.map((oid) => {
      const commit = parseCommit(repo.getObject(oid).data);
      return {
        sha: oid,
        node_id: globalId('Commit', oid),
        commit: {
          message: commit.message.replace(/\s+$/, ''),
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        author: { login: repo.owner, id: 1000, type: 'User' },
      };
    }));
  }

  if (rest[0] === 'git' && (rest[1] === 'blobs' || rest[1] === 'trees' || rest[1] === 'commits') && method === 'GET') {
    const oid = rest[2];
    const object = repo.getObject(oid);
    if (object === undefined) return fail(404, 'Not Found');
    if (rest[1] === 'blobs') return json(200, { sha: oid, size: object.data.length, content: object.data.toString('base64'), encoding: 'base64' });
    if (rest[1] === 'trees') return json(200, { sha: oid, tree: parseTree(object.data).map((entry) => ({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.oid })) });
    const commit = parseCommit(object.data);
    return json(200, { sha: oid, tree: { sha: commit.tree }, parents: commit.parents.map((parent) => ({ sha: parent })), message: commit.message });
  }

  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveCommit(repo, typeof query.ref === 'string' ? query.ref : undefined);
      if (tip === null) return fail(404, 'Not Found');
      const files = repo.filesOf(tip);
      const oid = files.get(filePath);
      if (oid !== undefined) return json(200, contentJson(repo, filePath, oid));
      const listing = listDir(repo, tip, filePath);
      if (listing !== null && listing.length >= 0) {
        return json(200, listing.map((entry) => ({
          type: entry.type,
          size: entry.size,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          url: `${origin}/api/v3/repos/${repo.fullName()}/contents/${entry.path}`,
        })));
      }
      return fail(404, 'Not Found');
    }
    if (method === 'PUT') {
      const content = typeof input.content === 'string' ? Buffer.from(input.content.replace(/\s+/g, ''), 'base64') : null;
      if (content === null) return fail(422, 'Invalid request: content is required (base64)');
      const message = typeof input.message === 'string' && input.message !== '' ? input.message : `Create ${filePath}`;
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const ref = `refs/heads/${branch}`;
      const tip = repo.refs.get(ref);
      if (tip === undefined && branch !== repo.defaultBranch) return fail(404, `Branch ${branch} not found`);
      const files = new Map(repo.filesOf(tip ?? null));
      const existing = files.get(filePath);
      if (typeof input.sha === 'string' && input.sha !== '') {
        if (existing === undefined) return fail(404, 'Not Found');
        if (existing !== input.sha) return fail(409, `${filePath} does not match ${input.sha}`);
      } else if (existing !== undefined && input.sha === undefined) {
        // GitHub refuses a create over an existing path without a sha; a plain update is friendlier.
        if (content.equals(repo.getObject(existing)?.data ?? Buffer.alloc(0))) {
          const parent = tip ?? null;
          const commit = repo.commitFiles(files, message, parent === null ? [] : [parent]);
          repo.setRef(ref, commit);
          return json(200, { content: contentJson(repo, filePath, existing), commit: { sha: commit, message } });
        }
      }
      const blob = repo.putObject('blob', content);
      files.set(filePath, blob);
      const parent = tip ?? null;
      const commit = repo.commitFiles(files, message, parent === null ? [] : [parent]);
      repo.setRef(ref, commit);
      const status = existing === undefined ? 201 : 200;
      return json(status, {
        content: { ...contentJson(repo, filePath, blob) },
        commit: { sha: commit, node_id: globalId('Commit', commit), message, html_url: `https://github.com/${repo.fullName()}/commit/${commit}` },
      });
    }
    if (method === 'DELETE') {
      const tip = repo.defaultTip();
      if (tip === null) return fail(404, 'Not Found');
      const files = new Map(repo.filesOf(tip));
      const existing = files.get(filePath);
      if (existing === undefined) return fail(404, 'Not Found');
      if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== existing) return fail(409, `${filePath} does not match ${input.sha}`);
      files.delete(filePath);
      const message = typeof input.message === 'string' && input.message !== '' ? input.message : `Delete ${filePath}`;
      const commit = repo.commitFiles(files, message, [tip]);
      repo.setRef(`refs/heads/${repo.defaultBranch}`, commit);
      return json(200, { content: null, commit: { sha: commit, message } });
    }
    return fail(405, 'Method not allowed');
  }

  if (rest[0] === 'labels') {
    if (method === 'GET') return json(200, [...repo.labels.values()].map((label) => labelJson(repo, label)));
    if (method === 'POST') {
      const labelName = typeof input.name === 'string' ? input.name : '';
      if (labelName === '') return fail(422, 'Validation Failed: name is required');
      const label = { id: newLabelId(), name: labelName, color: typeof input.color === 'string' ? input.color : 'ededed' };
      repo.labels.set(labelName, label);
      repo.labelGen += 1;
      return json(201, labelJson(repo, label));
    }
    return fail(405, 'Method not allowed');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = typeof query.state === 'string' ? query.state : 'open';
        let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        const sort = typeof query.sort === 'string' ? query.sort : 'created';
        const direction = typeof query.direction === 'string' ? query.direction : 'desc';
        list = [...list].sort((a, b) => {
          if (sort === 'updated') return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
          if (sort === 'comments') return 0;
          return a.number - b.number;
        });
        if (direction === 'desc') list.reverse();
        const page = paginate(list, query);
        const headers = {};
        if (page.lastPage > 1) headers.link = linkHeader(origin, `/api/v3/repos/${repo.fullName()}/issues`, query, page.page, page.lastPage);
        return json(200, page.slice.map((issue) => issueJson(repo, issue)), headers);
      }
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') return fail(422, 'Validation Failed: title is required');
        const wanted = Array.isArray(input.labels) ? input.labels.filter((label) => typeof label === 'string') : [];
        const unknown = wanted.filter((label) => !repo.labels.has(label));
        if (unknown.length > 0) return fail(422, `Validation Failed: ${unknown.join(', ')} does not exist`);
        const number = repo.nextIssueNumber();
        const stamp = nowIso();
        const issue = {
          id: newIssueId(),
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: wanted,
          createdAt: stamp,
          updatedAt: stamp,
          closedAt: null,
          author: VIEWER,
        };
        repo.addIssue(issue);
        return json(201, issueJson(repo, issue));
      }
      return fail(405, 'Method not allowed');
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = repo.issueByNumber(number);
    if (issue === undefined) return fail(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') {
        const slot = `i${issue.number}`;
        return raw(200, repo.renderCached(slot, issueSignature(repo, issue), () => issueJson(repo, issue)));
      }
      if (method === 'PATCH') {
        if (typeof input.title === 'string' && input.title !== '') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'closed' || input.state === 'open') {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? nowIso() : null;
        }
        if (Array.isArray(input.labels)) {
          const wanted = input.labels.filter((label) => typeof label === 'string');
          const unknown = wanted.filter((label) => !repo.labels.has(label));
          if (unknown.length > 0) return fail(422, `Validation Failed: ${unknown.join(', ')} does not exist`);
          issue.labels = wanted;
        }
        issue.updatedAt = nowIso();
        return json(200, issueJson(repo, issue));
      }
      return fail(405, 'Method not allowed');
    }
    if (rest[2] === 'comments') {
      if (method === 'GET') {
        const comments = repo.comments.filter((comment) => comment.issueNumber === issue.number);
        return json(200, comments.map((comment) => commentJson(repo, comment)));
      }
      if (method === 'POST') {
        const text = typeof input.body === 'string' ? input.body : '';
        if (text === '') return fail(422, 'Validation Failed: body is required');
        const comment = { id: newCommentId(), issueNumber: issue.number, body: text, createdAt: nowIso(), author: VIEWER };
        repo.comments.push(comment);
        issue.commentCount = (issue.commentCount ?? 0) + 1;
        return json(201, commentJson(repo, comment));
      }
      return fail(405, 'Method not allowed');
    }
    return fail(404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = typeof query.state === 'string' ? query.state : 'open';
        const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        const page = paginate(list, query);
        const headers = {};
        if (page.lastPage > 1) headers.link = linkHeader(origin, `/api/v3/repos/${repo.fullName()}/pulls`, query, page.page, page.lastPage);
        return json(200, page.slice.map((pull) => pullJson(repo, pull)), headers);
      }
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        const headRef = typeof input.head === 'string' ? input.head : '';
        const baseRef = typeof input.base === 'string' ? input.base : '';
        if (title === '' || headRef === '' || baseRef === '') return fail(422, 'Validation Failed: title, head and base are required');
        const headSha = repo.tip(`refs/heads/${headRef}`);
        const baseSha = repo.tip(`refs/heads/${baseRef}`);
        if (headSha === null) return fail(422, `Validation Failed: head branch ${headRef} does not exist`);
        if (baseSha === null) return fail(422, `Validation Failed: base branch ${baseRef} does not exist`);
        if (headRef === baseRef) return fail(422, 'Validation Failed: head and base are the same branch');
        const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
        if (existing !== undefined) return fail(422, `A pull request already exists for ${headRef}`);
        const number = repo.nextPullNumber();
        const stamp = nowIso();
        const pull = {
          id: newPullId(),
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef,
          baseRef,
          headSha,
          baseSha,
          createdAt: stamp,
          updatedAt: stamp,
          closedAt: null,
          author: VIEWER,
        };
        repo.pulls.push(pull);
        return json(201, pullJson(repo, pull));
      }
      return fail(405, 'Method not allowed');
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return fail(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return json(200, pullJson(repo, pull));
    if (rest.length === 2 && method === 'PATCH') {
      if (typeof input.title === 'string' && input.title !== '') pull.title = input.title;
      if (typeof input.body === 'string') pull.body = input.body;
      if (input.state === 'closed' || input.state === 'open') {
        pull.state = input.state;
        pull.closedAt = input.state === 'closed' ? nowIso() : null;
      }
      pull.updatedAt = nowIso();
      return json(200, pullJson(repo, pull));
    }
    if (rest[2] === 'files' && method === 'GET') {
      return json(200, diffFiles(repo, pull.baseSha, headShaOf(repo, pull)));
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (pull.merged === true) return fail(405, 'Pull request is not mergeable: it is already merged');
      if (pullConflict(repo, pull)) return fail(405, 'Pull request is not mergeable');
      const sha = mergePull(repo, pull);
      if (sha === null) return fail(405, 'Pull request is not mergeable');
      return json(200, { sha, merged: true, message: 'Pull request successfully merged' });
    }
    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}
