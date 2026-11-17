// forge/app.ts — HTTP server wiring: one Store shared by every surface.
//
//   GET  /healthz            200 {"ok":true} (no auth; the env's boot check)
//   git  /<owner>/<repo>.git/info/refs, git-upload-pack, git-receive-pack
//        via the git smart-HTTP handler (binary protocol, not JSON)
//   POST /mcp                MCP endpoint (JSON-RPC 2.0, Streamable HTTP)
//   /api/v3*                 GitHub REST v3 (incl. GET /api/v3 itself)
//   POST /api/graphql        GraphQL v4
//   anything else            404 JSON {"message":"Not Found"}
//
// Every JSON reply is application/json (never HTML) with a non-empty
// X-GitHub-Request-Id: app.ts presets one per request and each handler
// overrides it with its own. The JSON API surfaces (/api/v3, /api/graphql,
// /mcp) require `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` — missing or
// wrong answers 401 JSON; /healthz and the git transport are exempt (the
// git client carries credentials only when configured). Malformed JSON
// bodies are answered 400 by the handler that owns the route.
//
// One Store, one GitRepo factory, no per-request I/O: the read/write
// benchmarks run 2000 GETs / 200 POSTs through this dispatch, so routing
// is a few string compares and one Map lookup per handler at most.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GitRepo } from './git.ts';
import { createGitHandler } from './gitproto.ts';
import { createGraphqlHandler } from './graphql.ts';
import { createMcpHandler } from './mcp.ts';
import { createRestHandler } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The JSON API surfaces whose requests need the bearer token (see below). */
function isApiSurface(path: string): boolean {
  return path === '/mcp' || path === '/mcp/' || path === '/api/graphql' || path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store({});
  const restHandler = createRestHandler(store, { createGitRepo: () => new GitRepo() });
  const graphqlHandler = createGraphqlHandler(store, {});
  const mcpHandler = createMcpHandler(store, {});
  const gitHandler = createGitHandler((owner, repo) => {
    const record = store.getRepo(owner, repo);
    // Every repo in the store was created with `new GitRepo()`; the cast is sound.
    return record === undefined ? null : (record.git as unknown as GitRepo);
  });

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // A request id on every reply: handlers override it with their own, and
    // the git transport (which answers in pkt-lines, not JSON) keeps this one.
    requestCounter += 1;
    res.setHeader('x-github-request-id', `app-${requestCounter}`);

    const path = pathOf(req);
    const method = (req.method ?? 'GET').toUpperCase();

    // The env's boot check calls this twice: 200 {"ok":true}, no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP first: its paths (/owner/repo.git/...) never collide
    // with the JSON surfaces, and the transport is binary, not JSON.
    if (gitHandler(req, res)) return;

    // The JSON API surfaces need the bearer token (the handlers enforce the
    // same rule themselves; the gate keeps unauthenticated traffic out here).
    if (isApiSurface(path) && !store.isAuthenticated(req.headers.authorization)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    const viewerLogin = store.viewerLogin ?? undefined;
    if (mcpHandler(req, res, viewerLogin === undefined ? undefined : { viewer: viewerLogin })) return;
    if (restHandler(req, res, { baseUrl, viewerLogin })) return;
    if (graphqlHandler(req, res, { baseUrl, viewerLogin })) return;

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
