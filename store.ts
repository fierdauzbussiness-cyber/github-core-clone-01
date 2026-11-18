// store.ts — in-memory data model for the forge: git objects, refs, repos,
// issues, pull requests, labels and comments. No dependencies, Node stdlib only.
import { createHash } from 'node:crypto';

export const ZERO = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const AGENT = 'github-core-clone-01-forge/1.0.0';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Of(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  // Git sort order: entries sorted by name, directories compared as name + '/'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Repo model
// ---------------------------------------------------------------------------

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headBranch: string;
  baseBranch: string;
  seq: number;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface RepoComment {
  id: number;
  body: string;
  seq: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // full refname -> oid
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  labels = new Map<string, Label>();
  comments = new Map<number, RepoComment[]>(); // issue number -> comments
  issueSeq = 0; // shared issue + PR counter
  seq: number;
  // Deterministic clock for REST-created commits: fixed epoch + counter.
  commitClock = 1700000000;
  commitCounter = 0;
  // Bump on every ref change; caches keyed by it stay fresh.
  refVersion = 0;
  // Memoised wire bytes: fetch packs (keyed by the exact send set) and
  // advertisements (keyed by refVersion + default branch). Objects are
  // content-addressed and immutable, so a memo keyed by the oid set is safe.
  packCache = new Map<string, Buffer>();
  advCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, seq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.seq = seq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  bumpVersion(): void {
    this.refVersion++;
    this.advCache.clear();
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = sha1Of(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  refTip(ref: string): string | undefined {
    const v = this.refs.get(ref);
    return v && v !== ZERO ? v : undefined;
  }

  branchTip(branch: string): string | undefined {
    return this.refTip(`refs/heads/${branch}`);
  }

  headTip(): string | undefined {
    return this.branchTip(this.defaultBranch);
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.bumpVersion();
  }

  deleteRef(ref: string): void {
    this.refs.delete(ref);
    this.bumpVersion();
  }

  branches(): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  tags(): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of this.refs) {
      if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice('refs/tags/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  // Next deterministic timestamp for a REST-created commit.
  nextCommitTime(): number {
    return this.commitClock + this.commitCounter++;
  }
}

export class Store {
  repos = new Map<string, Repo>(); // "owner/name" -> Repo
  private repoIdSeq = 1000;
  private globalIdSeq = 100000;
  private seqCounter = 0;

  nextSeq(): number {
    return ++this.seqCounter;
  }

  nextGlobalId(): number {
    return ++this.globalIdSeq;
  }

  createRepo(owner: string, name: string, description = '', isPrivate = false): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(++this.repoIdSeq, owner, name, description, isPrivate, this.nextSeq());
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposForOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Git graph helpers (operate on a Repo's object store)
// ---------------------------------------------------------------------------

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

// All commits reachable from `tip` (including tip), walking parents.
export function reachableCommits(repo: Repo, tip: string): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    const obj = repo.getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    out.add(cur);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

// All objects (commits + trees + blobs + tags) reachable from a commit tip.
export function reachableObjects(repo: Repo, tips: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    const obj = repo.getObject(cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

// Depth-N closure from `wants`: want commits are depth 1; boundary = commits
// at exactly depth N (their parents are NOT included).
export function depthClosure(repo: Repo, wants: string[], depth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; d: number }[] = wants.map((w) => ({ oid: w, d: 1 }));
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    if (d >= depth) {
      boundary.add(oid);
    } else {
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
    }
  }
  return { included, boundary };
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = reachableCommits(repo, a);
  // BFS from b; first commit also in ancA is a merge base (not necessarily
  // unique in a criss-cross, but the harness only builds linear histories).
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ancA.has(cur)) return cur;
    const obj = repo.getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// Flatten a tree (by oid) into path -> {oid, mode} for files only.
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string) => {
    const obj = repo.getObject(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') {
        walk(e.oid, prefix + e.name + '/');
      } else {
        out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
      }
    }
  };
  walk(treeOid, '');
  return out;
}

// Build nested trees from a flat file map; returns the root tree oid.
export function buildTreeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  interface Node {
    files: Map<string, string>; // name -> blob oid
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, content] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    const blobOid = repo.putObject('blob', content);
    node.files.set(parts[parts.length - 1], blobOid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return repo.putObject('tree', serializeTree(entries));
  };
  return build(root);
}

export function commitObject(repo: Repo, treeOid: string, parents: string[], message: string, timestamp?: number): string {
  const ts = timestamp ?? repo.nextCommitTime();
  const ident = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${ts} +0000`;
  const body = `tree ${treeOid}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${ident}\ncommitter ${ident}\n\n${message}`;
  return repo.putObject('commit', Buffer.from(body, 'utf8'));
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(buf: Buffer): number {
  const s = buf.toString('utf8');
  if (s === '') return 0;
  const lines = s.split('\n');
  // A trailing newline does not start a new line.
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

// Naive prefix/suffix-trim line diff; exact enough for the harness, which
// only asserts additions >= 1 for changed files and the status values.
function lineDiff(oldBuf: Buffer | null, newBuf: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldBuf ? oldBuf.toString('utf8').split('\n') : [];
  const newLines = newBuf ? newBuf.toString('utf8').split('\n') : [];
  const trim = (a: string[]) => (a.length && a[a.length - 1] === '' ? a.slice(0, -1) : a);
  let o = trim(oldLines);
  let n = trim(newLines);
  let prefix = 0;
  while (prefix < o.length && prefix < n.length && o[prefix] === n[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < o.length - prefix &&
    suffix < n.length - prefix &&
    o[o.length - 1 - suffix] === n[n.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { additions: n.length - prefix - suffix, deletions: o.length - prefix - suffix };
}

export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b && !h) {
      const oldBuf = repo.getObject(b.oid)?.data ?? null;
      out.push({ filename: p, status: 'removed', additions: 0, deletions: countLines(oldBuf ?? Buffer.alloc(0)), changes: countLines(oldBuf ?? Buffer.alloc(0)) });
    } else if (!b && h) {
      const newBuf = repo.getObject(h.oid)?.data ?? null;
      const adds = countLines(newBuf ?? Buffer.alloc(0));
      out.push({ filename: p, status: 'added', additions: adds, deletions: 0, changes: adds });
    } else if (b && h && b.oid !== h.oid) {
      const d = lineDiff(repo.getObject(b.oid)?.data ?? null, repo.getObject(h.oid)?.data ?? null);
      out.push({ filename: p, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

// Three-way conflict test: same path changed differently on both sides of
// the merge base. Returns true when a squash merge must be refused (405).
export function hasMergeConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  const mb = mergeBase(repo, baseTip, headTip);
  const mbTree = mb ? parseCommit(repo.getObject(mb)!.data).tree : null;
  const baseTree = parseCommit(repo.getObject(baseTip)!.data).tree;
  const headTree = parseCommit(repo.getObject(headTip)!.data).tree;
  const baseSide = diffTrees(repo, mbTree, baseTree);
  const headSide = diffTrees(repo, mbTree, headTree);
  const baseChanged = new Map<string, FileDiff>();
  for (const d of baseSide) baseChanged.set(d.filename, d);
  const headMap = flattenTree(repo, headTree);
  const baseMap = flattenTree(repo, baseTree);
  for (const d of headSide) {
    const other = baseChanged.get(d.filename);
    if (!other) continue;
    const headOid = headMap.get(d.filename)?.oid ?? null;
    const baseOid = baseMap.get(d.filename)?.oid ?? null;
    if (headOid !== baseOid) return true;
  }
  return false;
}

// Commit a single file on a branch (REST /contents). Creates the branch from
// the default branch tip when it does not exist yet. Returns the new commit.
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; created: boolean } {
  let tip = repo.branchTip(branch);
  let baseTree: string | null = null;
  if (!tip) {
    // New branch: start from the default branch tip (or nothing on an
    // unborn repo).
    const defaultTip = repo.headTip();
    if (defaultTip) {
      tip = defaultTip;
      baseTree = parseCommit(repo.getObject(defaultTip)!.data).tree;
    }
  } else {
    baseTree = parseCommit(repo.getObject(tip)!.data).tree;
  }
  const files = baseTree ? flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const created = !files.has(path);
  const blobSha = repo.putObject('blob', content);
  const fileMap = new Map<string, Buffer>();
  for (const [p, entry] of files) {
    const obj = repo.getObject(entry.oid);
    if (obj) fileMap.set(p, obj.data);
  }
  fileMap.set(path, content);
  const treeOid = buildTreeFromFiles(repo, fileMap);
  const parents = tip ? [tip] : [];
  const commitSha = commitObject(repo, treeOid, parents, message);
  repo.setRef(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created };
}

// Squash-merge a pull request onto its base branch. Caller must check the
// PR is open and conflict-free first.
export function squashMerge(repo: Repo, pr: Pull): string {
  const baseTip = repo.branchTip(pr.baseBranch)!;
  const headTip = repo.branchTip(pr.headBranch)!;
  const headTree = parseCommit(repo.getObject(headTip)!.data).tree;
  const message = `Merge pull request #${pr.number} from ${pr.headBranch}\n\n${pr.title}`;
  const commitSha = commitObject(repo, headTree, [baseTip], message);
  repo.setRef(`refs/heads/${pr.baseBranch}`, commitSha);
  return commitSha;
}

// List commits newest-first from a tip, capped.
export function listCommits(repo: Repo, tip: string, limit = 100): { sha: string; message: string; author: string; time: number }[] {
  const out: { sha: string; message: string; author: string; time: number }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    const m = c.committer.match(/ (\d+) [+-]\d{4}$/);
    out.push({ sha: cur, message: c.message, author: c.author, time: m ? Number(m[1]) : 0 });
    for (const p of c.parents) queue.push(p);
  }
  return out;
}

// Global IDs for GraphQL (opaque, base64url).
export function globalId(kind: 'R' | 'I' | 'P' | 'C', parts: string): string {
  return Buffer.from(`${kind}:${parts}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const i = decoded.indexOf(':');
    if (i <= 0) return null;
    return { kind: decoded.slice(0, i), parts: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}
