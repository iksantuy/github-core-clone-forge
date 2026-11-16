// The forge's HTTP surface: one server, five faces — the boot probe, git smart HTTP under
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and MCP at /mcp. Every REST
// reply is JSON with a request id; an unknown route is a JSON 404, never HTML.
//
// The request path is the hot path: the benchmark's read and write workloads are thousands of
// sequential keep-alive requests, so this file avoids per-request allocation where it can. The URL
// is parsed by hand (only a `?` needs a real query parse), a bodyless GET/DELETE never builds a
// promise, the bearer check short-circuits on the exact scheme, and a reply is written as one
// pre-sized Buffer through a flat header list.

import { createServer } from 'node:http';
import { findRepo } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const EMPTY = Buffer.alloc(0);
/** The query object for a request with no `?`; rest.ts only reads it, so one instance is enough. */
const NO_QUERY = Object.freeze({});
let requestCounter = 0;

function requestId() {
  requestCounter += 1;
  return `mf-${process.pid.toString(16)}-${requestCounter.toString(16)}-${Date.now().toString(16)}`;
}

function sendJson(res, status, body, extra) {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  const headers = [
    'content-type', JSON_TYPE,
    'content-length', buf.length,
    'x-github-request-id', requestId(),
  ];
  if (extra !== undefined) for (const key of Object.keys(extra)) headers.push(key, extra[key]);
  res.writeHead(status, headers);
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Whether the request carries a body worth reading (a proxy may send `content-length: 0`). */
function hasBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && length !== '0') return true;
  return req.headers['transfer-encoding'] !== undefined;
}

function authorized(req) {
  if (TOKEN === '') return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  // undici and curl both send the exact `Bearer <token>` shape: take it without a regex.
  if (header.startsWith('Bearer ') && header.slice(7) === TOKEN && TOKEN !== ' ') return true;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  return match[1].trim() === TOKEN;
}

/** The path and (lazily) the query of a request target, without a URL object. */
function splitTarget(raw) {
  const target = raw === '' ? '/' : raw;
  const mark = target.indexOf('?');
  const path = mark < 0 ? target : target.slice(0, mark);
  return { path, search: mark < 0 ? '' : target.slice(mark + 1) };
}

/** `Object.fromEntries(new URLSearchParams(x))` without the URLSearchParams when the text is plain. */
function parseQuery(search) {
  if (search === '') return NO_QUERY;
  if (search.indexOf('%') >= 0 || search.indexOf('+') >= 0) return Object.fromEntries(new URLSearchParams(search).entries());
  const query = {};
  let start = 0;
  while (start <= search.length) {
    const amp = search.indexOf('&', start);
    const end = amp < 0 ? search.length : amp;
    const pair = search.slice(start, end);
    if (pair !== '') {
      const eq = pair.indexOf('=');
      if (eq < 0) query[pair] = '';
      else query[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (amp < 0) break;
    start = amp + 1;
  }
  return query;
}

/** The decoded path segments (the `/api/v3` router wants them); built only for REST requests. */
function pathSegments(path) {
  const parts = path.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '') continue;
    if (part.indexOf('%') < 0) {
      out.push(part);
      continue;
    }
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

export function createApp() {
  return createServer((req, res) => {
    const method = req.method ?? 'GET';
    let target;
    try {
      target = splitTarget(req.url ?? '/');
    } catch {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const path = target.path;

    if (path === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method not allowed' });
        return;
      }
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      readBody(req).then((body) => {
        const answer = handleGraphQL(body);
        sendJson(res, answer.status, answer.json, answer.headers);
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    if (path === '/mcp') {
      if (method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method not allowed' });
        return;
      }
      const allowed = authorized(req);
      readBody(req).then((body) => {
        const answer = handleMcp(body, allowed);
        if (answer.json === undefined) {
          res.writeHead(answer.status);
          res.end();
          return;
        }
        sendJson(res, answer.status, answer.json);
      }).catch(() => sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const rest = pathSegments(path).slice(2);
      const answerOf = (body) => {
        const origin = `http://${req.headers.host ?? 'entry'}`;
        try {
          return handleRest(method, rest, parseQuery(target.search), body, origin);
        } catch (err) {
          return { status: 500, json: { message: err instanceof Error ? err.message : 'internal error' } };
        }
      };
      const emit = (answer) => {
        if (answer.json === undefined) {
          if (answer.body !== undefined) {
            const headers = ['content-type', JSON_TYPE, 'content-length', answer.body.length, 'x-github-request-id', requestId()];
            if (answer.headers !== undefined) for (const key of Object.keys(answer.headers)) headers.push(key, answer.headers[key]);
            res.writeHead(answer.status, headers);
            res.end(answer.body);
            return;
          }
          res.writeHead(answer.status, ['x-github-request-id', requestId()]);
          res.end();
          return;
        }
        sendJson(res, answer.status, answer.json, answer.headers);
      };
      // A GET or HEAD has no body to read, so answer it without a promise (the read workload is
      // thousands of them); anything else reads its body first. A DELETE may carry one (contents).
      if (method === 'GET' || method === 'HEAD' || !hasBody(req)) {
        emit(answerOf(EMPTY));
        return;
      }
      readBody(req).then((body) => emit(answerOf(body))).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    const git = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (git !== null) {
      const owner = decodeURIComponent(git[1]);
      const name = decodeURIComponent(git[2]);
      const sub = git[3] ?? '';
      const repo = findRepo(owner, name);
      if (repo === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET' && sub === '/info/refs') {
        const query = parseQuery(target.search);
        const service = typeof query.service === 'string' ? query.service : '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 403, { message: 'Smart HTTP only' });
          return;
        }
        handleGit(res, repo, service, sub, query, req.headers, EMPTY);
        return;
      }
      if (method === 'POST' && (sub === '/git-upload-pack' || sub === '/git-receive-pack')) {
        const query = parseQuery(target.search);
        readBody(req).then((body) => {
          try {
            handleGit(res, repo, sub.slice(1), sub, query, req.headers, body);
          } catch (err) {
            sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
          }
        }).catch(() => sendJson(res, 400, { message: 'bad request' }));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}
