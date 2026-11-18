// git.ts — git smart-HTTP protocol: pkt-line codec, packfile read/write
// (full objects only, no deltas on the wire; OFS/REF deltas resolved on
// ingest), upload-pack v2 + v0, receive-pack v0. Node stdlib only.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AGENT, ZERO, parseCommit, parseTag, parseTree, reachableCommits, depthClosure, isAncestor, sha1Of } from './store.ts';
import type { ObjType, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function pktLineString(payload: string): Buffer {
  return pktLine(payload + '\n');
}

export interface ParsedPktLines {
  lines: string[];
  sections: string[][];
  // Number of raw bytes consumed from the input buffer.
  consumed: number;
}

// Parse pkt-lines until the first flush packet. Returns the lines and how
// many bytes were consumed. Throws on malformed input.
export function parsePktLines(buf: Buffer, start = 0): { lines: string[]; next: number } {
  const lines: string[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') return { lines, next: i + 4 };
    if (hex === '0001') {
      // Delimiter inside a section — treat as a section boundary marker.
      lines.push('\u0001');
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) {
      throw new Error(`malformed pkt-line at offset ${i}: ${JSON.stringify(hex)}`);
    }
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  throw new Error('pkt-line stream ended without flush');
}

// Parse a v2-style request body into sections split by delim/flush.
export function parseSections(buf: Buffer): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      sections.push(current);
      return sections;
    }
    if (hex === '0001') {
      sections.push(current);
      current = [];
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) {
      throw new Error('malformed pkt-line in section parse');
    }
    current.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// Packfile read/write
// ---------------------------------------------------------------------------

export interface PackEntry {
  type: ObjType;
  data: Buffer;
}

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(entries: { oid: string; type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const e of entries) {
    const compressed = deflateSync(e.data);
    // type/size varint: first byte holds type (3 bits) + 4 low size bits.
    const size = e.data.length;
    const typeNum = TYPE_NUM[e.type];
    const bytes: number[] = [];
    let b = (typeNum << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest) b |= 0x80;
    bytes.push(b);
    while (rest) {
      let nb = rest & 0x7f;
      rest >>= 7;
      if (rest) nb |= 0x80;
      bytes.push(nb);
    }
    parts.push(Buffer.from(bytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const hash = createHash('sha1');
  hash.update(body);
  const trailer = hash.digest();
  return Buffer.concat([body, trailer]);
}

export interface ReadPackResult {
  entries: PackEntry[];
  oids: string[];
}

// Read a packfile, resolving OFS (6) and REF (7) deltas against pack bases
// and objects already in the repo. Returns entries in pack order.
export function readPack(buf: Buffer, repo: Repo): ReadPackResult {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a PACK file');
  }
  const count = buf.readUInt32BE(8);
  let off = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  // First pass: read raw entries.
  interface RawEntry {
    offset: number;
    typeNum: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  for (let n = 0; n < count; n++) {
    const start = off;
    let byte = buf[off++];
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      // OFS delta: negative offset varint.
      let b = buf[off++];
      let base = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++];
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - base;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateSync(buf.subarray(off));
    const consumed = compressedLength(buf.subarray(off));
    off += consumed;
    if (inflated.length !== size) {
      // Tolerate size mismatches from exotic encodings; trust the data.
    }
    raw.push({ offset: start, typeNum, data: inflated, baseOffset, baseOid });
  }
  // Resolve entries in order (deltas reference earlier offsets or repo objects).
  const resolve = (r: RawEntry): PackEntry => {
    if (r.typeNum === 6 || r.typeNum === 7) {
      let base: PackEntry | undefined;
      if (r.baseOffset !== undefined) base = byOffset.get(r.baseOffset);
      else if (r.baseOid !== undefined) {
        base = byOid.get(r.baseOid) ?? (() => {
          const obj = repo.getObject(r.baseOid!);
          return obj ? { type: obj.type, data: obj.data } : undefined;
        })();
      }
      if (!base) throw new Error('delta base not found');
      return { type: base.type, data: applyDelta(base.data, r.data) };
    }
    const type = NUM_TYPE[r.typeNum];
    if (!type) throw new Error(`unknown pack object type ${r.typeNum}`);
    return { type, data: r.data };
  };
  for (const r of raw) {
    const entry = resolve(r);
    byOffset.set(r.offset, entry);
    const oid = sha1Of(entry.type, entry.data);
    byOid.set(oid, entry);
    entries.push(entry);
  }
  const oids = entries.map((e) => sha1Of(e.type, e.data));
  return { entries, oids };
}

// Length of the zlib stream starting at buf[0]. Node's inflateSync ignores
// trailing bytes but throws on a truncated stream, so the minimal length
// that inflates successfully is exactly the stream end; find it by binary
// search (success is monotonic in length).
function compressedLength(buf: Buffer): number {
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op) {
      out.push(delta.subarray(p, p + op));
      p += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

// ---------------------------------------------------------------------------
// Sideband helpers
// ---------------------------------------------------------------------------

export function sideband(data: Buffer, band: 1 | 2 | 3): Buffer {
  const out: Buffer[] = [];
  const MAX = 32768 - 5; // 4-byte pkt length + 1 band byte
  for (let i = 0; i < data.length; i += MAX) {
    const chunk = data.subarray(i, Math.min(data.length, i + MAX));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=' + AGENT + ' object-format=sha1';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT + ' object-format=sha1';

export function uploadPackAdvertisementV0(repo: Repo): Buffer {
  const cacheKey = `up-v0:${repo.refVersion}:${repo.defaultBranch}`;
  const cached = repo.advCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [];
  parts.push(pktLineString('# service=git-upload-pack'));
  parts.push(FLUSH);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLineString(`${ZERO} capabilities^{}\0symref=HEAD:refs/heads/${repo.defaultBranch} ${UPLOAD_CAPS_V0}`));
  } else {
    const headTip = repo.headTip() ?? ZERO;
    const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} ${UPLOAD_CAPS_V0}`;
    parts.push(pktLineString(`${headTip} HEAD\0${caps}`));
    for (const r of refs) {
      parts.push(pktLineString(`${r.oid} ${r.name}`));
      if (r.peeled) parts.push(pktLineString(`${r.peeled} ${r.name}^{}`));
    }
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.advCache.set(cacheKey, out);
  return out;
}

export function receivePackAdvertisementV0(repo: Repo): Buffer {
  const cacheKey = `recv-v0:${repo.refVersion}:${repo.defaultBranch}`;
  const cached = repo.advCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [];
  parts.push(pktLineString('# service=git-receive-pack'));
  parts.push(FLUSH);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLineString(`${ZERO} capabilities^{}\0${RECEIVE_CAPS_V0}`));
  } else {
    const headTip = repo.headTip() ?? ZERO;
    parts.push(pktLineString(`${headTip} HEAD\0${RECEIVE_CAPS_V0}`));
    for (const r of refs) {
      parts.push(pktLineString(`${r.oid} ${r.name}`));
      if (r.peeled) parts.push(pktLineString(`${r.peeled} ${r.name}^{}`));
    }
  }
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.advCache.set(cacheKey, out);
  return out;
}

export function uploadPackAdvertisementV2(repo: Repo): Buffer {
  const cacheKey = `up-v2:${repo.refVersion}:${repo.defaultBranch}`;
  const cached = repo.advCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [];
  parts.push(pktLineString('version 2'));
  parts.push(pktLineString('agent=' + AGENT));
  parts.push(pktLineString('ls-refs=unborn peel symrefs ref-prefix'));
  parts.push(pktLineString('fetch=shallow filter deepen-relative'));
  parts.push(pktLineString('object-format=sha1'));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.advCache.set(cacheKey, out);
  return out;
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    const line: RefLine = { name, oid };
    const obj = repo.getObject(oid);
    if (obj?.type === 'tag') {
      const target = parseTag(obj.data).object;
      const targetObj = repo.getObject(target);
      if (targetObj?.type === 'commit') line.peeled = target;
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upload-pack: ls-refs (v2)
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const sections = parseSections(body);
  // v2 ls-refs body: [command=ls-refs, agent, object-format] delim
  // [peel, symrefs, unborn, ref-prefix ...] flush. The arguments live in
  // the second section (after the delimiter).
  const args = sections[1] ?? [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of args) {
    const l = line.trim();
    if (l === 'peel') peel = true;
    else if (l === 'symrefs') symrefs = true;
    else if (l === 'unborn') unborn = true;
    else if (l.startsWith('ref-prefix ')) prefixes.push(l.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (unborn && matches('HEAD')) {
      parts.push(pktLineString(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`));
    }
  } else {
    const headTip = repo.headTip();
    if (headTip && matches('HEAD')) {
      const attrs = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLineString(`${headTip} HEAD${attrs}`));
    }
    for (const r of refs) {
      if (!matches(r.name)) continue;
      let attrs = '';
      if (symrefs && r.name === `refs/heads/${repo.defaultBranch}`) {
        // HEAD is listed separately; no symref attr on the branch itself.
      }
      if (peel && r.peeled) attrs += ` peeled:${r.peeled}`;
      parts.push(pktLineString(`${r.oid} ${r.name}${attrs}`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Upload-pack: fetch (v2 and v0)
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[]; // client-declared shallow lines
  deepen: number | null;
  deepenRelative: boolean;
  thinPack: boolean;
}

export function parseFetchV2(body: Buffer): FetchRequest {
  const sections = parseSections(body);
  const req: FetchRequest = { wants: [], haves: [], shallows: [], deepen: null, deepenRelative: false, thinPack: false };
  const args = sections[1] ?? [];
  for (const line of args) {
    const l = line.trim();
    if (l.startsWith('want ')) req.wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) req.shallows.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) req.deepen = Number(l.slice(7).trim());
    else if (l === 'deepen-relative') req.deepenRelative = true;
    else if (l === 'thin-pack') req.thinPack = true;
  }
  return req;
}

export function parseFetchV0(body: Buffer): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallows: [], deepen: null, deepenRelative: false, thinPack: false };
  const s1 = parsePktLines(body);
  for (const line of s1.lines) {
    const l = line.trim();
    const nul = l.indexOf('\0');
    const clean = nul === -1 ? l : l.slice(0, nul);
    if (clean.startsWith('want ')) req.wants.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) req.shallows.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) req.deepen = Number(clean.slice(7).trim());
    else if (clean === 'deepen-relative') req.deepenRelative = true;
  }
  const s2 = parsePktLines(body, s1.next);
  for (const line of s2.lines) {
    const l = line.trim();
    if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
  }
  return req;
}

// Resolve a wanted oid through annotated tags to the underlying commit
// (tags can point at tags). Returns the commit oid, plus every tag oid on
// the chain (those tag objects must travel in the pack themselves).
function resolveWant(repo: Repo, oid: string): { commit: string | null; tags: string[] } {
  const tags: string[] = [];
  let cur = oid;
  for (;;) {
    const obj = repo.getObject(cur);
    if (!obj) return { commit: null, tags };
    if (obj.type === 'tag') {
      tags.push(cur);
      cur = parseTag(obj.data).object;
      continue;
    }
    if (obj.type === 'commit') return { commit: cur, tags };
    return { commit: null, tags };
  }
}

// Compute the send set for a fetch, following the harness's shallow/deepen
// semantics. Returns the commit oids to send, tag objects to send, the
// shallow/unshallow lines, and the held commit set (what the client has).
export function computeFetch(repo: Repo, req: FetchRequest): {
  send: Set<string>;
  extraOids: Set<string>;
  shallowOut: string[];
  unshallowOut: string[];
  held: Set<string>;
} {
  const clientShallow = new Set(req.shallows);
  // Held set: reachable from haves, never descending past a client shallow
  // boundary (the boundary commit itself is held, its parents are not).
  const held = new Set<string>();
  {
    const queue = [...req.haves];
    const seen = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.getObject(cur);
      if (!obj || obj.type !== 'commit') continue;
      held.add(cur);
      if (clientShallow.has(cur)) continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  // Resolve wants through tags.
  const wantCommits: string[] = [];
  const extraOids = new Set<string>();
  for (const w of req.wants) {
    const r = resolveWant(repo, w);
    for (const t of r.tags) extraOids.add(t);
    if (r.commit) wantCommits.push(r.commit);
  }
  let wanted: Set<string>;
  let boundary = new Set<string>();
  if (req.deepen !== null && req.deepen > 0) {
    if (req.deepenRelative && req.shallows.length > 0) {
      // deepen-relative (real git's --deepen): the new boundary sits
      // `deepen` levels BELOW the client's current shallow commits, i.e.
      // depth deepen+1 from each reachable shallow commit.
      const newBoundary = new Set<string>();
      for (const s of req.shallows) {
        if (!wantCommits.some((w) => isAncestor(repo, s, w))) continue;
        const d = depthClosure(repo, [s], req.deepen + 1);
        for (const b of d.boundary) newBoundary.add(b);
      }
      wanted = new Set<string>();
      for (const w of wantCommits) {
        for (const c of reachableCommits(repo, w)) wanted.add(c);
      }
      // Exclude everything strictly below the new boundary.
      const excluded = new Set<string>();
      for (const b of newBoundary) {
        const obj = repo.getObject(b);
        if (!obj || obj.type !== 'commit') continue;
        for (const p of parseCommit(obj.data).parents) {
          for (const c of reachableCommits(repo, p)) excluded.add(c);
        }
      }
      for (const e of excluded) wanted.delete(e);
      boundary = newBoundary;
    } else {
      const d = depthClosure(repo, wantCommits, req.deepen);
      wanted = d.included;
      boundary = d.boundary;
    }
  } else {
    wanted = new Set<string>();
    for (const w of wantCommits) {
      for (const c of reachableCommits(repo, w)) wanted.add(c);
    }
  }
  const send = new Set<string>();
  for (const c of wanted) if (!held.has(c)) send.add(c);
  // Shallow lines out: boundary commits that are sent (or that are shallow
  // in the new view). Unshallow: client shallow commits that are no longer
  // shallow (their parents are now included in the send set).
  const shallowOut: string[] = [];
  for (const b of boundary) if (send.has(b)) shallowOut.push(b);
  const unshallowOut: string[] = [];
  for (const s of clientShallow) {
    const obj = repo.getObject(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => send.has(p) || wanted.has(p))) unshallowOut.push(s);
  }
  return { send, extraOids, shallowOut, unshallowOut, held };
}

// Objects the client already holds, given the held commit set: each held
// commit plus its own tree closure — but NOT its ancestors. (A shallow
// client holds the tip and its tree, not the parent's tree, even though the
// parent is reachable from the tip on the server.)
function heldObjectSet(repo: Repo, heldCommits: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const commitOid of heldCommits) {
    out.add(commitOid);
    const obj = repo.getObject(commitOid);
    if (!obj || obj.type !== 'commit') continue;
    const stack = [parseCommit(obj.data).tree];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      const o = repo.getObject(cur);
      if (!o) continue;
      out.add(cur);
      if (o.type === 'tree') {
        for (const e of parseTree(o.data)) stack.push(e.oid);
      }
    }
  }
  return out;
}

// Build the pack for a fetch: exactly the send commits (never their
// ancestors — the send set already is the exact closure) plus each send
// commit's tree closure, minus anything the client already holds, plus any
// extra objects (e.g. tag objects the client asked for by oid).
export function buildFetchPack(
  repo: Repo,
  sendCommits: Set<string>,
  extraOids: Set<string>,
  heldCommits: Set<string>,
): Buffer | null {
  if (sendCommits.size === 0 && extraOids.size === 0) return null;
  const cacheKey =
    [...sendCommits].sort().join(',') + '|' + [...extraOids].sort().join(',') + '|' + [...heldCommits].sort().join(',');
  const cachedPack = repo.packCache.get(cacheKey);
  if (cachedPack) return cachedPack;
  const heldObjs = heldObjectSet(repo, heldCommits);
  const out = new Set<string>();
  for (const oid of extraOids) out.add(oid);
  for (const commitOid of sendCommits) {
    out.add(commitOid);
    const obj = repo.getObject(commitOid);
    if (!obj || obj.type !== 'commit') continue;
    const treeOid = parseCommit(obj.data).tree;
    const stack = [treeOid];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur) || heldObjs.has(cur)) continue;
      const o = repo.getObject(cur);
      if (!o) continue;
      out.add(cur);
      if (o.type === 'tree') {
        for (const e of parseTree(o.data)) stack.push(e.oid);
      }
    }
  }
  const entries: { oid: string; type: ObjType; data: Buffer }[] = [];
  for (const oid of out) {
    const obj = repo.getObject(oid)!;
    entries.push({ oid, type: obj.type, data: obj.data });
  }
  // Deterministic pack order: commits first (sorted), then the rest sorted.
  entries.sort((a, b) => {
    const rank = (t: ObjType) => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'blob' ? 2 : 3);
    return rank(a.type) - rank(b.type) || (a.oid < b.oid ? -1 : 1);
  });
  const pack = writePack(entries);
  if (repo.packCache.size >= 8) {
    const firstKey = repo.packCache.keys().next().value;
    if (firstKey !== undefined) repo.packCache.delete(firstKey);
  }
  repo.packCache.set(cacheKey, pack);
  return pack;
}

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const req = parseFetchV2(body);
  const { send, extraOids, shallowOut, unshallowOut, held } = computeFetch(repo, req);
  const pack = buildFetchPack(repo, send, extraOids, held);
  const parts: Buffer[] = [];
  // Protocol v2 fetch response (git's own upload-pack/fetch-pack rules):
  // - No haves: no acknowledgments section; straight to the packfile.
  // - Haves with a common base: ACK each common have, then "ready", and
  //   the acknowledgments section ends with a DELIM (not FLUSH) — real git
  //   dies with "expected packfile to be sent after 'ready'" otherwise.
  //   A packfile section ALWAYS follows (even an empty pack when the
  //   client already holds everything).
  // - Haves with no common base: NAK, section ends with FLUSH, no packfile.
  let sendPack = req.haves.length === 0;
  if (req.haves.length > 0) {
    parts.push(pktLineString('acknowledgments'));
    let acked = false;
    for (const h of req.haves) {
      if (req.wants.some((w) => isAncestor(repo, h, w))) {
        parts.push(pktLineString(`ACK ${h}`));
        acked = true;
      }
    }
    if (acked) {
      parts.push(pktLineString('ready'));
      parts.push(DELIM);
      sendPack = true;
    } else {
      parts.push(pktLineString('NAK'));
      parts.push(FLUSH);
    }
  }
  if (sendPack) {
    if (shallowOut.length || unshallowOut.length) {
      parts.push(pktLineString('shallow-info'));
      for (const s of shallowOut) parts.push(pktLineString(`shallow ${s}`));
      for (const s of unshallowOut) parts.push(pktLineString(`unshallow ${s}`));
      parts.push(DELIM);
    }
    parts.push(pktLineString('packfile'));
    // An empty pack (0 objects) when the client holds everything.
    parts.push(sideband(pack ?? writePack([]), 1));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const req = parseFetchV0(body);
  const { send, extraOids, shallowOut, unshallowOut, held } = computeFetch(repo, req);
  const pack = buildFetchPack(repo, send, extraOids, held);
  const parts: Buffer[] = [];
  let acked = false;
  for (const h of req.haves) {
    if (req.wants.some((w) => isAncestor(repo, h, w))) {
      parts.push(pktLineString(`ACK ${h}`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLineString('NAK'));
  for (const s of shallowOut) parts.push(pktLineString(`shallow ${s}`));
  for (const s of unshallowOut) parts.push(pktLineString(`unshallow ${s}`));
  if (pack) parts.push(sideband(pack, 1));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (v0)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { lines, next } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const l = line.trim();
    const nul = l.indexOf('\0');
    const clean = nul === -1 ? l : l.slice(0, nul);
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  return { commands, pack: body.subarray(next) };
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parseReceivePackBody(body);
  // Ingest the pack first (skip when there is no pack data, e.g. delete-only).
  if (pack.length > 0) {
    const { entries } = readPack(pack, repo);
    for (const e of entries) repo.putObject(e.type, e.data);
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const cmd of commands) {
    if (cmd.newOid === ZERO) {
      // Delete.
      const current = repo.refs.get(cmd.ref);
      if (current === undefined || current === ZERO) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      } else if (cmd.oldOid !== ZERO && current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      } else {
        repo.deleteRef(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO;
    if (cmd.oldOid !== ZERO && current !== cmd.oldOid) {
      // Stale old value: the client pushed against a tip we do not have.
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (current !== ZERO && !isAncestor(repo, current, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.setRef(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  const lines: Buffer[] = [];
  lines.push(pktLineString('unpack ok'));
  for (const r of results) {
    lines.push(pktLineString(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'failed'}`));
  }
  lines.push(FLUSH);
  return Buffer.concat([sideband(Buffer.concat(lines), 1), FLUSH]);
}
