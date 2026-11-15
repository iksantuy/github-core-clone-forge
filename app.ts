// The forge's HTTP surface: one server, five faces — the boot probe, git smart HTTP under
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and MCP at /mcp. Every REST
// reply is JSON with a request id; an unknown route is a JSON 404, never HTML.

import { createServer } from 'node:http';
import { findRepo } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function requestId() {
  requestCounter += 1;
  return `mf-${process.pid.toString(16)}-${requestCounter.toString(16)}-${Date.now().toString(16)}`;
}

function sendJson(res, status, body, extra) {
  const text = `${JSON.stringify(body)}\n`;
  const headers = {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...(extra ?? {}),
  };
  res.writeHead(status, headers);
  res.end(text);
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

function authorized(req) {
  if (TOKEN === '') return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  return match[1].trim() === TOKEN;
}

export function createApp() {
  return createServer((req, res) => {
    const method = req.method ?? 'GET';
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    const segments = path.split('/').filter((part) => part !== '').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

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
      readBody(req).then((body) => {
        const answer = handleMcp(body, authorized(req));
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
      const rest = segments.slice(2);
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      readBody(req).then((body) => {
        const origin = `http://${req.headers.host ?? 'entry'}`;
        let answer;
        try {
          answer = handleRest(method, rest, query, body, origin);
        } catch (err) {
          answer = { status: 500, json: { message: err instanceof Error ? err.message : 'internal error' } };
        }
        if (answer.json === undefined) {
          res.writeHead(answer.status, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        sendJson(res, answer.status, answer.json, answer.headers);
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
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
        const service = typeof query.service === 'string' ? query.service : '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 403, { message: 'Smart HTTP only' });
          return;
        }
        handleGit(res, repo, service, sub, query, req.headers, Buffer.alloc(0));
        return;
      }
      if (method === 'POST' && (sub === '/git-upload-pack' || sub === '/git-receive-pack')) {
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
