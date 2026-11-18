// app.ts — HTTP server: routes git smart-HTTP, REST v3, GraphQL and MCP
// onto one in-memory Store, with the auth and wire rules the harness checks
// (application/json everywhere on the API, X-GitHub-Request-Id on every
// reply, 401 without a token, 400 on malformed JSON). Node stdlib only.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import {
  uploadPackAdvertisementV0, uploadPackAdvertisementV2, receivePackAdvertisementV0,
  handleLsRefs, handleFetchV2, handleFetchV0, handleReceivePack,
} from './git.ts';
import { handleRest, ApiError } from './rest.ts';
import { handleGraphQLRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

export interface App {
  store: Store;
  server: ReturnType<typeof createServer>;
}

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(text)),
    'X-GitHub-Request-Id': `req-${(++requestCounter).toString(16)}`,
    ...extraHeaders,
  };
  if (status === 204) {
    res.writeHead(204, { 'X-GitHub-Request-Id': headers['X-GitHub-Request-Id'] });
    res.end();
    return;
  }
  res.writeHead(status, headers);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': `req-${(++requestCounter).toString(16)}`,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/);
  return m ? m[1].trim() : null;
}

export function createApp(): App {
  const store = new Store();
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(store, req, res);
    } catch (err) {
      // Never crash the server on a bad request: answer 500 JSON and stay up.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // Response already gone; nothing more to do.
      }
    }
  });
  return { store, server };
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const segments = pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));

  // GET /healthz — no auth.
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const repo = store.getRepo(owner, repoName);
    const gitPath = segments.slice(2).join('/');
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && gitPath === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        const body = v2 ? uploadPackAdvertisementV2(repo) : uploadPackAdvertisementV0(repo);
        sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, receivePackAdvertisementV0(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'missing service parameter' });
      return;
    }
    if (method === 'POST' && gitPath === 'git-upload-pack') {
      const body = await readBody(req);
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      try {
        let out: Buffer;
        if (v2) {
          // ls-refs bodies start with a pkt-line 'command=ls-refs'.
          const text = body.toString('utf8');
          if (text.includes('command=ls-refs')) out = handleLsRefs(repo, body);
          else out = handleFetchV2(repo, body);
        } else {
          out = handleFetchV0(repo, body);
        }
        sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
      } catch (err) {
        console.error('git-upload-pack error:', err instanceof Error ? err.stack : err);
        sendJson(res, 400, { message: 'malformed request' });
      }
      return;
    }
    if (method === 'POST' && gitPath === 'git-receive-pack') {
      const body = await readBody(req);
      try {
        const out = handleReceivePack(repo, body);
        sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
      } catch (err) {
        console.error('git-receive-pack error:', err instanceof Error ? err.stack : err);
        sendJson(res, 400, { message: 'malformed request' });
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3: /api/v3/...
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const restSegments = segments.slice(2);
    const isRoot = restSegments.length === 0 && method === 'GET';
    const isMeta = restSegments.length === 1 && restSegments[0] === 'meta' && method === 'GET';
    if (!isRoot && !isMeta) {
      const token = bearerToken(req);
      if (!token) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
    }
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON in request body' });
          return;
        }
      }
    }
    try {
      const result = handleRest({
        store,
        method,
        segments: restSegments,
        query: url.searchParams,
        body,
        host: req.headers.host ?? 'localhost',
      });
      const extra: Record<string, string> = { ...(result.headers ?? {}) };
      if (method === 'GET' && restSegments.length === 0) extra['X-OAuth-Scopes'] = 'repo, read:org';
      sendJson(res, result.status, result.body, extra);
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { message: err.message });
      } else {
        throw err;
      }
    }
    return;
  }

  // GraphQL: POST /api/graphql
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Invalid JSON in request body' }] });
      return;
    }
    const result = handleGraphQLRequest(store, parsed);
    sendJson(res, 200, result);
    return;
  }

  // MCP: POST /mcp
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const { status, body } = handleMcpRequest(store, parsed, req.headers['mcp-protocol-version'] as string | undefined);
    if (status === 202) {
      res.writeHead(202, { 'X-GitHub-Request-Id': `req-${(++requestCounter).toString(16)}` });
      res.end();
      return;
    }
    sendJson(res, status, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
