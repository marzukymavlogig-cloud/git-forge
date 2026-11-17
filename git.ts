// git.ts — pure in-memory git object store (fresh code, stdlib only).
//
// SHA-1 object ids over "<type> <len>\0" + payload, zlib loose encoding,
// packfile v2 encode/decode (REF_DELTA + OFS_DELTA, thin packs via a base
// lookup), and pack idx v2 generation. No timestamps, no I/O, no git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = asBuffer(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

// ---------------------------------------------------------------------------------------------
// object parsing / building
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// delta codec (git's copy/insert instruction stream)
// ---------------------------------------------------------------------------------------------

function readDeltaSize(delta: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= delta.length) throw new Error('delta size varint is truncated');
    const byte = delta[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 63) throw new Error('delta size varint is too long');
  }
  return { value, next: pos };
}

function writeDeltaSize(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  const source = readDeltaSize(deltaBuffer, 0);
  const target = readDeltaSize(deltaBuffer, source.next);
  if (source.value !== baseBuffer.length) {
    throw new Error(`delta expects a ${source.value}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  let offset = target.next;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** (bit * 8);
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * 2 ** (bit * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > target.value) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > target.value) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new Error(`delta produced ${written} of ${target.value} bytes`);
  return out;
}

function emitCopy(ops: Buffer[], offset: number, size: number): void {
  let remaining = size;
  let at = offset;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 0x10000);
    let opcode = 0x80;
    const bytes: number[] = [];
    for (let bit = 0; bit < 4; bit += 1) {
      const byte = (at >> (bit * 8)) & 0xff;
      if (byte !== 0) {
        opcode |= 1 << bit;
        bytes.push(byte);
      }
    }
    if (chunk !== 0x10000) {
      for (let bit = 0; bit < 3; bit += 1) {
        const byte = (chunk >> (bit * 8)) & 0xff;
        if (byte !== 0) {
          opcode |= 0x10 << bit;
          bytes.push(byte);
        }
      }
    }
    ops.push(Buffer.concat([Buffer.from([opcode]), Buffer.from(bytes)]));
    at += chunk;
    remaining -= chunk;
  }
}

/**
 * Build a delta from `base` to `target`: longest common prefix, longest common
 * suffix, the middle inserted literally. Returns null when the delta would not
 * be smaller than the target itself (caller falls back to a plain object).
 */
export function createDelta(base: Uint8Array, target: Uint8Array): Buffer | null {
  const baseBuffer = asBuffer(base);
  const targetBuffer = asBuffer(target);
  let prefix = 0;
  const maxPrefix = Math.min(baseBuffer.length, targetBuffer.length);
  while (prefix < maxPrefix && baseBuffer[prefix] === targetBuffer[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(baseBuffer.length - prefix, targetBuffer.length - prefix);
  while (
    suffix < maxSuffix &&
    baseBuffer[baseBuffer.length - 1 - suffix] === targetBuffer[targetBuffer.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const ops: Buffer[] = [];
  if (prefix > 0) emitCopy(ops, 0, prefix);
  const middleStart = prefix;
  const middleEnd = targetBuffer.length - suffix;
  for (let at = middleStart; at < middleEnd; at += 127) {
    const chunk = targetBuffer.subarray(at, Math.min(at + 127, middleEnd));
    ops.push(Buffer.concat([Buffer.from([chunk.length]), chunk]));
  }
  if (suffix > 0) emitCopy(ops, baseBuffer.length - suffix, suffix);
  const delta = Buffer.concat([writeDeltaSize(baseBuffer.length), writeDeltaSize(targetBuffer.length), ...ops]);
  if (delta.length >= targetBuffer.length) return null;
  return delta;
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

export interface PackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly size: number;
  readonly data: Buffer;
  readonly oid: string;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
  /** The raw zlib bytes of this entry as stored in the pack (for idx CRC32). */
  readonly zlibData: Buffer;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly trailer: string;
  readonly computedTrailer: string;
  readonly checksumOk: boolean;
  readonly deltaCount: number;
  readonly byteLength: number;
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** Decode git's OFS_DELTA base-offset varint (the +1-per-byte form). */
export function decodeOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Encode a distance for OFS_DELTA (inverse of decodeOfsDeltaBase). */
export function encodeOfsDeltaBase(distance: number): Buffer {
  if (distance <= 0) throw new Error('ofs-delta distance must be positive');
  const bytes: number[] = [distance & 0x7f];
  let rest = distance >> 7;
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest & 0x7f));
    rest >>= 7;
  }
  return Buffer.from(bytes);
}

function writePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past it. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function packChecksum(pack: Uint8Array): string {
  const buffer = asBuffer(pack);
  if (buffer.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = asBuffer(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. `resolveBase` supplies a base a thin pack leaves out. Every
 * object's SHA-1 is recomputed and its declared size checked.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    zlibData: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0), zlibData: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = decodeOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    entry.zlibData = buffer.subarray(offset, inflated.next);
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      zlibData: entry.zlibData,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid! }
            : null,
    });
  }
  return {
    version,
    declaredCount,
    objects,
    entries,
    trailer,
    computedTrailer,
    checksumOk: trailer === computedTrailer,
    deltaCount,
    byteLength: buffer.length,
  };
}

export interface PackObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

/**
 * Build a packfile v2. Objects are emitted plain by default; with
 * `deltas: true` an object is stored as an OFS_DELTA against a recent
 * same-type object already in the pack when the delta's deflated form is
 * smaller than the plain deflated form. Bases always precede their deltas,
 * so the pack is self-contained (never thin). Trailer is SHA-1 over the rest.
 */
export function writePack(objects: Iterable<PackObjectInput>, options: { deltas?: boolean } = {}): Buffer {
  const seen = new Set<string>();
  const list: Array<{ type: GitObjectType; data: Buffer; oid: string }> = [];
  for (const object of objects) {
    const data = asBuffer(object.data);
    const oid = hashObject(object.type, data);
    if (seen.has(oid)) continue;
    seen.add(oid);
    list.push({ type: object.type, data, oid });
  }
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  let bodyLength = 12;
  // Offsets of already-emitted objects, for OFS_DELTA bases.
  const emitted: Array<{ oid: string; type: GitObjectType; data: Buffer; offset: number }> = [];
  for (const object of list) {
    const entryOffset = bodyLength;
    let emittedDelta = false;
    if (options.deltas) {
      const plainDeflated = deflateSync(object.data);
      // Candidate bases: the most recent same-type objects already emitted.
      const candidates = emitted.filter((e) => e.type === object.type).slice(-4);
      for (const base of candidates) {
        const delta = createDelta(base.data, object.data);
        if (!delta) continue;
        const deltaDeflated = deflateSync(delta);
        if (deltaDeflated.length >= plainDeflated.length) continue;
        const head = Buffer.concat([
          writePackObjectHeader(6, delta.length),
          encodeOfsDeltaBase(entryOffset - base.offset),
        ]);
        const entry = Buffer.concat([head, deltaDeflated]);
        parts.push(entry);
        bodyLength += entry.length;
        emittedDelta = true;
        break;
      }
      if (!emittedDelta) {
        const entry = Buffer.concat([writePackObjectHeader(TYPE_CODE[object.type], object.data.length), plainDeflated]);
        parts.push(entry);
        bodyLength += entry.length;
      }
    } else {
      const entry = Buffer.concat([
        writePackObjectHeader(TYPE_CODE[object.type], object.data.length),
        deflateSync(object.data),
      ]);
      parts.push(entry);
      bodyLength += entry.length;
    }
    emitted.push({ oid: object.oid, type: object.type, data: object.data, offset: entryOffset });
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// CRC32 + pack idx v2
// ---------------------------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a pack idx v2 for `pack` (magic \xfftOc, version 2, fanout, sorted
 * SHA-1s, CRC32s of the stored zlib streams, 32-bit offsets, pack trailer).
 */
export function buildIdxV2(pack: Uint8Array): Buffer {
  const parsed = readPack(pack);
  const sorted = [...parsed.entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const fanout = new Uint32Array(256);
  for (const entry of sorted) fanout[Number.parseInt(entry.oid.slice(0, 2), 16)] += 1;
  for (let i = 1; i < 256; i += 1) fanout[i] += fanout[i - 1];
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(0xff744f63, 0);
  head.writeUInt32BE(2, 4);
  parts.push(head);
  const fanoutBuf = Buffer.allocUnsafe(256 * 4);
  for (let i = 0; i < 256; i += 1) fanoutBuf.writeUInt32BE(fanout[i], i * 4);
  parts.push(fanoutBuf);
  const shaBuf = Buffer.allocUnsafe(sorted.length * 20);
  sorted.forEach((entry, i) => Buffer.from(entry.oid, 'hex').copy(shaBuf, i * 20));
  parts.push(shaBuf);
  const crcBuf = Buffer.allocUnsafe(sorted.length * 4);
  sorted.forEach((entry, i) => crcBuf.writeUInt32BE(crc32(entry.zlibData), i * 4));
  parts.push(crcBuf);
  const offBuf = Buffer.allocUnsafe(sorted.length * 4);
  sorted.forEach((entry, i) => offBuf.writeUInt32BE(entry.offset, i * 4));
  parts.push(offBuf);
  parts.push(Buffer.from(parsed.trailer, 'hex'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// GitRepo — in-memory object store + refs
// ---------------------------------------------------------------------------------------------

/** Result of a depth-limited reachability walk. */
export interface ShallowCollect {
  /** Every object to send (commits, their trees/blobs, tags). */
  readonly objects: Set<string>;
  /** Commits whose parents were cut off by the depth limit. */
  readonly boundary: string[];
}

export class GitRepo {
  /** oid -> object (always stored resolved, never deltified). */
  readonly objects = new Map<string, GitObject>();
  /** Full refname -> oid. */
  readonly refs = new Map<string, string>();
  /** Symref target of HEAD (default branch). */
  headTarget = 'refs/heads/main';

  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
  }

  deleteRef(name: string): boolean {
    return this.refs.delete(name);
  }

  /** Refs sorted by name: [{ name, oid }]. */
  listRefs(): Array<{ name: string; oid: string }> {
    return [...this.refs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, oid]) => ({ name, oid }));
  }

  /** The oid HEAD resolves to, or ZERO_OID when the default branch is unborn. */
  headOid(): string {
    return this.refs.get(this.headTarget) ?? ZERO_OID;
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store one object; returns its oid. */
  putObject(type: GitObjectType, data: Uint8Array): string {
    const body = asBuffer(data);
    const oid = hashObject(type, body);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: body });
    return oid;
  }

  putObjects(objects: Iterable<GitObject>): void {
    for (const object of objects) this.putObject(object.type, object.data);
  }

  /**
   * Decode a pack (full or thin: REF_DELTA bases may live in this repo) and
   * store every resolved object. Returns the stored objects by oid.
   * Throws on a corrupt pack; stores nothing in that case.
   */
  applyPack(pack: Uint8Array): Map<string, GitObject> {
    const parsed = readPack(pack, { resolveBase: (oid) => this.objects.get(oid) });
    this.putObjects(parsed.objects.values());
    return parsed.objects;
  }

  /** Follow annotated tags to the first non-tag object (or the oid itself). */
  peel(oid: string): string {
    let current = oid;
    const guard = new Set<string>();
    for (;;) {
      if (guard.has(current)) return current;
      guard.add(current);
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      try {
        current = parseTag(object.data).object;
      } catch {
        return current;
      }
    }
  }

  /**
   * True when `ancestor` is reachable from `descendant` (or they are equal).
   * Tags are peeled first. Missing objects mean "not an ancestor".
   */
  isAncestor(ancestor: string, descendant: string): boolean {
    const a = this.peel(ancestor);
    let b = this.peel(descendant);
    if (a === b) return true;
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === a) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        try {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        } catch {
          continue;
        }
      } else if (object.type === 'tag') {
        try {
          queue.push(parseTag(object.data).object);
        } catch {
          continue;
        }
      }
    }
    return false;
  }

  /**
   * Every object reachable from `roots`: commit -> tree + parents,
   * tree -> entries (gitlinks skipped), tag -> its target. Missing roots are
   * skipped when `allowMissing` is set, otherwise they throw.
   */
  collectReachable(roots: Iterable<string>, options: { allowMissing?: boolean } = {}): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) {
        if (options.allowMissing) continue;
        throw new Error(`object ${oid} is missing from the store`);
      }
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
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

  /**
   * Depth-limited reachability for shallow fetch/clone. `depth` counts commit
   * generations from the roots (depth 1 = the root commits only). Trees and
   * blobs of every included commit are included; a tag root contributes its
   * tag object plus its target at the same generation. `boundary` lists the
   * included commits that still have parents outside the set.
   */
  collectShallow(roots: Iterable<string>, depth: number): ShallowCollect {
    const objects = new Set<string>();
    const boundary: string[] = [];
    const commitGen = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const root of roots) {
      if (isObjectId(root) && root !== ZERO_OID) queue.push({ oid: root, gen: 0 });
    }
    const addTree = (treeOid: string): void => {
      const stack: string[] = [treeOid];
      while (stack.length) {
        const oid = stack.pop()!;
        if (objects.has(oid)) continue;
        const object = this.objects.get(oid);
        if (!object) continue;
        objects.add(oid);
        if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) {
            if (entry.mode !== '160000') stack.push(entry.oid);
          }
        }
      }
    };
    const seenCommit = new Set<string>();
    while (queue.length) {
      const { oid, gen } = queue.shift()!;
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        if (!objects.has(oid)) objects.add(oid);
        queue.push({ oid: parseTag(object.data).object, gen });
        continue;
      }
      if (object.type !== 'commit') {
        objects.add(oid);
        if (object.type === 'tree') addTree(oid);
        continue;
      }
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      commitGen.set(oid, gen);
      objects.add(oid);
      const commit = parseCommit(object.data);
      addTree(commit.tree);
      if (gen + 1 < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
    for (const [oid, gen] of commitGen) {
      if (gen !== depth - 1) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !commitGen.has(parent))) boundary.push(oid);
    }
    return { objects, boundary };
  }

  /** Build a self-contained pack (with delta compression) for these oids. */
  packObjects(oids: Iterable<string>, options: { deltas?: boolean } = {}): Buffer {
    const inputs: PackObjectInput[] = [];
    for (const oid of oids) {
      const object = this.objects.get(oid);
      if (object) inputs.push({ type: object.type, data: object.data });
    }
    return writePack(inputs, { deltas: options.deltas ?? true });
  }
}
