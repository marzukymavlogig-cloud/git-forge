# Interfaces — store / REST / GraphQL layers

Forge workdir: `~/workspace/makefun/forge/`. Node 22, TypeScript erasable-only
syntax (no enums, namespaces, parameter properties), stdlib only, no
dependencies. Run with `~/workspace/makefun/node22/bin/node main.ts`
(Node strips types).

## Files

| File | Contents |
| --- | --- |
| `store.ts` | In-memory `Store`, git-object helpers, record types, JSON serializers |
| `rest.ts` | `createRestHandler(store, opts)` — REST v3 under `/api/v3` |
| `graphql.ts` | `createGraphqlHandler(store, opts)` — GraphQL v4 at `/api/graphql` |
| `git.ts` | (git-core implementer) `GitRepo` — one instance per repository |

## Store (`store.ts`)

```ts
import { Store } from './store.ts';
const store = new Store({
  token: process.env.MAKEFUN_SHOP_TOKEN,   // default when omitted
  login: undefined,                        // viewer login, if already known
  baseUrl: undefined,                      // default: request Host
  installedVersion: '1.0.0',               // GET /api/v3/meta
});
```

### Key exports

- `class Store` — the whole data model. One instance for the process.
  - `store.token: string`, `store.viewerLogin: string | null`,
    `store.repos: Map<string, RepoRecord>`, `store.seq: number`
    (monotonic creation counter; see Determinism below).
  - `store.isAuthenticated(authorization?: string): boolean` — `Bearer <token>`
    exact match against the configured token. Empty configured token
    authenticates nothing.
  - `store.authContext(authorization?: string): AuthContext | null`
  - `store.resolveOwner(owner: string): boolean` — true when `owner` is the
    viewer (learns the viewer on first sight, see Viewer login below).
  - `store.learnViewer(login: string): void`
  - `store.createRepo(input, gitFactory): RepoRecord` — throws `ApiError(422)`
    on a duplicate/invalid name. `input = { name, private?, description?,
    default_branch? }`.
  - `store.getRepo(owner, name): RepoRecord | undefined` (404 when the owner
    is not the viewer), `store.getRepoByName(name)`, `store.listRepos()`,
    `store.deleteRepo(repo)`, `store.updateRepo(repo, patch)`
  - `store.createBranch(repo, ref, sha)`, `store.listBranches(repo)`,
    `store.branchTip(repo, branch): string | undefined`,
    `store.resolveRef(repo, refish?)`, `store.listCommits(repo, refish?)`
  - `store.commitTree(repo, branch, files: Map<string, Buffer>, message)`,
    `store.filesAt(repo, branch)`, `store.filesAtCommit(repo, sha)`,
    `store.treeShaAtCommit(repo, sha)`
  - Contents (module functions taking the store):
    `putContent(store, repo, { path, contentBase64, message, branch?, sha? })`
    → `{ status: 200|201, contentSha, commitSha, path, size }` (throws
    `ApiError(409)` on a stale sha, `404` on delete of a missing file);
    `getContent(store, repo, path, ref?)` → file/dir/`null`;
    `deleteContent(store, repo, { path, message, branch?, sha? })`
  - `createLabel(store, repo, name, color?)`, `createIssue(store, repo,
    { title, body?, labels? })` (throws `ApiError(422)` on an unknown label),
    `listIssues(repo, { state?, sort?, direction? })`,
    `updateIssue(repo, number, patch)`, `addIssueComment(store, repo, number,
    body)`, `listIssueComments(repo, number)`, `addPullComment(...)`
  - `createPull(store, repo, { title, body?, head, base })` (throws
    `ApiError(422)` on an unknown branch or a duplicate open PR for the
    same head/base), `listPulls(repo, { state? })`,
    `pullFiles(store, repo, pull)` → `PullFile[]`,
    `isMergeable(store, repo, pull): boolean`,
    `mergePull(store, repo, number, method?)` → `{ sha, message }`
    (throws `ApiError(404)` unknown PR, `ApiError(405)` conflicted/closed)
  - Global ids: `repoGlobalId / issueGlobalId / pullGlobalId /
    commentGlobalId(store, repo, …)` — base64(`Kind:key`), opaque and
    stable; `findByGlobalId(store, id)` → `{ kind, repo, issue?, pull?,
    comment? } | null`; `decodeGlobalId(id)`, `globalId(kind, key)`.
  - Serializers: `repoJson / issueJson / pullJson / labelJson /
    commentJson(store, repo, record)` — the exact REST shapes.
  - Git helpers: `parseCommit`, `parseTree`, `buildTree`,
    `flattenTree`, `readBlob`, `makeCommit`, `listCommits`, `diffTrees`.
- `class ApiError extends Error { status: number }`,
  `apiError(status, message): ApiError`.
- `interface AuthContext { login: string; authenticated: boolean }`
- `interface HandlerOpts { token?; login?; baseUrl?; installedVersion? }`
- `const TS_BASE_SEC = 1735689600`, `tsFor(seq): string`,
  `b64encode / b64decode`.

### Record shapes (stored, plain objects)

- `RepoRecord`: `name, fullName, ownerLogin: string | null, description,
  private, defaultBranch, databaseId (store-wide counter from 1), seq,
  git: GitRepoLike, labels: Map<string, LabelRecord>, issues:
  Map<number, IssueRecord>, issueSeq, pulls: Map<number, PullRecord>,
  pullSeq, issueComments / pullComments: Map<number, CommentRecord[]>,
  commentSeq`.
- `IssueRecord`: `number, title, body, state: 'open'|'closed', labels:
  LabelRecord[], seq, userLogin`. `PullRecord`: `number, title, body,
  state, merged, mergedAt: string | null, mergeCommitSha: string | null,
  headRef, headSha, baseRef, baseSha, baseShaAtCreate, seq, userLogin`.
  Issue and PR numbers are **separate per-repo sequences starting at 1**.
- `LabelRecord`: `id, name, color, description, seq`.
  `CommentRecord`: `id, body, userLogin, seq` (ids are per-repo counters).

### Determinism — no timestamps in stored state

No `Date.now()` / wall clock is read anywhere. Creation order is the
monotonic `store.seq` counter; every emitted timestamp (`created_at`,
`updated_at`, `merged_at`, git author/committer dates) is
`tsFor(seq)` = `2025-01-01T00:00:00Z + seq` seconds, so identical request
streams give identical state.

## REST (`rest.ts`)

```ts
import { createRestHandler } from './rest.ts';
const restHandler = createRestHandler(store, {
  token, login, baseUrl, installedVersion,   // HandlerOpts, all optional
  createGitRepo: () => new GitRepo(),        // REQUIRED (see below)
});
```

- `createRestHandler(store, opts?: RestHandlerOpts): RestHandler`
- `type RestHandler = (req: IncomingMessage, res: ServerResponse, ctx?: RestHandlerCtx) => boolean`
  Returns `true` when the path is under `/api/v3` (the handler then owns the
  response, asynchronously); `false` otherwise — call the next handler
  (git, GraphQL, MCP, `/healthz`).
- `interface RestHandlerCtx { baseUrl?; viewerLogin?; body?: string; parsedBody?: unknown }`
  `viewerLogin` binds the viewer when the app knows it; `body`/`parsedBody`
  let app.ts pass an already-consumed request body.
- `createGitRepo` is **required**: one fresh `GitRepo` per repository is
  created through it (POST `/user/repos`). If it is absent, repo creation
  answers 500. app.ts must pass `() => new GitRepo()` from `git.ts`.
- Routes (all require the bearer token; no token → 401 JSON
  `{message}`; other-owner repo → 404, never 403; every reply
  `application/json` + non-empty `X-GitHub-Request-Id`; unknown route →
  JSON 404; malformed JSON body → 400):
  `GET /api/v3/` (200 + `X-OAuth-Scopes`), `GET /api/v3/meta` (200
  `{installed_version}`), `GET /api/v3/user`, `GET/POST
  /api/v3/user/repos` (201; duplicate name → 422; list paginates with
  `?page=&per_page=` (default 30) and a `Link: <…>; rel="next"` header),
  `GET/PATCH/DELETE /api/v3/repos/{o}/{r}` (200/200/204),
  `POST /api/v3/repos/{o}/{r}/git/refs` (201 `{ref, object:{sha}}`),
  `GET …/branches`, `GET …/commits[?sha=<ref>]`,
  `PUT/GET/DELETE …/contents/{path}` (201 create / 200 update / 409 stale
  sha / 200 `{commit:{sha}}` on delete; GET returns a file object or a
  directory array; `?ref=` selects a branch/commit),
  `POST/GET …/labels` (201), `POST/GET …/issues` (201; 422 unknown label),
  `GET/PATCH …/issues/{n}`, `POST/GET …/issues/{n}/comments` (201),
  `POST/GET …/pulls` (201; duplicate open PR for the same head/base → 422),
  `GET …/pulls/{n}`, `GET …/pulls/{n}/files`, `PUT …/pulls/{n}/merge`
  (200 `{sha, merged:true, message}`; 404 unknown; 405 conflicted).
  Merge is a squash: one commit on the base branch whose tree is the head
  tree, parent the base tip; the PR becomes closed/merged with
  `merge_commit_sha` and a seq-derived `merged_at`.

## GraphQL (`graphql.ts`)

```ts
import { createGraphqlHandler } from './graphql.ts';
const gqlHandler = createGraphqlHandler(store, { token, login, baseUrl });
```

- `createGraphqlHandler(store, opts?: HandlerOpts): GraphqlHandler`
- `type GraphqlHandler = (req, res, ctx?: GraphqlHandlerCtx) => boolean`
  Returns `true` only for `POST /api/graphql`; `false` otherwise.
- `interface GraphqlHandlerCtx { baseUrl?; viewerLogin?; body?; parsedBody? }`
- Also exported for tests: `executeGraphQL(store, query, variables,
  operationName?) → { data, errors }` and `parseDocument(query)`.
- Behaviour: unauthenticated → exactly 401. Single object body
  `{query, variables, operationName}` or a JSON array (batching — one
  result per operation, in order). Unknown field → HTTP 200 with an
  `errors` array whose message names the field
  (`Cannot query field "X" on type "Y".`). Unknown repository →
  `data.repository: null`, no errors.
- Supported surface: `Query.viewer{login}`, `Query.repository(owner, name)`,
  `Query.node(id:)` (Relay ids round-trip repositories/issues/PRs),
  `Query.__type(name:)` (`fields` / `enumValues`; `Issue`, `PullRequest`,
  `Repository`, `SearchType` incl. `ISSUE`), `Repository{id, databaseId,
  name, nameWithOwner, owner, defaultBranchRef, viewerPermission,
  hasIssuesEnabled, issue(number), issues(first, states, orderBy, after),
  pullRequests(first), pullRequest(number)}`,
  `Issue{id, number, title, state, body}`, `PullRequest{id, number, state,
  merged, headRefName, baseRefName, mergeable, files(first)}`.
  `issues` ordering: `orderBy {field: CREATED_AT, direction: DESC}` →
  numbers descending, ties number DESC; `states: [OPEN]` omits closed;
  `first`/`after` cursor paging with `pageInfo{hasNextPage, endCursor}`.
  Mutations: `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest` (SQUASH), `addComment` — all act on the same `Store`
  as REST, so a PR/issue created over GraphQL reads back over REST.

## GitRepo interface assumed (`git.ts`)

```ts
class GitRepo {
  refs: Map<string, string>;
  getRef(name: string): string | undefined;
  setRef(name: string, sha: string): void;
  deleteRef(name: string): boolean;
  hasObject(sha: string): boolean;
  getObject(sha: string): { type: string; data: Buffer } | undefined;
  putObject(type: string, data: Buffer): string; // returns the object id
}
```

`store.ts` imports this only as `import type` (erased at runtime) and
works against the structural `GitRepoLike` above. **Verified 2026-11-17
against the real `git.ts`**: it matches exactly — `refs: Map`, the six
methods, `data: Buffer`, SHA-1 content-addressed `putObject`, standard
git object formats (commit text with `tree`/`parent` lines, tree binary
entries `"<mode> <name>\0<20-byte sha>"`, blob raw bytes), and
`refs/heads/<branch>` → commit sha. The store's own
`parseCommit/parseTree/buildTree/makeCommit` duplicate `git.ts`'s
parsers (same formats) rather than importing them, so the layers stay
independent. If `GitRepo` ever differs, only those helpers need
adapting — the REST/GraphQL layers never touch git objects directly.

## Viewer login — how the token's owner is known

The trial token (`MAKEFUN_SHOP_TOKEN`) is opaque: no environment variable
carries the scenario login. The store therefore **learns the viewer login
from the first owner-named request** (`GET /repos/{owner}/…`,
`repository(owner:, …)`): that owner becomes the viewer, and any other
owner then answers 404 (never 403). Repos created via `POST /user/repos`
before learning are re-keyed under the learned owner. If app.ts already
knows the login, pass it as `login` in the handler opts (or set
`MAKEFUN_VIEWER_LOGIN`) to skip learning. Risk: if the very first
owner-named request named a stranger, the stranger would be learned as
the viewer — the suite always names the viewer first (pagination runs
first), so this does not occur in the graded run.

## How app.ts should call them

```ts
import { createServer } from 'node:http';
import { Store } from './store.ts';
import { createRestHandler } from './rest.ts';
import { createGraphqlHandler } from './graphql.ts';
import { GitRepo } from './git.ts';

const store = new Store({}); // reads MAKEFUN_SHOP_TOKEN from env
const rest = createRestHandler(store, { createGitRepo: () => new GitRepo() });
const gql = createGraphqlHandler(store, {});
const server = createServer((req, res) => {
  if (req.method === 'GET' && new URL(req.url ?? '/', 'http://x').pathname === '/healthz') { /* 200 {ok:true} */ return; }
  if (rest(req, res)) return;
  if (gql(req, res)) return;
  // … git smart HTTP, MCP, then a JSON 404 for anything else …
});
```

Handlers never throw synchronously for a request they claim; unexpected
failures are answered 500 JSON. Handlers are allocation-light (Map
lookups, one `JSON.stringify` per reply) for the 2000-read / 200-write
benchmarks; no per-request I/O.

## Verification (2026-11-17, local, node22)

- Standalone test `/tmp/forge-test.ts` (server wiring rest + GraphQL +
  the real `GitRepo`): **114/114 pass**, replaying the check flows from
  `checks-rest.ts` / `checks-graphql.ts` (pagination, contents incl.
  stale-sha 409 and directory listing, branches/commits, labels/issues/
  comments, PR create/files/merge/conflict 405, all 20 GraphQL documents
  incl. batching, invalid field, node round-trip, cursor pagination).
- Kit conformance runner (`sdk/run.ts`) against a test server wiring
  rest + GraphQL + `createGitHandler`: **105/120** — git 30/30, repos
  15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20.
  MCP 0/15 is the MCP layer (not wired in that test server; not this
  implementer's scope).
- Perf on this VM (keep-alive, same shape as the bench): 2000 issue
  GETs **1745–1776 ms** (T_ref 2759 ms), 200 issue POSTs **216 ms**
  (T_ref 349 ms).
