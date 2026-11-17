// gitproto.ts — smart-HTTP git protocol (v2 + v0) over a GitRepo.
//
// Fresh code, stdlib only. Speaks pkt-line framing and side-band-64k, serves
// info/refs advertisements, v2 ls-refs / fetch (with shallow support) and
// v0 fetch, and v0 receive-pack with per-ref fast-forward enforcement and
// report-status. No timestamps anywhere in stored state.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GitRepo,
  ZERO_OID,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
} from './git.ts';

export type { GitRepo } from './git.ts';

const AGENT = 'makefun-git/1.0';
const PKT_LINE_MAX = 65520;
/** Bytes of pack data per sideband pkt-line (4 header + 1 band + data). */
const SIDEBAND_CHUNK = 32768;

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a whole buffer of pkt-lines. Throws on a malformed header or truncation. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error(`truncated pkt-line: ${bytes.length - offset} trailing byte(s)`);
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error(`truncated pkt-line: ${length} announced, ${bytes.length - offset} available`);
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Decode pkt-lines up to (and excluding) the first flush; returns the packets
 * before it and the raw bytes after it (the packfile in a receive-pack body).
 */
export function splitAtFlush(bytes: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error(`truncated pkt-line: ${bytes.length - offset} trailing byte(s)`);
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) return { packets, rest: bytes.subarray(offset + 4) };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error(`truncated pkt-line: ${length} announced, ${bytes.length - offset} available`);
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('pkt-line stream has no flush');
}

/** Wrap bytes as sideband band-`band` pkt-lines. */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; at += SIDEBAND_CHUNK) {
    const chunk = data.subarray(at, Math.min(at + SIDEBAND_CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

/** Wrap already pkt-lined bytes (e.g. a report) as sideband band-1 packets. */
export function sidebandWrapPktLines(inner: Buffer): Buffer[] {
  return sidebandPackets(inner, 1);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function peeledOid(repo: GitRepo, oid: string): string | undefined {
  const object = repo.getObject(oid);
  if (!object || object.type !== 'tag') return undefined;
  try {
    return repo.peel(oid);
  } catch {
    return undefined;
  }
}

/** v0 ref advertisement, with the "# service=..." preamble. */
export function buildV0Advertisement(repo: GitRepo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT} symref=HEAD:${repo.headTarget}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${repo.headTarget}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = repo.listRefs();
  const headOid = repo.headOid();
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 capability advertisement, with the "# service=..." preamble. */
export function buildV2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: readonly PktPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    // agent= / object-format= and anything else before the delim are ignored.
  }
  return args;
}

export function handleLsRefs(repo: GitRepo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const first = packets.find((p) => p.kind === 'data');
  if (!first || first.kind !== 'data' || !first.payload.toString('utf8').startsWith('command=ls-refs')) {
    throw new Error('ls-refs request has no command=ls-refs line');
  }
  const args = parseLsRefsArgs(packets);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (keep('HEAD')) {
    const headOid = repo.headOid();
    const attrs = args.symrefs ? ` symref-target:${repo.headTarget}` : '';
    if (headOid === ZERO_OID) {
      if (args.unborn) lines.push(`unborn HEAD${attrs}\n`);
    } else {
      lines.push(`${headOid} HEAD${attrs}\n`);
    }
  }
  for (const ref of repo.listRefs()) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== undefined && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send. */
  readonly objects: Set<string>;
  /** New shallow boundary commits (depth fetches only). */
  readonly shallow: string[];
  /** Previous shallow boundary commits that are no longer shallow. */
  readonly unshallow: string[];
  /** A wanted oid the repo does not hold. */
  readonly missingWant: string | null;
}

/**
 * Objects a client holding `haves` already has. Commits in `cut` are shallow
 * boundaries on the client: the client holds the boundary commit and its
 * tree, but NOT its parents — so the walk stops there instead of following
 * the full ancestry (that is what makes deepen work: `have <tip>` plus
 * `shallow <tip>` must not hide the tip's parent from the server).
 */
function collectHaves(repo: GitRepo, haves: readonly string[], cut: readonly string[]): Set<string> {
  const cutSet = new Set(cut);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of haves) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.getObject(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!cutSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

export function planFetch(
  repo: GitRepo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  for (const want of wants) {
    if (!repo.hasObject(want)) return { objects: new Set(), shallow: [], unshallow: [], missingWant: want };
  }
  const haveSet = collectHaves(repo, haves, shallowBoundaries);
  if (depth !== null) {
    const walked = repo.collectShallow(wants, depth);
    const objects = new Set<string>();
    for (const oid of walked.objects) if (!haveSet.has(oid)) objects.add(oid);
    const unshallow = shallowBoundaries.filter(
      (oid) => walked.objects.has(oid) && !walked.boundary.includes(oid),
    );
    return { objects, shallow: walked.boundary, unshallow, missingWant: null };
  }
  const wanted = repo.collectReachable(wants, { allowMissing: true });
  const objects = new Set<string>();
  for (const oid of wanted) if (!haveSet.has(oid)) objects.add(oid);
  return { objects, shallow: [], unshallow: [], missingWant: null };
}

/** ACK lines for haves that are ancestors of (or equal to) a want; else NAK. */
function ackLines(repo: GitRepo, wants: readonly string[], haves: readonly string[]): string[] {
  const acks: string[] = [];
  for (const have of haves) {
    if (wants.some((want) => repo.isAncestor(have, want))) acks.push(`ACK ${have}\n`);
  }
  return acks.length ? acks : ['NAK\n'];
}

// ---------------------------------------------------------------------------------------------
// fetch (v2)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(packets: readonly PktPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done, deepen-since,
    // deepen-not: accepted and ignored (filter/deepen-since are not used
    // by the checks; a full unfiltered pack is always correct for them).
  }
  return args;
}

export function handleFetchV2(repo: GitRepo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const first = packets.find((p) => p.kind === 'data');
  if (!first || first.kind !== 'data' || !first.payload.toString('utf8').startsWith('command=fetch')) {
    throw new Error('fetch request has no command=fetch line');
  }
  const args = parseFetchArgs(packets);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  for (const line of ackLines(repo, args.wants, args.haves)) parts.push(pktLine(line));
  parts.push(pktDelim());
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.missingWant !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(Buffer.from(`ERR want ${plan.missingWant} not found\n`, 'utf8'), 3));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (plan.objects.size > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(repo.packObjects(plan.objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch (v0)
// ---------------------------------------------------------------------------------------------

function parseV0FetchArgs(packets: readonly PktPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      args.wants.push(rest.split(' ')[0]);
    } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

export function handleFetchV0(repo: GitRepo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const args = parseV0FetchArgs(packets);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const line of ackLines(repo, args.wants, args.haves)) parts.push(pktLine(line));
  if (args.depth !== null || args.shallow.length > 0) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  if (plan.missingWant !== null) {
    parts.push(...sidebandPackets(Buffer.from(`ERR want ${plan.missingWant} not found\n`, 'utf8'), 3));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (plan.objects.size > 0) parts.push(...sidebandPackets(repo.packObjects(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; caps: Set<string>; pack: Buffer } {
  const { packets, rest } = splitAtFlush(body);
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      for (const token of line.slice(nul + 1).split(' ')) if (token) caps.add(token);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');
  return { commands, caps, pack: rest };
}

export function handleReceivePack(repo: GitRepo, body: Buffer): Buffer {
  const { commands, caps, pack } = parsePushCommands(body);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (pack.length > 0) {
    try {
      repo.applyPack(pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = String((err as Error).message ?? err).replace(/[\r\n]+/g, ' ').slice(0, 120);
    }
  } else if (needsPack) {
    unpackOk = false;
    unpackDetail = 'missing packfile';
  }
  report.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = repo.getRef(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) report.push(`ng ${command.ref} no such ref\n`);
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} old ref does not match\n`);
      } else {
        repo.deleteRef(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.hasObject(command.newOid)) {
      report.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) report.push(`ng ${command.ref} already exists\n`);
      else {
        repo.setRef(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (command.oldOid === command.newOid && current === command.oldOid) {
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (current === undefined || current !== command.oldOid) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!repo.isAncestor(command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.setRef(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }
  const inner = Buffer.concat(report.map((line) => pktLine(line)));
  const body_out = caps.has('side-band-64k')
    ? Buffer.concat([...sidebandWrapPktLines(inner), pktFlush()])
    : Buffer.concat([inner, pktFlush()]);
  return body_out;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing + handler
// ---------------------------------------------------------------------------------------------

export type GitRepoResolver = (owner: string, repo: string) => GitRepo | null;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

async function handleGitRequest(
  resolve: GitRepoResolver,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  search: URLSearchParams,
): Promise<void> {
  const repo = resolve(owner, repoName);
  if (repo === null) {
    sendText(res, 404, 'repository not found\n');
    return;
  }
  try {
    if (sub === '/info/refs') {
      if (req.method !== 'GET') {
        sendText(res, 405, 'method not allowed\n');
        return;
      }
      const service = search.get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        send(
          res,
          200,
          'application/x-git-upload-pack-advertisement',
          v2 ? buildV2Advertisement() : buildV0Advertisement(repo, 'git-upload-pack'),
        );
        return;
      }
      if (service === 'git-receive-pack') {
        send(res, 200, 'application/x-git-receive-pack-advertisement', buildV0Advertisement(repo, 'git-receive-pack'));
        return;
      }
      sendText(res, 400, 'unknown service\n');
      return;
    }
    if (sub === '/git-upload-pack') {
      if (req.method !== 'POST') {
        sendText(res, 405, 'method not allowed\n');
        return;
      }
      const body = await readBody(req);
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      let out: Buffer;
      if (v2) {
        const first = decodePktLines(body).find((p) => p.kind === 'data');
        const command = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
        out = command.startsWith('command=ls-refs') ? handleLsRefs(repo, body) : handleFetchV2(repo, body);
      } else {
        out = handleFetchV0(repo, body);
      }
      send(res, 200, 'application/x-git-upload-pack-result', out);
      return;
    }
    if (sub === '/git-receive-pack') {
      if (req.method !== 'POST') {
        sendText(res, 405, 'method not allowed\n');
        return;
      }
      const body = await readBody(req);
      send(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, body));
      return;
    }
    sendText(res, 404, 'not found\n');
  } catch (err) {
    // A malformed pkt-line or pack must never take the server down: answer
    // 400 and keep serving. Anything else is a 500, same guarantee.
    const message = (err as Error).message ?? 'bad request';
    if (/pkt-line|pack|command|flush|delta|zlib|truncated|invalid/i.test(message)) {
      sendText(res, 400, `bad request: ${message}\n`);
    } else {
      sendText(res, 500, `internal error: ${message}\n`);
    }
  }
}

/**
 * Build the smart-HTTP handler. `resolve` maps (owner, repo) to the repo's
 * GitRepo, or null when no such repository exists (answered 404). Returns
 * true when the request is a git smart-HTTP request this handler owns
 * (handled, possibly asynchronously), false otherwise so another handler
 * (e.g. the REST surface) can take it.
 */
export function createGitHandler(
  resolve: GitRepoResolver,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return false;
    }
    const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
    if (!match) return false;
    const sub = match[3] ?? '';
    if (sub !== '/info/refs' && sub !== '/git-upload-pack' && sub !== '/git-receive-pack') return false;
    let owner: string;
    let repoName: string;
    try {
      owner = decodeURIComponent(match[1]);
      repoName = decodeURIComponent(match[2]);
    } catch {
      return false;
    }
    void handleGitRequest(resolve, req, res, owner, repoName, sub, url.searchParams).catch(() => {
      try {
        sendText(res, 500, 'internal error\n');
      } catch {
        // res already gone; nothing to do.
      }
    });
    return true;
  };
}
