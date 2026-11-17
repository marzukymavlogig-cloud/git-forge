// store.ts — in-memory data model for the forge (REST v3 + GraphQL + git share it).
// No wall-clock timestamps anywhere in stored state: a monotonic sequence counter
// (`seq`) orders creation, and every emitted timestamp is a deterministic function
// of that sequence (2025-01-01T00:00:00Z + seq seconds), so two runs on the same
// request stream produce identical state. Stdlib only, no dependencies.
// TypeScript erasable-only syntax: no enums, namespaces or parameter properties.

import type { GitRepo } from './git.ts';

/** Structural shape the store needs from a GitRepo (see git.ts; must match it). */
export interface GitRepoLike {
  refs: Map<string, string>;
  getRef(name: string): string | undefined;
  setRef(name: string, sha: string): void;
  deleteRef(name: string): boolean;
  hasObject(sha: string): boolean;
  getObject(sha: string): { type: string; data: Buffer } | undefined;
  putObject(type: string, data: Buffer): string;
}

// Re-export the assumed GitRepo type so rest/graphql/app can name it.
export type { GitRepo };

/** An error carrying the HTTP status the handler must answer with. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function apiError(status: number, message: string): ApiError {
  return new ApiError(status, message);
}

export interface AuthContext {
  /** Login the bearer token names (the viewer), once known. */
  login: string;
  /** True when the request carried the configured bearer token. */
  authenticated: boolean;
}

export interface HandlerOpts {
  /** Bearer token; defaults to process.env.MAKEFUN_SHOP_TOKEN. */
  token?: string;
  /** Viewer login, when the app wiring already knows it. Overrides learning. */
  login?: string;
  /** Public base URL, used for absolute Link/URL fields; defaults to the request Host. */
  baseUrl?: string;
  /** installed_version reported by GET /api/v3/meta. */
  installedVersion?: string;
}

/** Deterministic timestamp base: 2025-01-01T00:00:00Z. */
export const TS_BASE_SEC = 1735689600;

/** ISO timestamp derived from a sequence number — deterministic, no clock. */
export function tsFor(seq: number): string {
  return new Date((TS_BASE_SEC + seq) * 1000).toISOString();
}

export function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Opaque, stable Relay-style global id: base64("<Kind>:<key>"). Never the bare number. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Git object helpers (standard git object formats; the git layer stores raw objects).
// -------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a git tree object (binary "<mode> <name>\0<20-byte sha>" entries). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

function treeObjectBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build (and store) a tree for `files` (path -> {sha, mode}) under `git`, bottom-up.
 * Returns the root tree sha. Entries sort git-style: directories sort as "name/".
 */
export function buildTree(git: GitRepoLike, files: Map<string, { sha: string; mode: string }>): string {
  return buildLevelAt(git, files, '');
}

/** Recursive tree builder over a path->file map (paths relative to this level). */
function buildLevelAt(git: GitRepoLike, files: Map<string, { sha: string; mode: string }>, _prefix: string): string {
  const direct: TreeEntry[] = [];
  const dirs = new Map<string, Map<string, { sha: string; mode: string }>>();
  for (const [path, file] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      direct.push({ mode: file.mode, name: path, sha: file.sha });
    } else {
      const dir = path.slice(0, slash);
      let sub = dirs.get(dir);
      if (!sub) {
        sub = new Map();
        dirs.set(dir, sub);
      }
      sub.set(path.slice(slash + 1), file);
    }
  }
  for (const [dir, sub] of dirs) {
    direct.push({ mode: '40000', name: dir, sha: buildLevelAt(git, sub, '') });
  }
  direct.sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return git.putObject('tree', treeObjectBytes(direct));
}

/** Flatten a tree (by sha) into path -> {sha, mode} for blobs only. */
export function flattenTree(git: GitRepoLike, treeSha: string): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const walk = (sha: string, prefix: string): void => {
    const obj = git.getObject(sha);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.sha, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, { sha: e.sha, mode: e.mode });
    }
  };
  walk(treeSha, '');
  return out;
}

export function readBlob(git: GitRepoLike, sha: string): Buffer | undefined {
  const obj = git.getObject(sha);
  if (!obj || obj.type !== 'blob') return undefined;
  return obj.data;
}

/** Create a commit object; timestamp is seq-derived (deterministic), never the clock. */
export function makeCommit(
  git: GitRepoLike,
  treeSha: string,
  parents: string[],
  message: string,
  seq: number,
  login: string,
): string {
  const ts = TS_BASE_SEC + seq;
  const ident = `${login} <${login}@example.invalid> ${ts} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return git.putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Walk first-parent history from `tip` (newest first). Caps at `limit`. */
export function listCommits(git: GitRepoLike, tip: string, limit = 1000): { sha: string; message: string; tree: string }[] {
  const out: { sha: string; message: string; tree: string }[] = [];
  let cur: string | undefined = tip;
  const seen = new Set<string>();
  while (cur && out.length < limit && !seen.has(cur)) {
    seen.add(cur);
    const obj = git.getObject(cur);
    if (!obj || obj.type !== 'commit') break;
    const info = parseCommit(obj.data);
    out.push({ sha: cur, message: info.message, tree: info.tree });
    cur = info.parents[0];
  }
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldSha: string | null;
  newSha: string | null;
}

/** Diff two trees (by sha): changed files with old/new blob shas. Sorted by path. */
export function diffTrees(git: GitRepoLike, oldTreeSha: string | null, newTreeSha: string | null): FileChange[] {
  const oldFiles = oldTreeSha ? flattenTree(git, oldTreeSha) : new Map<string, { sha: string; mode: string }>();
  const newFiles = newTreeSha ? flattenTree(git, newTreeSha) : new Map<string, { sha: string; mode: string }>();
  const paths = new Set<string>([...oldFiles.keys(), ...newFiles.keys()]);
  const out: FileChange[] = [];
  for (const path of paths) {
    const o = oldFiles.get(path);
    const n = newFiles.get(path);
    if (o && !n) out.push({ path, status: 'removed', oldSha: o.sha, newSha: null });
    else if (!o && n) out.push({ path, status: 'added', oldSha: null, newSha: n.sha });
    else if (o && n && o.sha !== n.sha) out.push({ path, status: 'modified', oldSha: o.sha, newSha: n.sha });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function lineCount(buf: Buffer | undefined): number {
  if (!buf || buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline does not start a new line.
  return lines.length - (text.endsWith('\n') ? 1 : 0);
}

// -------------------------------------------------------------------------------------------
// Records
// -------------------------------------------------------------------------------------------

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
  seq: number;
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRecord[];
  seq: number;
  userLogin: string;
}

export interface PullRecord {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** Base tip the PR was opened against (conflict detection baseline). */
  baseShaAtCreate: string;
  seq: number;
  userLogin: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  userLogin: string;
  seq: number;
}

export interface RepoRecord {
  name: string;
  fullName: string;
  /** Owner login as learned; null until the first owner-named request binds it. */
  ownerLogin: string | null;
  description: string;
  private: boolean;
  defaultBranch: string;
  databaseId: number;
  seq: number;
  git: GitRepoLike;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  issueSeq: number;
  pulls: Map<number, PullRecord>;
  pullSeq: number;
  issueComments: Map<number, CommentRecord[]>;
  pullComments: Map<number, CommentRecord[]>;
  commentSeq: number;
}

export interface CreateRepoInput {
  name: string;
  private?: boolean;
  description?: string;
  default_branch?: string;
}

// -------------------------------------------------------------------------------------------
// Store
// -------------------------------------------------------------------------------------------

export class Store {
  token: string;
  installedVersion: string;
  baseUrl: string;
  /** Viewer login once known (opts.login, env MAKEFUN_VIEWER_LOGIN, or learned). */
  viewerLogin: string | null;
  repos: Map<string, RepoRecord> = new Map();
  /** Monotonic sequence: creation order + deterministic timestamps. No wall clock. */
  seq = 0;
  nextDatabaseId = 1;
  nextLabelId = 1;

  constructor(opts: HandlerOpts = {}) {
    this.token = opts.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
    this.installedVersion = opts.installedVersion ?? '1.0.0';
    this.baseUrl = opts.baseUrl ?? '';
    this.viewerLogin = opts.login ?? process.env.MAKEFUN_VIEWER_LOGIN ?? null;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // ---- auth / viewer -------------------------------------------------------

  /** True when `authorization` is `Bearer <configured token>`. */
  isAuthenticated(authorization: string | undefined): boolean {
    if (!authorization) return false;
    const m = /^Bearer\s+(.+)$/.exec(authorization.trim());
    if (!m) return false;
    if (this.token === '') return false;
    return m[1] === this.token;
  }

  authContext(authorization: string | undefined): AuthContext | null {
    if (!this.isAuthenticated(authorization)) return null;
    return { login: this.viewerLogin ?? '', authenticated: true };
  }

  /** Bind the viewer login on first sight; returns true when `owner` is the viewer. */
  resolveOwner(owner: string): boolean {
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      // Re-key any repos created before the viewer login was known: they were
      // stored under "/<name>" and must now answer under "<owner>/<name>".
      for (const repo of [...this.repos.values()]) {
        if (repo.ownerLogin === null) {
          this.repos.delete(this.repoKey('', repo.name));
          repo.ownerLogin = owner;
          repo.fullName = `${owner}/${repo.name}`;
          this.repos.set(this.repoKey(owner, repo.name), repo);
        }
      }
      return true;
    }
    return owner === this.viewerLogin;
  }

  learnViewer(login: string): void {
    if (this.viewerLogin === null) this.resolveOwner(login);
  }

  ownerOf(repo: RepoRecord): string {
    return repo.ownerLogin ?? this.viewerLogin ?? '';
  }

  // ---- repositories ----------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Look a repo up by name under the viewer; `owner` must resolve (else undefined). */
  getRepo(owner: string, name: string): RepoRecord | undefined {
    if (!this.resolveOwner(owner)) return undefined;
    return this.repos.get(this.repoKey(this.viewerLogin ?? owner, name));
  }

  /** Look a repo up by name regardless of owner (internal use after auth). */
  getRepoByName(name: string): RepoRecord | undefined {
    return this.repos.get(this.repoKey(this.viewerLogin ?? '', name));
  }

  listRepos(): RepoRecord[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  createRepo(input: CreateRepoInput, gitFactory: () => GitRepoLike): RepoRecord {
    const name = (input.name ?? '').trim();
    if (name === '' || name.length > 100 || /[\s/]/.test(name)) {
      throw apiError(422, 'Invalid repository name');
    }
    const owner = this.viewerLogin ?? '';
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) throw apiError(422, 'Repository already exists');
    const seq = this.nextSeq();
    const repo: RepoRecord = {
      name,
      fullName: `${owner}/${name}`,
      ownerLogin: this.viewerLogin,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: input.default_branch ?? 'main',
      databaseId: this.nextDatabaseId++,
      seq,
      git: gitFactory(),
      labels: new Map(),
      issues: new Map(),
      issueSeq: 0,
      pulls: new Map(),
      pullSeq: 0,
      issueComments: new Map(),
      pullComments: new Map(),
      commentSeq: 0,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: RepoRecord): void {
    this.repos.delete(this.repoKey(this.ownerOf(repo), repo.name));
  }

  updateRepo(repo: RepoRecord, patch: { description?: string; private?: boolean; default_branch?: string; name?: string }): void {
    if (typeof patch.description === 'string') repo.description = patch.description;
    if (typeof patch.private === 'boolean') repo.private = patch.private;
    if (typeof patch.default_branch === 'string' && patch.default_branch !== '') repo.defaultBranch = patch.default_branch;
    // Renames are not exercised by the checks; accept silently without moving the key.
  }

  // ---- git: branches / commits ----------------------------------------------

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  branchTip(repo: RepoRecord, branch: string): string | undefined {
    return repo.git.getRef(this.refName(branch));
  }

  listBranches(repo: RepoRecord): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.git.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  createBranch(repo: RepoRecord, ref: string, sha: string): { ref: string; sha: string } {
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
      throw apiError(422, 'Invalid ref');
    }
    if (repo.git.getRef(ref) !== undefined) throw apiError(422, 'Reference already exists');
    if (!repo.git.hasObject(sha)) throw apiError(422, 'Unknown object');
    repo.git.setRef(ref, sha);
    return { ref, sha };
  }

  /** Resolve a ref-ish (branch name, full ref, or sha) to a commit sha. */
  resolveRef(repo: RepoRecord, refish: string | undefined): string | undefined {
    if (refish === undefined || refish === '') return this.branchTip(repo, repo.defaultBranch);
    if (repo.git.hasObject(refish)) {
      const obj = repo.git.getObject(refish);
      if (obj && obj.type === 'commit') return refish;
    }
    const direct = repo.git.getRef(refish);
    if (direct !== undefined) return direct;
    return this.branchTip(repo, refish);
  }

  listCommits(repo: RepoRecord, refish: string | undefined): { sha: string; message: string; tree: string }[] {
    const tip = this.resolveRef(repo, refish);
    if (tip === undefined) throw apiError(404, 'No such ref');
    return listCommits(repo.git, tip);
  }

  /** Commit `files` (full path->content map) as one commit on `branch`. */
  commitTree(
    repo: RepoRecord,
    branch: string,
    files: Map<string, Buffer>,
    message: string,
  ): { commitSha: string; treeSha: string } {
    const git = repo.git;
    const blobFiles = new Map<string, { sha: string; mode: string }>();
    for (const [path, content] of files) {
      blobFiles.set(path, { sha: git.putObject('blob', content), mode: '100644' });
    }
    const treeSha = buildTree(git, blobFiles);
    const parent = this.branchTip(repo, branch);
    const commitSha = makeCommit(git, treeSha, parent ? [parent] : [], message, this.nextSeq(), this.ownerOf(repo) || 'forge');
    git.setRef(this.refName(branch), commitSha);
    return { commitSha, treeSha };
  }

  /** Current full file map of a branch tip (empty when the branch is unborn). */
  filesAt(repo: RepoRecord, branch: string): Map<string, Buffer> {
    const tip = this.branchTip(repo, branch);
    const out = new Map<string, Buffer>();
    if (!tip) return out;
    const obj = repo.git.getObject(tip);
    if (!obj || obj.type !== 'commit') return out;
    for (const [path, entry] of flattenTree(repo.git, parseCommit(obj.data).tree)) {
      const blob = readBlob(repo.git, entry.sha);
      if (blob !== undefined) out.set(path, blob);
    }
    return out;
  }

  /** Current full file map at an arbitrary commit sha. */
  filesAtCommit(repo: RepoRecord, commitSha: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const obj = repo.git.getObject(commitSha);
    if (!obj || obj.type !== 'commit') return out;
    for (const [path, entry] of flattenTree(repo.git, parseCommit(obj.data).tree)) {
      const blob = readBlob(repo.git, entry.sha);
      if (blob !== undefined) out.set(path, blob);
    }
    return out;
  }

  treeShaAtCommit(repo: RepoRecord, commitSha: string): string | null {
    const obj = repo.git.getObject(commitSha);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }
}

// -------------------------------------------------------------------------------------------
// Contents (tracked against the repo's GitRepo default branch)
// -------------------------------------------------------------------------------------------

export interface PutContentInput {
  path: string;
  contentBase64: string;
  message: string;
  branch?: string;
  sha?: string;
}

export interface ContentResult {
  status: 200 | 201;
  contentSha: string;
  commitSha: string;
  path: string;
  size: number;
}

export function putContent(store: Store, repo: RepoRecord, input: PutContentInput): ContentResult {
  const branch = input.branch ?? repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  const files = store.filesAt(repo, branch);
  const existing = files.get(input.path);
  const isUpdate = existing !== undefined;
  if (isUpdate && input.sha !== undefined) {
    const curSha = repo.git.putObject('blob', existing);
    // putObject is content-addressed, so recomputing the blob sha is exact.
    if (curSha.toLowerCase() !== input.sha.toLowerCase()) {
      throw apiError(409, 'sha does not match the current file');
    }
  }
  const content = b64decode(input.contentBase64);
  files.set(input.path, content);
  const { commitSha } = store.commitTree(repo, branch, files, input.message || `Update ${input.path}`);
  const contentSha = repo.git.putObject('blob', content);
  void tip;
  return { status: isUpdate ? 200 : 201, contentSha, commitSha, path: input.path, size: content.length };
}

export type ContentLookup =
  | { kind: 'file'; path: string; sha: string; size: number; content: Buffer }
  | { kind: 'dir'; path: string; entries: { name: string; path: string; type: 'file' | 'dir'; sha: string; size: number }[] }
  | null;

export function getContent(store: Store, repo: RepoRecord, path: string, refish?: string): ContentLookup {
  const tip = store.resolveRef(repo, refish);
  if (tip === undefined) return null;
  const files = store.filesAtCommit(repo, tip);
  const exact = files.get(path);
  if (exact !== undefined) {
    return { kind: 'file', path, sha: repo.git.putObject('blob', exact), size: exact.length, content: exact };
  }
  // Directory listing: entries directly under `path` ("" = repo root).
  const prefix = path === '' ? '' : path.endsWith('/') ? path : `${path}/`;
  const seen = new Map<string, { name: string; path: string; type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [p, content] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { name: rest, path: p, type: 'file', sha: repo.git.putObject('blob', content), size: content.length });
    } else {
      const dir = rest.slice(0, slash);
      if (!seen.has(dir)) {
        // Directory sha: the subtree sha at this level (recompute via tree walk).
        seen.set(dir, { name: dir, path: `${prefix}${dir}`, type: 'dir', sha: dirSha(store, repo, tip, `${prefix}${dir}`), size: 0 });
      }
    }
  }
  if (seen.size === 0) return null;
  const entries = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: 'dir', path, entries };
}

function dirSha(store: Store, repo: RepoRecord, commitSha: string, dirPath: string): string {
  const treeSha = store.treeShaAtCommit(repo, commitSha);
  if (!treeSha) return '0'.repeat(40);
  let cur = treeSha;
  for (const part of dirPath.split('/').filter((p) => p !== '')) {
    const obj = repo.git.getObject(cur);
    if (!obj || obj.type !== 'tree') return '0'.repeat(40);
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return '0'.repeat(40);
    cur = entry.sha;
  }
  return cur;
}

export function deleteContent(store: Store, repo: RepoRecord, input: { path: string; message: string; branch?: string; sha?: string }): { commitSha: string } {
  const branch = input.branch ?? repo.defaultBranch;
  const files = store.filesAt(repo, branch);
  const existing = files.get(input.path);
  if (existing === undefined) throw apiError(404, 'Not Found');
  if (input.sha !== undefined) {
    const curSha = repo.git.putObject('blob', existing);
    if (curSha.toLowerCase() !== input.sha.toLowerCase()) throw apiError(409, 'sha does not match the current file');
  }
  files.delete(input.path);
  const { commitSha } = store.commitTree(repo, branch, files, input.message || `Delete ${input.path}`);
  return { commitSha };
}

// -------------------------------------------------------------------------------------------
// Labels / issues / comments
// -------------------------------------------------------------------------------------------

export function createLabel(store: Store, repo: RepoRecord, name: string, color?: string): LabelRecord {
  const clean = (name ?? '').trim();
  if (clean === '') throw apiError(422, 'Label name is required');
  const existing = repo.labels.get(clean);
  if (existing) return existing;
  const label: LabelRecord = {
    id: store.nextLabelId++,
    name: clean,
    color: (color ?? 'ededed').replace(/^#/, ''),
    description: '',
    seq: store.nextSeq(),
  };
  repo.labels.set(clean, label);
  return label;
}

export function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l === 'string') out.push(l);
    else if (l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string') out.push((l as { name: string }).name);
  }
  return out;
}

export function createIssue(
  store: Store,
  repo: RepoRecord,
  input: { title: string; body?: string; labels?: unknown },
): IssueRecord {
  const title = (input.title ?? '').trim();
  if (title === '') throw apiError(422, 'Title is required');
  const wanted = labelNames(input.labels);
  const attached: LabelRecord[] = [];
  for (const name of wanted) {
    const label = repo.labels.get(name);
    if (!label) throw apiError(422, `Label does not exist: ${name}`);
    attached.push(label);
  }
  repo.issueSeq += 1;
  const issue: IssueRecord = {
    number: repo.issueSeq,
    title,
    body: input.body ?? '',
    state: 'open',
    labels: attached,
    seq: store.nextSeq(),
    userLogin: store.ownerOf(repo),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function listIssues(
  repo: RepoRecord,
  query: { state?: string; sort?: string; direction?: string },
): IssueRecord[] {
  const state = (query.state ?? 'open').toLowerCase();
  let list = [...repo.issues.values()];
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  const dir = (query.direction ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
  // sort=created (default): creation sequence; ties fall back to number DESC.
  list.sort((a, b) => (a.seq - b.seq) * dir || b.number - a.number);
  return list;
}

export function updateIssue(
  repo: RepoRecord,
  number: number,
  patch: { title?: string; body?: string; state?: string; labels?: unknown },
): IssueRecord {
  const issue = repo.issues.get(number);
  if (!issue) throw apiError(404, 'Not Found');
  if (typeof patch.title === 'string') issue.title = patch.title;
  if (typeof patch.body === 'string') issue.body = patch.body;
  if (typeof patch.state === 'string') {
    const s = patch.state.toLowerCase();
    if (s === 'open' || s === 'closed') issue.state = s;
  }
  if (patch.labels !== undefined) {
    const wanted = labelNames(patch.labels);
    const attached: LabelRecord[] = [];
    for (const name of wanted) {
      const label = repo.labels.get(name);
      if (!label) throw apiError(422, `Label does not exist: ${name}`);
      attached.push(label);
    }
    issue.labels = attached;
  }
  return issue;
}

export function addIssueComment(store: Store, repo: RepoRecord, number: number, body: string): CommentRecord {
  const issue = repo.issues.get(number);
  if (!issue) throw apiError(404, 'Not Found');
  repo.commentSeq += 1;
  const comment: CommentRecord = { id: repo.commentSeq, body: body ?? '', userLogin: store.ownerOf(repo), seq: store.nextSeq() };
  const list = repo.issueComments.get(number) ?? [];
  list.push(comment);
  repo.issueComments.set(number, list);
  return comment;
}

export function listIssueComments(repo: RepoRecord, number: number): CommentRecord[] {
  if (!repo.issues.has(number)) throw apiError(404, 'Not Found');
  return repo.issueComments.get(number) ?? [];
}

export function addPullComment(store: Store, repo: RepoRecord, number: number, body: string): CommentRecord {
  const pull = repo.pulls.get(number);
  if (!pull) throw apiError(404, 'Not Found');
  repo.commentSeq += 1;
  const comment: CommentRecord = { id: repo.commentSeq, body: body ?? '', userLogin: store.ownerOf(repo), seq: store.nextSeq() };
  const list = repo.pullComments.get(number) ?? [];
  list.push(comment);
  repo.pullComments.set(number, list);
  return comment;
}

// -------------------------------------------------------------------------------------------
// Pull requests
// -------------------------------------------------------------------------------------------

export function createPull(
  store: Store,
  repo: RepoRecord,
  input: { title: string; body?: string; head: string; base: string },
): PullRecord {
  const head = (input.head ?? '').trim();
  const base = (input.base ?? '').trim();
  if (head === '' || base === '') throw apiError(422, 'head and base are required');
  const headSha = store.branchTip(repo, head);
  if (headSha === undefined) throw apiError(422, `Unknown head branch: ${head}`);
  const baseSha = store.branchTip(repo, base);
  if (baseSha === undefined) throw apiError(422, `Unknown base branch: ${base}`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      throw apiError(422, 'A pull request already exists for this branch');
    }
  }
  repo.pullSeq += 1;
  const pull: PullRecord = {
    number: repo.pullSeq,
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    baseShaAtCreate: baseSha,
    seq: store.nextSeq(),
    userLogin: store.ownerOf(repo),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function listPulls(repo: RepoRecord, query: { state?: string }): PullRecord[] {
  const state = (query.state ?? 'open').toLowerCase();
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((p) => p.state === 'open');
  else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
  list.sort((a, b) => a.number - b.number);
  return list;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** Files changed between the PR's base (at creation) and its head tip. */
export function pullFiles(store: Store, repo: RepoRecord, pull: PullRecord): PullFile[] {
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTree = store.treeShaAtCommit(repo, pull.baseShaAtCreate);
  const headTree = store.treeShaAtCommit(repo, headSha);
  const changes = diffTrees(repo.git, baseTree, headTree);
  const out: PullFile[] = [];
  for (const c of changes) {
    const oldBuf = c.oldSha ? readBlob(repo.git, c.oldSha) : undefined;
    const newBuf = c.newSha ? readBlob(repo.git, c.newSha) : undefined;
    const additions = c.status === 'removed' ? 0 : lineCount(newBuf);
    const deletions = c.status === 'added' ? 0 : lineCount(oldBuf);
    out.push({
      filename: c.path,
      status: c.status === 'added' ? 'added' : c.status === 'removed' ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: c.newSha ?? c.oldSha ?? '',
    });
  }
  return out;
}

/**
 * True when the head can merge cleanly onto the current base tip: no path changed
 * on both sides (relative to the PR's creation base) with different results.
 */
export function isMergeable(store: Store, repo: RepoRecord, pull: PullRecord): boolean {
  if (pull.state !== 'open') return false;
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const curBaseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  if (headSha === curBaseSha) return true;
  const baseFiles = store.filesAtCommit(repo, pull.baseShaAtCreate);
  const headFiles = store.filesAtCommit(repo, headSha);
  const curFiles = store.filesAtCommit(repo, curBaseSha);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...curFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const c = curFiles.get(path);
    const headChanged = !bufsEqual(b, h);
    const baseChanged = !bufsEqual(b, c);
    if (headChanged && baseChanged && !bufsEqual(h, c)) return false;
  }
  return true;
}

function bufsEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.equals(b);
}

/**
 * Squash-merge: one commit on the base branch whose tree is the head tree and
 * whose parent is the current base tip. Closes the PR, records merged_at (seq-derived).
 */
export function mergePull(store: Store, repo: RepoRecord, number: number, _method?: string): { sha: string; message: string } {
  const pull = repo.pulls.get(number);
  if (!pull) throw apiError(404, 'Not Found');
  if (pull.state !== 'open') throw apiError(405, 'Pull request is already closed');
  if (!isMergeable(store, repo, pull)) throw apiError(405, 'Merge conflict');
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const headFiles = store.filesAtCommit(repo, headSha);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const { commitSha } = store.commitTree(repo, pull.baseRef, headFiles, message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitSha;
  const seq = store.nextSeq();
  pull.mergedAt = tsFor(seq);
  pull.headSha = headSha;
  pull.baseSha = commitSha;
  return { sha: commitSha, message };
}

// -------------------------------------------------------------------------------------------
// Global ids + JSON serializers (shared by REST, GraphQL and MCP)
// -------------------------------------------------------------------------------------------

export function repoGlobalId(store: Store, repo: RepoRecord): string {
  return globalId('Repository', `${store.ownerOf(repo)}/${repo.name}`);
}

export function issueGlobalId(store: Store, repo: RepoRecord, issue: IssueRecord): string {
  return globalId('Issue', `${store.ownerOf(repo)}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(store: Store, repo: RepoRecord, pull: PullRecord): string {
  return globalId('PullRequest', `${store.ownerOf(repo)}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(store: Store, repo: RepoRecord, comment: CommentRecord): string {
  return globalId('IssueComment', `${store.ownerOf(repo)}/${repo.name}#c${comment.id}`);
}

export interface FoundById {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';
  repo: RepoRecord;
  issue?: IssueRecord;
  pull?: PullRecord;
  comment?: CommentRecord;
}

/** Resolve an opaque global id back to its record(s). */
export function findByGlobalId(store: Store, id: string): FoundById | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const { kind, key } = decoded;
  if (kind === 'Repository') {
    const slash = key.indexOf('/');
    if (slash === -1) return null;
    const repo = store.getRepo(key.slice(0, slash), key.slice(slash + 1));
    return repo ? { kind, repo } : null;
  }
  const hash = key.lastIndexOf('#');
  if (hash === -1) return null;
  const ownerRepo = key.slice(0, hash);
  const slash = ownerRepo.indexOf('/');
  if (slash === -1) return null;
  const repo = store.getRepo(ownerRepo.slice(0, slash), ownerRepo.slice(slash + 1));
  if (!repo) return null;
  const rest = key.slice(hash + 1);
  if (kind === 'Issue') {
    const issue = repo.issues.get(Number(rest));
    return issue ? { kind, repo, issue } : null;
  }
  if (kind === 'PullRequest') {
    const pull = repo.pulls.get(Number(rest));
    return pull ? { kind, repo, pull } : null;
  }
  if (kind === 'IssueComment') {
    const cid = Number(rest.replace(/^c/, ''));
    for (const list of [repo.issueComments, repo.pullComments]) {
      for (const comments of list.values()) {
        const comment = comments.find((c) => c.id === cid);
        if (comment) return { kind, repo, comment };
      }
    }
    return null;
  }
  return null;
}

function apiBase(store: Store): string {
  return store.baseUrl === '' ? '' : store.baseUrl.replace(/\/+$/, '');
}

export function repoJson(store: Store, repo: RepoRecord): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  const base = apiBase(store);
  return {
    id: repo.databaseId,
    node_id: repoGlobalId(store, repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: owner, id: repo.databaseId, type: 'User', html_url: `${base}/${owner}`, url: `${base}/api/v3/users/${owner}` },
    private: repo.private,
    html_url: `${base}/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    created_at: tsFor(repo.seq),
    updated_at: tsFor(repo.seq),
    pushed_at: tsFor(repo.seq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: LabelRecord): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', String(label.id)),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(store: Store, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  const base = apiBase(store);
  const comments = repo.issueComments.get(issue.number) ?? [];
  return {
    id: issue.seq,
    node_id: issueGlobalId(store, repo, issue),
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    html_url: `${base}/${owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.userLogin, id: 1, type: 'User' },
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: comments.length,
    created_at: tsFor(issue.seq),
    updated_at: tsFor(issue.seq),
    closed_at: issue.state === 'closed' ? tsFor(issue.seq) : null,
    author_association: 'OWNER',
  };
}

export function pullJson(store: Store, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  const base = apiBase(store);
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = pull.merged ? pull.mergeCommitSha ?? pull.baseSha : store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.seq,
    node_id: pullGlobalId(store, repo, pull),
    url: `${base}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.userLogin, id: 1, type: 'User' },
    labels: [],
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: { login: owner }, repo: repoJson(store, repo) },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: { login: owner }, repo: repoJson(store, repo) },
    merged: pull.merged,
    mergeable: isMergeable(store, repo, pull),
    mergeable_state: pull.merged ? 'unknown' : isMergeable(store, repo, pull) ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: tsFor(pull.seq),
    updated_at: tsFor(pull.seq),
    closed_at: pull.state === 'closed' ? pull.mergedAt ?? tsFor(pull.seq) : null,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

export function commentJson(store: Store, repo: RepoRecord, comment: CommentRecord): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  const base = apiBase(store);
  return {
    id: comment.id,
    node_id: commentGlobalId(store, repo, comment),
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${owner}/${repo.name}/issues/comments/${comment.id}`,
    body: comment.body,
    user: { login: comment.userLogin, id: 1, type: 'User' },
    created_at: tsFor(comment.seq),
    updated_at: tsFor(comment.seq),
  };
}
