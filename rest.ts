// rest.ts — GitHub REST v3 handlers under /api/v3.
// Exports createRestHandler(store, opts): (req, res, ctx) => boolean.
// The handler is sync-returning: it starts async body handling and returns true
// when the path is ours; app.ts must not send anything else for that request.
// Every reply is application/json (never HTML) with a non-empty
// X-GitHub-Request-Id. Unknown /api/v3 routes are JSON 404s; malformed JSON
// bodies are 400. No token -> 401; a repo under another owner -> 404, never 403.
// TypeScript erasable-only syntax; stdlib only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ApiError,
  addIssueComment,
  apiError,
  commentJson,
  createIssue,
  createLabel,
  createPull,
  deleteContent,
  getContent,
  issueJson,
  labelJson,
  listIssueComments,
  listIssues,
  listPulls,
  mergePull,
  pullFiles,
  pullJson,
  putContent,
  repoJson,
  updateIssue,
  type GitRepoLike,
  type HandlerOpts,
  type RepoRecord,
} from './store.ts';
import { Store } from './store.ts';

export type { HandlerOpts };

export interface RestHandlerOpts extends HandlerOpts {
  /** Factory for the per-repo GitRepo; app.ts passes () => new GitRepo(). */
  createGitRepo?: () => GitRepoLike;
}

export interface RestHandlerCtx {
  baseUrl?: string;
  viewerLogin?: string;
  /** Pre-read raw request body (when app.ts already consumed the stream). */
  body?: string;
  /** Pre-parsed JSON body. */
  parsedBody?: unknown;
}

export type RestHandler = (req: IncomingMessage, res: ServerResponse, ctx?: RestHandlerCtx) => boolean;

const JSON_TYPE = 'application/json; charset=utf-8';

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function parseQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

function pageParams(query: Record<string, string>): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(query.per_page ?? '', 10);
  const pageRaw = Number.parseInt(query.page ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function paginate<T>(list: T[], query: Record<string, string>): { items: T[]; total: number; page: number; perPage: number } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  return { items: list.slice(start, start + perPage), total: list.length, page, perPage };
}

/** Build a Link header for the next page, or null when this is the last page. */
function nextLink(baseUrl: string, pathname: string, query: Record<string, string>, page: number, perPage: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const url = new URL(pathname, baseUrl);
  for (const [k, v] of Object.entries(query)) {
    if (k !== 'page' && k !== 'per_page') url.searchParams.set(k, v);
  }
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page + 1));
  return `<${url.toString()}>; rel="next"`;
}

export function createRestHandler(store: Store, opts: RestHandlerOpts = {}): RestHandler {
  const gitFactory: () => GitRepoLike =
    opts.createGitRepo ??
    (() => {
      throw apiError(500, 'createGitRepo is not configured: app.ts must pass () => new GitRepo()');
    });
  let requestCounter = 0;

  function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    requestCounter += 1;
    const headers: Record<string, string> = {
      'content-type': JSON_TYPE,
      'x-github-request-id': `req-${requestCounter}`,
      ...extra,
    };
    if (status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const text = `${JSON.stringify(body ?? {})}\n`;
    headers['content-length'] = String(Buffer.byteLength(text));
    res.writeHead(status, headers);
    res.end(text);
  }

  function sendError(res: ServerResponse, status: number, message: string): void {
    send(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
  }

  function readBody(req: IncomingMessage, ctx: RestHandlerCtx | undefined): Promise<string> {
    if (ctx?.body !== undefined) return Promise.resolve(ctx.body);
    if (ctx?.parsedBody !== undefined) return Promise.resolve(JSON.stringify(ctx.parsedBody));
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, ctx: RestHandlerCtx | undefined): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendError(res, 400, 'Bad Request');
      return;
    }
    const pathname = url.pathname;
    const segs = pathname.split('/').filter((s) => s !== '').map(decode);
    const query = parseQuery(url);
    const baseUrl = ctx?.baseUrl ?? opts.baseUrl ?? `http://${req.headers.host ?? 'localhost'}`;
    if (ctx?.viewerLogin) store.learnViewer(ctx.viewerLogin);

    // ---- auth: every /api/v3 route needs the bearer token. ----
    if (!store.isAuthenticated(req.headers.authorization)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const viewer = store.viewerLogin ?? '';

    // ---- body (only methods that carry one). ----
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req, ctx);
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
        if (body !== null && typeof body !== 'object') {
          sendError(res, 400, 'Problems parsing JSON');
          return;
        }
      }
    }
    const input = (body ?? {}) as Record<string, unknown>;

    try {
      await dispatch(req, res, { method, segs, query, pathname, baseUrl, viewer, input });
    } catch (err) {
      if (err instanceof ApiError) {
        sendError(res, err.status, err.message);
        return;
      }
      sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    }
  }

  async function dispatch(
    _req: IncomingMessage,
    res: ServerResponse,
    r: { method: string; segs: string[]; query: Record<string, string>; pathname: string; baseUrl: string; viewer: string; input: Record<string, unknown> },
  ): Promise<void> {
    const { method, segs, query, pathname, baseUrl } = r;
    const input = r.input;
    const needRepo = (owner: string, name: string): RepoRecord => {
      const repo = store.getRepo(owner, name);
      if (!repo) throw apiError(404, 'Not Found');
      return repo;
    };
    const listOut = <T>(list: T[], extra: Record<string, string> = {}): void => {
      const pg = paginate(list, query);
      const link = nextLink(baseUrl, pathname, query, pg.page, pg.perPage, pg.total);
      send(res, 200, pg.items, link ? { link, ...extra } : extra);
    };

    // GET /api/v3/ — root. GET /api/v3/meta.
    if (segs.length === 2 && method === 'GET') {
      send(res, 200, { current_user_url: '/api/v3/user', current_user_authorizations_html_url: '', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (segs.length === 3 && segs[2] === 'meta' && method === 'GET') {
      send(res, 200, { verifiable_password_authentication: true, installed_version: store.installedVersion });
      return;
    }
    // GET /api/v3/user, GET/POST /api/v3/user/repos
    if (segs.length === 3 && segs[2] === 'user' && method === 'GET') {
      send(res, 200, { login: viewer, id: 1, node_id: '', type: 'User', site_admin: false });
      return;
    }
    if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
      if (method === 'GET') {
        listOut(store.listRepos().map((repo) => repoJson(store, repo)));
        return;
      }
      if (method === 'POST') {
        const repo = store.createRepo(
          { name: String(input.name ?? ''), private: input.private === true, description: typeof input.description === 'string' ? input.description : undefined, default_branch: typeof input.default_branch === 'string' ? input.default_branch : undefined },
          gitFactory,
        );
        send(res, 201, repoJson(store, repo));
        return;
      }
    }

    // /api/v3/repos/{owner}/{repo}[...]
    if (segs.length >= 4 && segs[2] === 'repos') {
      const owner = segs[3] ?? '';
      const name = segs[4] ?? '';
      const rest = segs.slice(5);

      if (rest.length === 0) {
        if (method === 'GET') {
          send(res, 200, repoJson(store, needRepo(owner, name)));
          return;
        }
        if (method === 'PATCH') {
          const repo = needRepo(owner, name);
          store.updateRepo(repo, {
            description: typeof input.description === 'string' ? input.description : undefined,
            private: typeof input.private === 'boolean' ? input.private : undefined,
            default_branch: typeof input.default_branch === 'string' ? input.default_branch : undefined,
          });
          send(res, 200, repoJson(store, repo));
          return;
        }
        if (method === 'DELETE') {
          const repo = needRepo(owner, name);
          store.deleteRepo(repo);
          send(res, 204, null);
          return;
        }
      }

      // git/refs, branches, commits
      if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
        const repo = needRepo(owner, name);
        const made = store.createBranch(repo, String(input.ref ?? ''), String(input.sha ?? ''));
        send(res, 201, { ref: made.ref, node_id: '', url: '', object: { sha: made.sha, type: 'commit', url: '' } });
        return;
      }
      if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
        const repo = needRepo(owner, name);
        send(res, 200, store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha, url: '' }, protected: false })));
        return;
      }
      if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
        const repo = needRepo(owner, name);
        const commits = store.listCommits(repo, query.sha);
        send(res, 200, commits.map((c) => ({
          sha: c.sha,
          node_id: '',
          commit: { message: c.message, tree: { sha: c.tree }, author: { name: owner, email: `${owner}@example.invalid`, date: '2025-01-01T00:00:00Z' }, committer: { name: owner, email: `${owner}@example.invalid`, date: '2025-01-01T00:00:00Z' } },
          url: '',
          html_url: '',
          author: { login: owner, id: 1, type: 'User' },
          committer: { login: owner, id: 1, type: 'User' },
          parents: [],
        })));
        return;
      }

      // contents
      if (rest.length >= 1 && rest[0] === 'contents') {
        const repo = needRepo(owner, name);
        const path = rest.slice(1).join('/');
        if (method === 'PUT') {
          if (path === '') throw apiError(422, 'path is required');
          if (typeof input.content !== 'string' || input.content === '') throw apiError(422, 'content is required');
          const result = putContent(store, repo, {
            path,
            contentBase64: input.content,
            message: typeof input.message === 'string' ? input.message : `Update ${path}`,
            branch: typeof input.branch === 'string' ? input.branch : undefined,
            sha: typeof input.sha === 'string' ? input.sha : undefined,
          });
          const b64 = input.content as string;
          send(res, result.status, {
            content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: result.size, url: '', html_url: '', type: 'file', encoding: 'base64', content: b64 },
            commit: { sha: result.commitSha, message: typeof input.message === 'string' ? input.message : '' },
          });
          return;
        }
        if (method === 'GET') {
          const found = getContent(store, repo, path, query.ref);
          if (!found) throw apiError(404, 'Not Found');
          if (found.kind === 'file') {
            send(res, 200, { type: 'file', encoding: 'base64', size: found.size, name: path.split('/').pop() ?? path, path, content: found.content.toString('base64'), sha: found.sha, url: '', html_url: '', download_url: null, _links: { self: '', git: '', html: '' } });
            return;
          }
          send(res, 200, found.entries.map((e) => ({ type: e.type, size: e.size, name: e.name, path: e.path, sha: e.sha, url: '', html_url: '', download_url: null, _links: { self: '', git: '', html: '' } })));
          return;
        }
        if (method === 'DELETE') {
          const { commitSha } = deleteContent(store, repo, {
            path,
            message: typeof input.message === 'string' ? input.message : `Delete ${path}`,
            branch: typeof input.branch === 'string' ? input.branch : undefined,
            sha: typeof input.sha === 'string' ? input.sha : undefined,
          });
          send(res, 200, { commit: { sha: commitSha }, content: null });
          return;
        }
      }

      // labels
      if (rest.length === 1 && rest[0] === 'labels') {
        const repo = needRepo(owner, name);
        if (method === 'POST') {
          send(res, 201, labelJson(createLabel(store, repo, String(input.name ?? ''), typeof input.color === 'string' ? input.color : undefined)));
          return;
        }
        if (method === 'GET') {
          send(res, 200, [...repo.labels.values()].map(labelJson));
          return;
        }
      }

      // issues
      if (rest.length >= 1 && rest[0] === 'issues') {
        const repo = needRepo(owner, name);
        if (rest.length === 1) {
          if (method === 'POST') {
            const issue = createIssue(store, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined, labels: input.labels });
            send(res, 201, issueJson(store, repo, issue));
            return;
          }
          if (method === 'GET') {
            listOut(listIssues(repo, { state: query.state, sort: query.sort, direction: query.direction }).map((i) => issueJson(store, repo, i)));
            return;
          }
        }
        const num = Number(rest[1]);
        if (rest.length === 2 && Number.isInteger(num)) {
          const issue = repo.issues.get(num);
          if (!issue) throw apiError(404, 'Not Found');
          if (method === 'GET') {
            send(res, 200, issueJson(store, repo, issue));
            return;
          }
          if (method === 'PATCH') {
            const updated = updateIssue(repo, num, { title: typeof input.title === 'string' ? input.title : undefined, body: typeof input.body === 'string' ? input.body : undefined, state: typeof input.state === 'string' ? input.state : undefined, labels: input.labels });
            send(res, 200, issueJson(store, repo, updated));
            return;
          }
        }
        if (rest.length === 3 && rest[2] === 'comments' && Number.isInteger(num)) {
          if (method === 'POST') {
            send(res, 201, commentJson(store, repo, addIssueComment(store, repo, num, typeof input.body === 'string' ? input.body : '')));
            return;
          }
          if (method === 'GET') {
            send(res, 200, listIssueComments(repo, num).map((c) => commentJson(store, repo, c)));
            return;
          }
        }
      }

      // pulls
      if (rest.length >= 1 && rest[0] === 'pulls') {
        const repo = needRepo(owner, name);
        if (rest.length === 1) {
          if (method === 'POST') {
            const pull = createPull(store, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined, head: String(input.head ?? ''), base: String(input.base ?? '') });
            send(res, 201, pullJson(store, repo, pull));
            return;
          }
          if (method === 'GET') {
            listOut(listPulls(repo, { state: query.state }).map((p) => pullJson(store, repo, p)));
            return;
          }
        }
        const num = Number(rest[1]);
        if (rest.length === 2 && Number.isInteger(num)) {
          const pull = repo.pulls.get(num);
          if (!pull) throw apiError(404, 'Not Found');
          if (method === 'GET') {
            send(res, 200, pullJson(store, repo, pull));
            return;
          }
        }
        if (rest.length === 3 && rest[2] === 'files' && Number.isInteger(num) && method === 'GET') {
          const pull = repo.pulls.get(num);
          if (!pull) throw apiError(404, 'Not Found');
          send(res, 200, pullFiles(store, repo, pull).map((f) => ({ sha: f.sha, filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '' })));
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && Number.isInteger(num) && method === 'PUT') {
          const merged = mergePull(store, repo, num, typeof input.merge_method === 'string' ? input.merge_method : undefined);
          send(res, 200, { sha: merged.sha, merged: true, message: merged.message });
          return;
        }
      }
    }

    // Unknown /api/v3 route: JSON 404, never HTML.
    sendError(res, 404, 'Not Found');
  }

  return (req: IncomingMessage, res: ServerResponse, ctx?: RestHandlerCtx): boolean => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      pathname = '/';
    }
    if (pathname !== '/api/v3' && pathname !== '/api/v3/' && !pathname.startsWith('/api/v3/')) return false;
    void handle(req, res, ctx).catch(() => {
      try {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is gone; nothing left to do.
      }
    });
    return true;
  };
}
