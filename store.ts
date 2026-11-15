// The forge's store: an in-memory git object database plus the issues, labels, comments and
// pull requests every surface (REST, GraphQL, MCP) reads and writes. One process, one store.
//
// Git objects are content addressed: sha1("<type> <len>\0" + bytes). Trees sort their entries by
// name bytes, a directory compared as if its name ended in "/" (git's own order), and commits are
// plain text headers plus a message. Nothing here shells out: no git binary, no dependency.

import { createHash } from 'node:crypto';

/** The login the trial's bearer token owns. */
export const VIEWER = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** Another login, with no rights on the viewer's repositories. */
export const STRANGER = 'olgabauer';
export const ZERO = '0'.repeat(40);

export function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

/** A tree's entries: [{mode, name, oid}], in git's sort order. */
export function parseTree(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

function treeSortKey(entry) {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Serialise tree entries: git's byte order, mode + space + name + NUL + 20 raw bytes. */
export function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function parseTag(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

export function buildCommit(fields) {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const tz = fields.timezone ?? '+0000';
  const author = `${fields.author ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${timestamp} ${tz}`;
  const committer = `${fields.committer ?? fields.author ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${timestamp} ${tz}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  let message = fields.message ?? '';
  if (!message.endsWith('\n')) message += '\n';
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

let nextRepoId = 1000;
let nextIssueId = 100000;
let nextCommentId = 900000;
let nextPullId = 200000;
let nextLabelId = 300000;
let nextRefId = 400000;

/** One repository: its object database, refs, and every record the APIs serve. */
export class Repo {
  constructor(owner, name, options = {}) {
    this.owner = owner;
    this.name = name;
    this.id = nextRepoId++;
    this.private = options.private === true;
    this.description = typeof options.description === 'string' ? options.description : '';
    this.defaultBranch = 'main';
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.pushedAt = this.createdAt;
    this.refs = new Map();
    this.objects = new Map();
    this.issues = [];
    this.issueSeq = 0;
    this.comments = [];
    this.pulls = [];
    this.pullSeq = 0;
    this.labels = new Map();
    this.treeCache = new Map();
    this.commitCache = new Map();
  }

  key() {
    return `${this.owner}/${this.name}`;
  }

  fullName() {
    return `${this.owner}/${this.name}`;
  }

  putObject(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data, z: null });
    return oid;
  }

  getObject(oid) {
    return this.objects.get(oid);
  }

  hasObject(oid) {
    return this.objects.has(oid);
  }

  /** Every [path, blobOid, mode] under a tree, recursively, in one flat list. */
  flattenTree(treeOid) {
    const cached = this.treeCache.get(treeOid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    const out = [];
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        for (const [path, oid, mode] of this.flattenTree(entry.oid)) out.push([`${entry.name}/${path}`, oid, mode]);
      } else {
        out.push([entry.name, entry.oid, entry.mode]);
      }
    }
    this.treeCache.set(treeOid, out);
    return out;
  }

  /** The commit a ref names, or null when the ref is unborn. */
  tip(ref) {
    const oid = this.refs.get(ref);
    return oid === undefined ? null : oid;
  }

  defaultTip() {
    return this.tip(`refs/heads/${this.defaultBranch}`);
  }

  /** A commit's tree oid. */
  treeOf(commitOid) {
    const object = this.objects.get(commitOid);
    if (object === undefined) return null;
    if (object.type === 'tree') return commitOid;
    if (object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Every path -> blob oid in a commit (or the empty map for an unborn tree). */
  filesOf(commitOid) {
    if (commitOid === null) return new Map();
    const cached = this.commitCache.get(commitOid);
    if (cached !== undefined) return cached;
    const tree = this.treeOf(commitOid);
    const map = new Map();
    if (tree !== null) for (const [path, oid] of this.flattenTree(tree)) map.set(path, oid);
    this.commitCache.set(commitOid, map);
    return map;
  }

  /** Build (and store) the nested trees for a path -> blob oid map; returns the root tree oid. */
  treeFromFiles(files) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
        node = node.dirs.get(name);
      }
      node.files.set(segments[segments.length - 1], oid);
    }
    const build = (node) => {
      const entries = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Commit a path -> blob oid map on top of `parents`; returns the commit oid. */
  commitFiles(files, message, parents, author) {
    const tree = this.treeFromFiles(files);
    const data = buildCommit({ tree, parents: parents ?? [], message, author });
    const oid = this.putObject('commit', data);
    this.commitCache.delete(oid);
    return oid;
  }

  blobText(oid) {
    const object = this.objects.get(oid);
    return object === undefined ? null : object.data;
  }

  setRef(ref, oid) {
    this.refs.set(ref, oid);
    this.pushedAt = new Date().toISOString();
  }

  deleteRef(ref) {
    this.refs.delete(ref);
  }

  branches() {
    const out = [];
    for (const [ref, oid] of this.refs) if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice(11), sha: oid });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  tags() {
    const out = [];
    for (const [ref, oid] of this.refs) if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice(10), sha: oid });
    return out;
  }

  /** Commits reachable from `oid` in parent order (newest first), optionally bounded by depth. */
  history(oid, limit = 1000, depth = Infinity) {
    const out = [];
    const seen = new Set();
    let frontier = [oid];
    let generation = 0;
    while (frontier.length > 0 && out.length < limit && generation < depth) {
      const next = [];
      for (const current of frontier) {
        if (seen.has(current)) continue;
        seen.add(current);
        const object = this.objects.get(current);
        if (object === undefined || object.type !== 'commit') continue;
        out.push(current);
        for (const parent of parseCommit(object.data).parents) if (!seen.has(parent)) next.push(parent);
      }
      frontier = next;
      generation += 1;
    }
    return out;
  }

  /** Whether `ancestor` is reachable from `descendant` (a fast-forward test). */
  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    const seen = new Set();
    const stack = [descendant];
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (current === ancestor) return true;
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  nextIssueNumber() {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextPullNumber() {
    this.pullSeq += 1;
    return this.pullSeq;
  }
}

/** Every repository, keyed "owner/name". */
export const repos = new Map();

export function findRepo(owner, name) {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  const repo = repos.get(`${owner}/${name}`);
  return repo === undefined ? null : repo;
}

export function createRepo(owner, name, options = {}) {
  if (findRepo(owner, name) !== null) return null;
  const repo = new Repo(owner, name, options);
  repos.set(repo.key(), repo);
  return repo;
}

export function deleteRepo(owner, name) {
  return repos.delete(`${owner}/${name}`);
}

export function listRepos(owner) {
  const out = [];
  for (const repo of repos.values()) if (repo.owner === owner) out.push(repo);
  out.sort((a, b) => a.id - b.id);
  return out;
}

export function newIssueId() {
  return nextIssueId++;
}

export function newCommentId() {
  return nextCommentId++;
}

export function newPullId() {
  return nextPullId++;
}

export function newLabelId() {
  return nextLabelId++;
}

export function newRefId() {
  return nextRefId++;
}

/** An opaque global id, the shape GitHub's node ids take: base64 of "<Type>:<n>". */
export function globalId(type, id) {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function parseGlobalId(value) {
  if (typeof value !== 'string' || value === '') return null;
  let text;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const at = text.lastIndexOf(':');
  if (at <= 0) return null;
  const type = text.slice(0, at);
  const id = Number(text.slice(at + 1));
  if (!Number.isInteger(id)) return null;
  return { type, id };
}
