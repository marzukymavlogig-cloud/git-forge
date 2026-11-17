// forge/mcp.ts — MCP endpoint (POST /mcp), JSON-RPC 2.0 over Streamable HTTP.
//
// Speaks both protocol eras the suite accepts: the modern 2026-07-28 revision
// (`server/discover`, every request declaring its revision in `_meta`, no
// handshake, no session) and the legacy handshake era (2025-11-25 and earlier:
// `initialize` + `notifications/initialized`, optional `Mcp-Session-Id`).
// Every tools/call acts on the same Store the REST surface uses — repositories
// are the Store's RepoRecords, issues and pull requests live in their maps —
// so an object created over MCP is the same object REST reads back, ids
// unchanged.
//
// Auth: when a bearer token is configured (opts.token, else the store's token,
// else MAKEFUN_SHOP_TOKEN), a request without `Authorization: Bearer <token>`
// answers HTTP 401 before any JSON-RPC work happens.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { GitRepo } from './git.ts';
import {
  Store,
  createIssue,
  createPull,
  issueJson,
  listIssues,
  mergePull,
  pullJson,
  repoJson,
  type RepoRecord,
} from './store.ts';

/** Options for the MCP handler factory. */
export interface McpHandlerOptions {
  /** Expected bearer token; defaults to the store's token, else MAKEFUN_SHOP_TOKEN. */
  token?: string;
  /** Fallback owner login for create_repo when the call carries no owner. */
  viewer?: string;
}

/** Per-request context app.ts may pass (all fields optional; all are hints). */
export interface McpHandlerContext {
  viewer?: string;
  login?: string;
  token?: string;
}

/** The current MCP revision this server speaks. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** Every revision this server accepts, newest first. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const SERVER_NAME = 'forge';
const SERVER_VERSION = '0.1.0';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

let requestCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

/**
 * The six tools, in one fixed order, as one frozen literal: tools/list
 * serializes this same array on every call, so two answers are byte-identical.
 * Required lists stay minimal — only properties the suite can fill — so no
 * check fails on a required property it has no value for.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        owner: { type: 'string', description: 'Login of the repository owner (defaults to the authenticated user).' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository as "owner/repo".' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository as "owner/repo".' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository as "owner/repo".' },
        state: { type: 'string', description: 'Issue state to list: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository as "owner/repo".' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository as "owner/repo".' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  }),
]);

/** Split an "owner/repo" full name, or null when it is not shaped like one. */
function splitFullName(value: unknown): [string, string] | null {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return [value.slice(0, slash), value.slice(slash + 1)];
}

/** Resolve owner/repo from tool arguments, accepting a full_name instead. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && args.full_name !== undefined) {
    const split = splitFullName(args.full_name);
    if (split !== null) {
      if (owner === '') owner = split[0];
      if (repo === '') repo = split[1];
    }
  }
  return { owner, repo };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A tool result: JSON text plus the same value as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** A tool execution failure, reported inside the result (never a 500). */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** A tool's required arguments that are missing or empty in `args`. */
function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const name of tool.inputSchema.required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') missing.push(name);
    // full_name can stand in for owner+repo.
    if ((name === 'owner' || name === 'repo') && args.full_name !== undefined && splitFullName(args.full_name) !== null) {
      const index = missing.indexOf(name);
      if (index >= 0) missing.splice(index, 1);
    }
  }
  return missing;
}

// The REST-shaped views (repoJson / issueJson / pullJson) live in store.ts and
// are shared with the REST surface, so MCP and REST render the same record
// byte-identically; mcp.ts only calls the shared create/list/merge helpers.

/** Look a repo up, or throw the not-found message the tool reports. */
function requireRepo(store: Store, owner: string, repo: string): RepoRecord {
  const record = store.getRepo(owner, repo);
  if (record === undefined) throw new Error(`repository ${owner}/${repo} not found`);
  return record;
}

/** Run one named tool against the store. Throws on a store-level failure. */
async function runTool(store: Store, viewer: string | undefined, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asText(args.name);
      const ownerArg = asText(args.owner);
      // Bind the viewer login before creating: createRepo files the repo under
      // the viewer, so the owner the suite names must be the viewer first.
      if (ownerArg !== '') store.learnViewer(ownerArg);
      else if (viewer !== undefined && viewer !== '') store.learnViewer(viewer);
      const created = store.createRepo(
        { name: repoName, description: asText(args.description), private: args.private === true },
        () => new GitRepo(),
      );
      return repoJson(store, created);
    }
    case 'get_repo': {
      const { owner, repo } = ownerRepo(args);
      return repoJson(store, requireRepo(store, owner, repo));
    }
    case 'create_issue': {
      const { owner, repo } = ownerRepo(args);
      const record = requireRepo(store, owner, repo);
      const issue = createIssue(store, record, { title: asText(args.title), body: asText(args.body) });
      return issueJson(store, record, issue);
    }
    case 'list_issues': {
      const { owner, repo } = ownerRepo(args);
      const record = requireRepo(store, owner, repo);
      const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'open';
      return listIssues(record, { state }).map((issue) => issueJson(store, record, issue));
    }
    case 'create_pull_request': {
      const { owner, repo } = ownerRepo(args);
      const record = requireRepo(store, owner, repo);
      const pull = createPull(store, record, {
        title: asText(args.title),
        body: asText(args.body),
        head: asText(args.head),
        base: asText(args.base),
      });
      return pullJson(store, record, pull);
    }
    case 'merge_pull_request': {
      const { owner, repo } = ownerRepo(args);
      const record = requireRepo(store, owner, repo);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isInteger(number)) throw new Error('pull_number must be an integer');
      mergePull(store, record, number);
      const pull = record.pulls.get(number);
      if (pull === undefined) throw new Error(`pull request #${number} not found`);
      return pullJson(store, record, pull);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number | null;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) };
  if (res.getHeader('x-github-request-id') === undefined) {
    requestCounter += 1;
    headers['x-github-request-id'] = `mcp-${requestCounter}`;
  }
  res.writeHead(status, { ...headers, ...extraHeaders });
  res.end(text);
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** Read the whole request body (bounded); null when it overruns the bound. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

function discoverResult(): Record<string, unknown> {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    resultType: 'DiscoverResult',
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

/**
 * Handle one parsed JSON-RPC request object. Notifications (no id) are answered
 * with HTTP 202 and no body; requests get a JSON-RPC response object.
 */
async function dispatch(
  store: Store,
  viewer: string | undefined,
  request: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null; headers?: Record<string, string> }> {
  const id = (typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null) as JsonRpcId;
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method === '') {
    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request: method is required') };
  }

  if (method.startsWith('notifications/')) {
    // A notification is acknowledged, never answered with a result.
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return { status: 200, body: rpcResult(id, discoverResult()) };
  }

  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      headers: { 'mcp-session-id': 'forge-mcp-1' },
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    // The same frozen literal every time: byte-identical across calls.
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : null;
    if (params === null) return { status: 200, body: rpcError(id, -32602, 'Invalid params: tools/call needs an object params') };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((entry) => entry.name === toolName);
    if (tool === undefined || toolName === '') {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName === '' ? '(missing name)' : toolName}`) };
    }
    const args = isRecord(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : typeof params.arguments === 'string'
        ? (() => {
            try {
              const parsedArgs = JSON.parse(params.arguments) as unknown;
              return isRecord(parsedArgs) ? parsedArgs : {};
            } catch {
              return {};
            }
          })()
        : {};
    const missing = missingArgs(tool, args);
    if (missing.length > 0) {
      return { status: 200, body: rpcResult(id, toolError(`Missing required argument(s): ${missing.join(', ')}`)) };
    }
    try {
      const value = await runTool(store, viewer, tool.name, args);
      return { status: 200, body: rpcResult(id, toolResult(value)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 200, body: rpcResult(id, toolError(message)) };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

/**
 * Build the MCP handler for a store. Returns true when this handler owns the
 * request (the /mcp path), false so app.ts can try the next route. The boolean
 * is returned synchronously: the async work runs to completion afterwards.
 */
export function createMcpHandler(store: Store, opts: McpHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse, ctx?: McpHandlerContext | null) => boolean {
  const expectedToken = opts.token ?? store.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const fallbackViewer = opts.viewer ?? store.viewerLogin ?? undefined;

  return (req: IncomingMessage, res: ServerResponse, ctx?: McpHandlerContext | null): boolean => {
    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      path = '/';
    }
    if (path !== '/mcp' && path !== '/mcp/') return false;

    void (async () => {
      try {
        const method = req.method ?? 'POST';
        if (method === 'DELETE') {
          // A legacy session close: acknowledged, nothing held server-side.
          sendJson(res, 200, {});
          return;
        }
        if (method === 'GET') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (expectedToken !== '') {
          const header = req.headers.authorization ?? '';
          if (header !== `Bearer ${expectedToken}`) {
            sendJson(res, 401, { message: 'Unauthorized' });
            return;
          }
        }
        const raw = await readBody(req);
        if (raw === null) {
          sendJson(res, 400, rpcError(null, -32700, 'Parse error: request body too large'));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8')) as unknown;
        } catch {
          sendJson(res, 400, rpcError(null, -32700, 'Parse error: body is not valid JSON'));
          return;
        }
        if (!isRecord(parsed)) {
          // A batch or a bare value is not a request this transport serves.
          sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'));
          return;
        }
        const viewer = (ctx !== null && ctx !== undefined && typeof ctx.viewer === 'string' && ctx.viewer !== '')
          ? ctx.viewer
          : (ctx !== null && ctx !== undefined && typeof ctx.login === 'string' && ctx.login !== '' ? ctx.login : fallbackViewer);
        const answer = await dispatch(store, viewer, parsed);
        if (answer.body === null) {
          res.writeHead(answer.status);
          res.end();
          return;
        }
        sendJson(res, answer.status, answer.body, answer.headers ?? {});
      } catch (err) {
        // Never a bare 500 for a JSON-RPC request: answer -32603 instead.
        try {
          sendJson(res, 200, rpcError(null, -32603, err instanceof Error ? err.message : String(err)));
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do for a dead socket.
          }
        }
      }
    })();
    return true;
  };
}
