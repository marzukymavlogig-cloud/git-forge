// graphql.ts — POST /api/graphql: a hand-rolled executor for exactly the documents
// gh and github-mcp-server send (see checks-graphql.ts GRAPHQL_DOCUMENTS).
// Supports: queries/mutations, variables (string/int/input-object), inline enum
// lists and input objects, null variables, operation names, inline fragments
// (`... on Repository`), named fragments, __type introspection, and JSON-array
// batching (two results in order). Unknown field -> HTTP 200 with an errors
// array naming it; unknown repository -> data.repository null, no errors;
// unauthenticated -> exactly 401. Stdlib only; erasable-only TypeScript.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ApiError,
  addIssueComment,
  addPullComment,
  apiError,
  commentGlobalId,
  createIssue,
  createPull,
  findByGlobalId,
  globalId,
  isMergeable,
  issueGlobalId,
  listPulls,
  mergePull,
  pullFiles,
  pullGlobalId,
  repoGlobalId,
  updateIssue,
  type HandlerOpts,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { Store } from './store.ts';

export type { HandlerOpts };

export interface GraphqlHandlerCtx {
  baseUrl?: string;
  viewerLogin?: string;
  body?: string;
  parsedBody?: unknown;
}

export type GraphqlHandler = (req: IncomingMessage, res: ServerResponse, ctx?: GraphqlHandlerCtx) => boolean;

// -------------------------------------------------------------------------------------------
// Schema surface (field sets used for validation and __type introspection)
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'html_url', 'description', 'isPrivate', 'createdAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'html_url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'html_url', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'additions', 'deletions', 'changedFiles'],
  User: ['login', 'id', 'name', 'url', 'html_url'],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  User: 'OBJECT',
  Ref: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestChangedFileEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  Label: 'OBJECT',
  IssueComment: 'OBJECT',
  CommentEdge: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['CODE', 'ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// Lexer / parser (minimal GraphQL)
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or normal "...".
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const raw = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end === -1 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < n) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16) || 0);
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j] ?? '';
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(input[j] ?? '')) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(input[j] ?? '')) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(input[j] ?? '')) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: input.slice(i, j) } : { kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_A-Za-z0-9]/.test(input[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    // Unknown character: skip it rather than failing the whole document.
    i += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: { name: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'eof' };
  }
  next(): Token {
    const t = this.tokens[this.pos] ?? { kind: 'eof' };
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }
  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected "${value}"`);
  }
  acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) {
      this.next();
      return true;
    }
    return false;
  }
  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name');
    return t.value;
  }
  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push(this.parseOperation('query', null));
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const op = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        operations.push(this.parseOperation(op, name));
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName(); // 'on'
        void on;
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections });
      } else {
        // Skip an unexpected token so one stray token cannot kill the document.
        this.next();
      }
    }
    return { operations, fragments };
  }
  parseOperation(op: 'query' | 'mutation' | 'subscription', name: string | null): OperationNode {
    const variableDefinitions: { name: string; defaultValue: ValueNode | null }[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        if (this.peek().kind === 'eof') break;
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variableDefinitions.push({ name: varName, defaultValue });
        // Directives on variable definitions are not used; skip @... if present.
        while (this.acceptPunct('@')) {
          this.expectName();
          if (this.acceptPunct('(')) this.skipBalanced('(', ')');
        }
      }
    }
    // Skip operation directives (@cached etc.).
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) this.skipBalanced('(', ')');
    }
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation: op, name, variableDefinitions, selections };
  }
  skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'eof') return;
      if (t.kind === 'punct' && t.value === open) depth += 1;
      if (t.kind === 'punct' && t.value === close) depth -= 1;
    }
  }
  parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') break;
      selections.push(this.parseSelection());
    }
    return selections;
  }
  parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        // Inline fragment directives.
        while (this.acceptPunct('@')) {
          this.expectName();
          if (this.acceptPunct('(')) this.skipBalanced('(', ')');
        }
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (t.kind === 'name') {
        const name = this.next().value;
        while (this.acceptPunct('@')) {
          this.expectName();
          if (this.acceptPunct('(')) this.skipBalanced('(', ')');
        }
        return { kind: 'spread', name };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        if (this.peek().kind === 'eof') break;
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) this.skipBalanced('(', ')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }
  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) {
        if (this.peek().kind === 'eof') break;
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.acceptPunct('}')) {
        if (this.peek().kind === 'eof') break;
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected value');
  }
}

export function parseDocument(query: string): DocumentNode {
  return new Parser(lex(query)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  doc: DocumentNode;
  errors: GqlError[];
}

type ObjValue = { __type: string; [key: string]: unknown };

function isObjValue(v: unknown): v is ObjValue {
  return typeof v === 'object' && v !== null && typeof (v as ObjValue).__type === 'string';
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, variables);
  return out;
}

function argStr(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
}

function argInt(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  return typeof v === 'number' ? v : undefined;
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function cursorNum(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueValue(store: Store, repo: RepoRecord, issue: IssueRecord): ObjValue {
  return { __type: 'Issue', repo, issue, store };
}

function pullValue(store: Store, repo: RepoRecord, pull: PullRecord): ObjValue {
  return { __type: 'PullRequest', repo, pull, store };
}

function repoValue(store: Store, repo: RepoRecord): ObjValue {
  return { __type: 'Repository', repo, store };
}

function userValue(login: string): ObjValue {
  return { __type: 'User', login };
}

function connectionValue(type: string, nodes: ObjValue[], pageInfo: Record<string, unknown>, totalCount: number): ObjValue {
  return { __type: type, nodes, pageInfo, totalCount };
}

function pageInfoOf(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): Record<string, unknown> {
  return { hasNextPage, hasPreviousPage: false, startCursor, endCursor };
}

/** Issues connection: states filter, orderBy, first/after cursor paging. */
function issuesConnection(ctx: ExecCtx, repo: RepoRecord, args: Record<string, unknown>): ObjValue {
  const store = ctx.store;
  let items = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const field = orderBy?.field ?? 'CREATED_AT';
  const dir = (orderBy?.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  items.sort((a, b) => {
    let cmp = 0;
    if (field === 'COMMENTS') {
      cmp = ((repo.issueComments.get(a.number)?.length ?? 0) - (repo.issueComments.get(b.number)?.length ?? 0)) * dir;
    } else {
      cmp = (a.seq - b.seq) * dir;
    }
    // Ties break by number DESC (spec).
    return cmp !== 0 ? cmp : b.number - a.number;
  });
  const total = items.length;
  const afterNum = cursorNum(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = items.findIndex((i) => i.number === afterNum);
    start = idx === -1 ? 0 : idx + 1;
  }
  const first = argInt(args, 'first');
  const page = first === undefined ? items.slice(start) : items.slice(start, start + first);
  const hasNext = start + page.length < total;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  const startCursor = page.length > 0 ? cursorFor(page[0]?.number ?? 0) : null;
  return connectionValue(
    'IssueConnection',
    page.map((i) => issueValue(store, repo, i)),
    pageInfoOf(hasNext, endCursor, startCursor),
    total,
  );
}

function pullRequestsConnection(ctx: ExecCtx, repo: RepoRecord, args: Record<string, unknown>): ObjValue {
  const store = ctx.store;
  const items = listPulls(repo, {}).sort((a, b) => b.number - a.number);
  const total = items.length;
  const first = argInt(args, 'first');
  const page = first === undefined ? items : items.slice(0, first);
  const hasNext = page.length < total;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  const startCursor = page.length > 0 ? cursorFor(page[0]?.number ?? 0) : null;
  return connectionValue(
    'PullRequestConnection',
    page.map((p) => pullValue(store, repo, p)),
    pageInfoOf(hasNext, endCursor, startCursor),
    total,
  );
}

function filesConnection(ctx: ExecCtx, repo: RepoRecord, pull: PullRecord, args: Record<string, unknown>): ObjValue {
  const store = ctx.store;
  const files = pullFiles(store, repo, pull);
  const first = argInt(args, 'first');
  const page = first === undefined ? files : files.slice(0, first);
  const nodes: ObjValue[] = page.map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status }));
  return connectionValue('PullRequestChangedFileConnection', nodes, pageInfoOf(page.length < files.length, null, null), files.length);
}

function typeValue(name: string): ObjValue | null {
  if (!(name in FIELDS) && !(name in TYPE_KIND)) return null;
  return { __type: '__Type', typeName: name, kind: TYPE_KIND[name] ?? 'OBJECT' };
}

/** Resolve one field on an object value; returns a scalar, an ObjValue, an array, or null. */
function resolveField(ctx: ExecCtx, typeName: string, field: FieldNode, value: ObjValue): unknown {
  const store = ctx.store;
  const args = evalArgs(field, ctx.variables);
  const name = field.name;

  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name === 'viewer') return userValue(store.viewerLogin ?? '');
    if (name === '__type') {
      const t = argStr(args, 'name');
      return t ? typeValue(t) : null;
    }
    if (name === '__schema') return { __type: '__Schema' };
    if (name === 'repository') {
      const owner = argStr(args, 'owner') ?? '';
      const repoName = argStr(args, 'name') ?? '';
      if (!store.resolveOwner(owner)) return null;
      const repo = store.getRepo(owner, repoName);
      return repo ? repoValue(store, repo) : null;
    }
    if (name === 'node') {
      const id = argStr(args, 'id') ?? '';
      const found = findByGlobalId(store, id);
      if (!found) return null;
      if (found.kind === 'Repository') return repoValue(store, found.repo);
      if (found.kind === 'Issue' && found.issue) return issueValue(store, found.repo, found.issue);
      if (found.kind === 'PullRequest' && found.pull) return pullValue(store, found.repo, found.pull);
      return null;
    }
    return null;
  }

  if (typeName === 'Mutation') {
    try {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findByGlobalId(store, String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'Repository') throw apiError(404, 'Repository not found');
        const issue = createIssue(store, found.repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined });
        return { __type: 'CreateIssuePayload', issue: issueValue(store, found.repo, issue) };
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findByGlobalId(store, String(input.issueId ?? ''));
        if (!found || found.kind !== 'Issue' || !found.issue) throw apiError(404, 'Issue not found');
        const issue = updateIssue(found.repo, found.issue.number, { state: 'closed' });
        return { __type: 'CloseIssuePayload', issue: issueValue(store, found.repo, issue) };
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findByGlobalId(store, String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'Repository') throw apiError(404, 'Repository not found');
        const pull = createPull(store, found.repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : undefined,
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        return { __type: 'CreatePullRequestPayload', pullRequest: pullValue(store, found.repo, pull) };
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findByGlobalId(store, String(input.pullRequestId ?? ''));
        if (!found || found.kind !== 'PullRequest' || !found.pull) throw apiError(404, 'Pull request not found');
        mergePull(store, found.repo, found.pull.number, typeof input.mergeMethod === 'string' ? input.mergeMethod : undefined);
        return { __type: 'MergePullRequestPayload', pullRequest: pullValue(store, found.repo, found.pull) };
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findByGlobalId(store, String(input.subjectId ?? ''));
        if (!found) throw apiError(404, 'Subject not found');
        const body = String(input.body ?? '');
        if (found.kind === 'Issue' && found.issue) {
          const comment = addIssueComment(store, found.repo, found.issue.number, body);
          return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node: { __type: 'IssueComment', id: commentGlobalId(store, found.repo, comment), body: comment.body, repo: found.repo, comment } } };
        }
        if (found.kind === 'PullRequest' && found.pull) {
          const comment = addPullComment(store, found.repo, found.pull.number, body);
          return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node: { __type: 'IssueComment', id: commentGlobalId(store, found.repo, comment), body: comment.body, repo: found.repo, comment } } };
        }
        throw apiError(404, 'Subject not found');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        ctx.errors.push({ message: err.message });
        return null;
      }
      throw err;
    }
    return null;
  }

  if (typeName === 'Repository') {
    const repo = value.repo as RepoRecord;
    switch (name) {
      case 'id': return repoGlobalId(store, repo);
      case 'databaseId': return repo.databaseId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${store.ownerOf(repo)}/${repo.name}`;
      case 'owner': return userValue(store.ownerOf(repo));
      case 'defaultBranchRef': {
        const tip = store.branchTip(repo, repo.defaultBranch);
        return tip ? { __type: 'Ref', name: repo.defaultBranch } : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.private;
      case 'url': return '';
      case 'html_url': return '';
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'issue': {
        const n = argInt(args, 'number');
        if (n === undefined) return null;
        const issue = repo.issues.get(n);
        return issue ? issueValue(store, repo, issue) : null;
      }
      case 'issues': return issuesConnection(ctx, repo, args);
      case 'pullRequests': return pullRequestsConnection(ctx, repo, args);
      case 'pullRequest': {
        const n = argInt(args, 'number');
        if (n === undefined) return null;
        const pull = repo.pulls.get(n);
        return pull ? pullValue(store, repo, pull) : null;
      }
      default: return null;
    }
  }

  if (typeName === 'Issue') {
    const issue = value.issue as IssueRecord;
    const repo = value.repo as RepoRecord;
    switch (name) {
      case 'id': return issueGlobalId(store, repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'url': return '';
      case 'html_url': return '';
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'closedAt': return issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null;
      case 'author': return userValue(issue.userLogin);
      case 'labels': return { __type: 'LabelConnection', nodes: issue.labels.map((l) => ({ __type: 'Label', id: l.id, name: l.name, color: l.color, description: l.description })) };
      case 'comments': return { __type: 'IssueCommentConnection', nodes: (repo.issueComments.get(issue.number) ?? []).map((c) => ({ __type: 'IssueComment', id: commentGlobalId(store, repo, c), body: c.body, repo, comment: c })) };
      default: return null;
    }
  }

  if (typeName === 'PullRequest') {
    const pull = value.pull as PullRecord;
    const repo = value.repo as RepoRecord;
    switch (name) {
      case 'id': return pullGlobalId(store, repo, pull);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergeable': return pull.merged ? 'MERGEABLE' : isMergeable(store, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRefOid': return store.branchTip(repo, pull.headRef) ?? pull.headSha;
      case 'baseRefOid': return store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
      case 'files': return filesConnection(ctx, repo, pull, args);
      case 'url': return '';
      case 'html_url': return '';
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'mergedAt': return pull.mergedAt;
      case 'author': return userValue(pull.userLogin);
      case 'additions': return pullFiles(store, repo, pull).reduce((s, f) => s + f.additions, 0);
      case 'deletions': return pullFiles(store, repo, pull).reduce((s, f) => s + f.deletions, 0);
      case 'changedFiles': return pullFiles(store, repo, pull).length;
      default: return null;
    }
  }

  if (typeName === 'User') {
    const login = String(value.login ?? '');
    switch (name) {
      case 'login': return login;
      case 'id': return globalId('User', login);
      case 'name': return login;
      case 'url': return '';
      case 'html_url': return '';
      default: return null;
    }
  }

  if (typeName === 'Ref') return name === 'name' ? String(value.name ?? '') : null;

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') return (value.nodes as ObjValue[]) ?? [];
    if (name === 'totalCount') return (value.totalCount as number) ?? 0;
    if (name === 'pageInfo') return { __type: 'PageInfo', ...(value.pageInfo as Record<string, unknown>) };
    if (name === 'edges') {
      const nodes = (value.nodes as ObjValue[]) ?? [];
      return nodes.map((node) => ({ __type: typeName.replace('Connection', 'Edge'), node, cursor: '' }));
    }
    return null;
  }

  if (typeName === 'LabelConnection' || typeName === 'IssueCommentConnection') {
    if (name === 'nodes') return (value.nodes as ObjValue[]) ?? [];
    if (name === 'totalCount') return ((value.nodes as ObjValue[]) ?? []).length;
    return null;
  }

  if (typeName === 'PageInfo') {
    const v = value as unknown as Record<string, unknown>;
    if (name === 'hasNextPage') return v.hasNextPage === true;
    if (name === 'hasPreviousPage') return v.hasPreviousPage === true;
    if (name === 'endCursor') return (v.endCursor as string | null) ?? null;
    if (name === 'startCursor') return (v.startCursor as string | null) ?? null;
    return null;
  }

  if (typeName.endsWith('Edge')) {
    if (name === 'node') return value.node as ObjValue;
    if (name === 'cursor') return (value.cursor as string) ?? '';
    return null;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (name === 'path') return String(value.path ?? '');
    if (name === 'additions') return (value.additions as number) ?? 0;
    if (name === 'deletions') return (value.deletions as number) ?? 0;
    if (name === 'changeType') return String(value.changeType ?? 'MODIFIED').toUpperCase();
    return null;
  }

  if (typeName === 'Label') {
    if (name === 'id') return globalId('Label', String(value.id ?? ''));
    if (name === 'name') return String(value.name ?? '');
    if (name === 'color') return String(value.color ?? '');
    if (name === 'description') return String(value.description ?? '');
    return null;
  }

  if (typeName === 'IssueComment') {
    if (name === 'id') return String(value.id ?? '');
    if (name === 'body') return String(value.body ?? '');
    if (name === 'author') return userValue((value.comment as { userLogin?: string } | undefined)?.userLogin ?? '');
    if (name === 'createdAt' || name === 'updatedAt') return '2025-01-01T00:00:00Z';
    if (name === 'url') return '';
    return null;
  }

  if (typeName === 'CommentEdge') {
    if (name === 'node') return value.node as ObjValue;
    if (name === 'cursor') return '';
    return null;
  }

  if (typeName === '__Type') {
    const tname = String(value.typeName ?? '');
    if (name === 'name') return tname;
    if (name === 'kind') return String(value.kind ?? 'OBJECT');
    if (name === 'description') return null;
    if (name === 'fields') {
      return (FIELDS[tname] ?? []).map((f) => ({ __type: '__Field', name: f }));
    }
    if (name === 'enumValues') {
      return (ENUM_VALUES[tname] ?? []).map((e) => ({ __type: '__EnumValue', name: e }));
    }
    if (name === 'possibleTypes') return [];
    return null;
  }

  if (typeName === '__Field') {
    if (name === 'name') return String(value.name ?? '');
    if (name === 'description') return null;
    if (name === 'args') return [];
    if (name === 'type') return { __type: '__Type', typeName: 'String', kind: 'SCALAR' };
    return null;
  }

  if (typeName === '__EnumValue') {
    if (name === 'name') return String(value.name ?? '');
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    return null;
  }

  if (typeName === '__Schema') {
    if (name === 'types') return Object.keys({ ...FIELDS, ...TYPE_KIND }).map((t) => typeValue(t)).filter((t): t is ObjValue => t !== null);
    if (name === 'queryType') return typeValue('Query');
    if (name === 'mutationType') return typeValue('Mutation');
    if (name === 'description') return null;
    return null;
  }

  // Payload types: issue / pullRequest / commentEdge pass through.
  if (typeName.endsWith('Payload')) {
    if (name === 'issue' || name === 'pullRequest' || name === 'commentEdge') return (value as Record<string, unknown>)[name] ?? null;
    if (name === 'clientMutationId') return null;
    return null;
  }

  return null;
}

function knownField(typeName: string, fieldName: string): boolean {
  if (fieldName === '__typename') return true;
  const fields = FIELDS[typeName];
  return fields !== undefined && fields.includes(fieldName);
}

/** Execute a selection set on an object value of `typeName`. */
function executeSelections(ctx: ExecCtx, typeName: string, value: ObjValue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.doc.fragments.get(sel.name);
      if (frag) Object.assign(out, executeSelections(ctx, typeName, value, frag.selections));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        Object.assign(out, executeSelections(ctx, typeName, value, sel.selections));
      }
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    if (!knownField(typeName, sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    let raw: unknown;
    try {
      raw = resolveField(ctx, typeName, sel, value);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'Internal error' });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, typeName, sel, raw);
  }
  return out;
}

/** Shape a resolved raw value against the field's sub-selections (if any). */
function completeValue(ctx: ExecCtx, _parentType: string, field: FieldNode, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (field.selections === null) return raw;
  if (isObjValue(raw)) return executeSelections(ctx, raw.__type, raw, field.selections);
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (isObjValue(item)) return executeSelections(ctx, item.__type, item, field.selections as SelectionNode[]);
      return item;
    });
  }
  return raw;
}

function executeOperation(store: Store, doc: DocumentNode, op: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: GqlError[] } {
  const ctx: ExecCtx = { store, variables, doc, errors: [] };
  // Apply variable defaults for missing variables.
  for (const def of op.variableDefinitions) {
    if (ctx.variables[def.name] === undefined && def.defaultValue !== null) {
      ctx.variables[def.name] = evalValue(def.defaultValue, ctx.variables);
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: ObjValue = { __type: rootType };
  const data = executeSelections(ctx, rootType, root, op.selections);
  return { data, errors: ctx.errors };
}

export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors: GqlError[] } {
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  if (doc.operations.length === 0) return { data: null, errors: [{ message: 'No operation provided' }] };
  let op: OperationNode | undefined;
  if (operationName) op = doc.operations.find((o) => o.name === operationName);
  else op = doc.operations[0];
  if (!op) return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
  return executeOperation(store, doc, op, { ...variables });
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

export function createGraphqlHandler(store: Store, opts: HandlerOpts = {}): GraphqlHandler {
  void opts;
  let requestCounter = 0;

  function send(res: ServerResponse, status: number, body: unknown): void {
    requestCounter += 1;
    const text = `${JSON.stringify(body ?? {})}\n`;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `req-gql-${requestCounter}`,
      'content-length': String(Buffer.byteLength(text)),
    });
    res.end(text);
  }

  function readBody(req: IncomingMessage, ctx: GraphqlHandlerCtx | undefined): Promise<string> {
    if (ctx?.body !== undefined) return Promise.resolve(ctx.body);
    if (ctx?.parsedBody !== undefined) return Promise.resolve(JSON.stringify(ctx.parsedBody));
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, ctx: GraphqlHandlerCtx | undefined): Promise<void> {
    if (!store.isAuthenticated(req.headers.authorization)) {
      send(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (ctx?.viewerLogin) store.learnViewer(ctx.viewerLogin);
    const raw = await readBody(req, ctx);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      // Batched operations: one result per operation, in order.
      const results = parsed.map((entry) => runOne(entry));
      send(res, 200, results);
      return;
    }
    send(res, 200, runOne(parsed));
  }

  function runOne(entry: unknown): { data: Record<string, unknown> | null; errors?: GqlError[] } {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
    const rec = entry as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = (rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables) ? rec.variables : {}) as Record<string, unknown>;
    const operationName = typeof rec.operationName === 'string' ? rec.operationName : undefined;
    const result = executeGraphQL(store, query, variables, operationName);
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  }

  return (req: IncomingMessage, res: ServerResponse, ctx?: GraphqlHandlerCtx): boolean => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      pathname = '/';
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'POST' || pathname !== '/api/graphql') return false;
    void handle(req, res, ctx).catch(() => {
      try {
        if (!res.headersSent) send(res, 500, { errors: [{ message: 'Internal Server Error' }] });
        else res.end();
      } catch {
        // Socket gone.
      }
    });
    return true;
  };
}
