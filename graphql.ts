// graphql.ts — a small GraphQL parser + executor for the subset the
// harness uses: queries, mutations, variables, inline enum lists, inline
// input objects, null variables, aliases, inline fragments, batch arrays,
// and the __type / __schema introspection the checks rely on.
// Node stdlib only.
import {
  VIEWER_LOGIN, VIEWER_ID, globalId, decodeGlobalId, diffTrees, hasMergeConflict,
  mergeBase, parseCommit, squashMerge,
} from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i++; continue; }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: { name: string; value: ValueNode }[];
  selection?: SelectionNode[];
}

export interface FragmentNode {
  kind: 'inlineFragment';
  typeCondition?: string;
  selection: SelectionNode[];
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
}

export type SelectionNode = FieldNode | FragmentNode | SpreadNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selection: SelectionNode[];
}

export interface FragmentDefNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

export type DefinitionNode = OperationNode | FragmentDefNode;

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.kind} ${t.value}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${t.kind} ${t.value}`);
    return t.value;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', variables: [], selection: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const op = this.next().value as 'query' | 'mutation';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
      return { kind: 'operation', operation: op, name, variables, selection: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected on in fragment');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selection: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start ${t.kind} ${t.value}`);
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    this.expectPunct('(');
    const out: { name: string; defaultValue?: ValueNode }[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      out.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (n.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inlineFragment', selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    // Directives: skip @name(args?).
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selection = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', name, alias, args, selection };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const out: { name: string; value: ValueNode }[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.kind} ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Field tables (for validation + introspection)
// ---------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'private', 'url', 'createdAt',
  ],
  Ref: ['name', 'target'],
  GitObject: ['oid'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'url', 'createdAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'COMMIT', 'DISCUSSION', 'LABEL', 'MILESTONE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface TypedValue {
  __type: string;
  [key: string]: unknown;
}

interface Ctx {
  store: Store;
  errors: { message: string }[];
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefNode>;
}

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': return ctx.variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evalValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, ctx);
      return out;
    }
  }
}

function argsMap(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, ctx);
  return out;
}

function isoDate(seq: number): string {
  return new Date(1700000000000 + seq * 1000).toISOString();
}

function issueValue(repo: Repo, issue: Issue): TypedValue {
  return {
    __type: 'Issue',
    repo,
    issue,
    id: globalId('I', `${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: isoDate(issue.createdSeq),
    updatedAt: isoDate(issue.createdSeq),
  };
}

function pullValue(repo: Repo, pr: Pull): TypedValue {
  const state = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __type: 'PullRequest',
    repo,
    pr,
    id: globalId('P', `${repo.owner}/${repo.name}/${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state,
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    headRefName: pr.headBranch,
    baseRefName: pr.baseBranch,
    headRefOid: repo.branchTip(pr.headBranch) ?? null,
    baseRefOid: repo.branchTip(pr.baseBranch) ?? null,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    createdAt: isoDate(pr.createdSeq),
  };
}

function repoValue(repo: Repo): TypedValue {
  return {
    __type: 'Repository',
    repo,
    id: globalId('R', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    private: repo.isPrivate,
    url: `https://github.com/${repo.fullName}`,
    createdAt: isoDate(repo.seq),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function cursorFor(seq: number): string {
  return Buffer.from(`c:${seq}`, 'utf8').toString('base64url');
}

function seqFromCursor(cursor: string): number | null {
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!s.startsWith('c:')) return null;
    const n = Number(s.slice(2));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveField(typeName: string, field: FieldNode, value: unknown, ctx: Ctx): unknown {
  const v = value as TypedValue;
  const args = argsMap(field, ctx);
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __type: 'User', login: VIEWER_LOGIN, id: globalId('U', VIEWER_LOGIN), name: VIEWER_LOGIN, url: `https://github.com/${VIEWER_LOGIN}` };
      }
      if (field.name === 'repository') {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoValue(repo) : null;
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const [owner, name] = decoded.parts.split('/');
          const repo = ctx.store.getRepo(owner, name);
          return repo ? repoValue(repo) : null;
        }
        if (decoded.kind === 'I') {
          const [owner, name, num] = decoded.parts.split('/');
          const repo = ctx.store.getRepo(owner, name);
          const issue = repo?.issues.get(Number(num));
          return repo && issue ? issueValue(repo, issue) : null;
        }
        if (decoded.kind === 'P') {
          const [owner, name, num] = decoded.parts.split('/');
          const repo = ctx.store.getRepo(owner, name);
          const pr = repo?.pulls.get(Number(num));
          return repo && pr ? pullValue(repo, pr) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (FIELDS[name]) {
          return { __type: '__Type', name, kind: 'OBJECT', fields: FIELDS[name], enumValues: [] };
        }
        if (ENUM_VALUES[name]) {
          return { __type: '__Type', name, kind: 'ENUM', fields: [], enumValues: ENUM_VALUES[name] };
        }
        return null;
      }
      return undefined;
    }
    case 'Repository': {
      const repo = v.repo as Repo;
      if (field.name === 'owner') {
        return { __type: 'User', login: repo.owner, id: globalId('U', repo.owner), name: repo.owner, url: `https://github.com/${repo.owner}` };
      }
      if (field.name === 'defaultBranchRef') {
        const tip = repo.headTip();
        if (!tip) return null;
        return { __type: 'Ref', name: repo.defaultBranch, target: { __type: 'GitObject', oid: tip } };
      }
      if (field.name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueValue(repo, issue) : null;
      }
      if (field.name === 'issues') {
        const states = (args.states as string[] | undefined) ?? null;
        const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
        const first = Number(args.first ?? 30);
        const after = args.after as string | undefined;
        let list = [...repo.issues.values()];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const dir = String(orderBy.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        if (after) {
          const afterSeq = seqFromCursor(after);
          if (afterSeq !== null) list = list.filter((i) => (dir === 'ASC' ? i.seq > afterSeq : i.seq < afterSeq));
        }
        const page = list.slice(0, first);
        const hasNextPage = list.length > first;
        const endCursor = page.length ? cursorFor(page[page.length - 1].seq) : null;
        return {
          __type: 'IssueConnection',
          nodes: page.map((i) => issueValue(repo, i)),
          pageInfo: { __type: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length ? cursorFor(page[0].seq) : null },
          totalCount: list.length,
        };
      }
      if (field.name === 'pullRequests') {
        const first = Number(args.first ?? 30);
        const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq).slice(0, first);
        return {
          __type: 'PullRequestConnection',
          nodes: list.map((p) => pullValue(repo, p)),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
          totalCount: repo.pulls.size,
        };
      }
      if (field.name === 'pullRequest') {
        const pr = repo.pulls.get(Number(args.number));
        return pr ? pullValue(repo, pr) : null;
      }
      return (v as Record<string, unknown>)[field.name];
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      return (v as Record<string, unknown>)[field.name];
    }
    case 'PageInfo': {
      return (v as Record<string, unknown>)[field.name];
    }
    case 'PullRequest': {
      const repo = v.repo as Repo;
      const pr = v.pr as Pull;
      if (field.name === 'mergeable') {
        if (pr.merged || pr.state !== 'open') return 'UNKNOWN';
        const baseTip = repo.branchTip(pr.baseBranch);
        const headTip = repo.branchTip(pr.headBranch);
        if (!baseTip || !headTip) return 'UNKNOWN';
        return hasMergeConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field.name === 'files') {
        const first = Number(args.first ?? 30);
        const headTip = repo.branchTip(pr.headBranch);
        const baseTip = repo.branchTip(pr.baseBranch);
        let files: { path: string }[] = [];
        if (headTip && baseTip) {
          const mb = mergeBase(repo, baseTip, headTip);
          const mbTree = mb ? parseCommit(repo.getObject(mb)!.data).tree : null;
          const headTree = parseCommit(repo.getObject(headTip)!.data).tree;
          files = diffTrees(repo, mbTree, headTree).map((d) => ({ path: d.filename, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() }));
        }
        const nodes = files.slice(0, first).map((f) => ({ __type: 'PullRequestChangedFile', ...f }));
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes,
          pageInfo: { __type: 'PageInfo', hasNextPage: files.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
        };
      }
      return (v as Record<string, unknown>)[field.name];
    }
    case 'PullRequestChangedFile': {
      return (v as Record<string, unknown>)[field.name];
    }
    case '__Type': {
      if (field.name === 'fields') {
        return ((v.fields as string[]) ?? []).map((n) => ({ __type: '__Field', name: n, description: null, type: null }));
      }
      if (field.name === 'enumValues') {
        return ((v.enumValues as string[]) ?? []).map((n) => ({ __type: '__EnumValue', name: n, description: null, type: null }));
      }
      return (v as Record<string, unknown>)[field.name];
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'R') throw new Error('repository not found');
        const [owner, name] = decoded.parts.split('/');
        const repo = ctx.store.getRepo(owner, name);
        if (!repo) throw new Error('repository not found');
        const n = ++repo.issueSeq;
        const issue: Issue = {
          id: ctx.store.nextGlobalId(), number: n, title: String(input.title ?? ''),
          body: String(input.body ?? ''), state: 'open', labels: [],
          seq: ctx.store.nextSeq(), createdSeq: ctx.store.nextSeq(),
        };
        repo.issues.set(n, issue);
        return { __type: 'CreateIssuePayload', issue: issueValue(repo, issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as { issueId?: string };
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'I') throw new Error('issue not found');
        const [owner, name, num] = decoded.parts.split('/');
        const repo = ctx.store.getRepo(owner, name);
        const issue = repo?.issues.get(Number(num));
        if (!repo || !issue) throw new Error('issue not found');
        issue.state = 'closed';
        return { __type: 'CloseIssuePayload', issue: issueValue(repo, issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'R') throw new Error('repository not found');
        const [owner, name] = decoded.parts.split('/');
        const repo = ctx.store.getRepo(owner, name);
        if (!repo) throw new Error('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!repo.branchTip(head) || !repo.branchTip(base)) throw new Error('branch not found');
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headBranch === head && p.baseBranch === base) {
            throw new Error('A pull request already exists for this head and base');
          }
        }
        const n = ++repo.issueSeq;
        const pr: Pull = {
          id: ctx.store.nextGlobalId(), number: n, title: String(input.title ?? ''),
          body: String(input.body ?? ''), state: 'open', merged: false, mergedAt: null,
          mergeCommitSha: null, headBranch: head, baseBranch: base,
          seq: ctx.store.nextSeq(), createdSeq: ctx.store.nextSeq(),
        };
        repo.pulls.set(n, pr);
        return { __type: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pr) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as { pullRequestId?: string; mergeMethod?: string };
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'P') throw new Error('pull request not found');
        const [owner, name, num] = decoded.parts.split('/');
        const repo = ctx.store.getRepo(owner, name);
        const pr = repo?.pulls.get(Number(num));
        if (!repo || !pr) throw new Error('pull request not found');
        if (pr.state !== 'open' || pr.merged) throw new Error('pull request is not open');
        const baseTip = repo.branchTip(pr.baseBranch);
        const headTip = repo.branchTip(pr.headBranch);
        if (!baseTip || !headTip) throw new Error('branch not found');
        if (hasMergeConflict(repo, baseTip, headTip)) throw new Error('merge conflict');
        const sha = squashMerge(repo, pr);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = new Date().toISOString();
        pr.mergeCommitSha = sha;
        return { __type: 'MergePullRequestPayload', pullRequest: pullValue(repo, pr) };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as { subjectId?: string; body?: string };
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (!decoded || (decoded.kind !== 'I' && decoded.kind !== 'P')) throw new Error('subject not found');
        const [owner, name, num] = decoded.parts.split('/');
        const repo = ctx.store.getRepo(owner, name);
        if (!repo) throw new Error('subject not found');
        const number = Number(num);
        const commentId = ctx.store.nextGlobalId();
        const list = repo.comments.get(number) ?? [];
        list.push({ id: commentId, body: String(input.body ?? ''), seq: ctx.store.nextSeq() });
        repo.comments.set(number, list);
        return {
          __type: 'AddCommentPayload',
          commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', id: globalId('C', `${owner}/${name}/${number}/${commentId}`), body: String(input.body ?? '') } },
        };
      }
      return undefined;
    }
    default: {
      return (v as Record<string, unknown>)[field.name];
    }
  }
}

function executeSelection(
  selections: SelectionNode[],
  typeName: string,
  value: unknown,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      const inner = executeSelection(sel.selection, sel.typeCondition ?? typeName, value, ctx);
      Object.assign(out, inner);
      continue;
    }
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      const inner = executeSelection(frag.selection, frag.typeCondition, value, ctx);
      Object.assign(out, inner);
      continue;
    }
    const field = sel;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const known = FIELDS[typeName] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    let fieldValue: unknown;
    try {
      fieldValue = resolveField(typeName, field, value, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (fieldValue === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (field.selection && fieldValue !== null && typeof fieldValue === 'object') {
      const childType = (fieldValue as TypedValue).__type;
      if (childType) {
        out[responseKey] = executeSelection(field.selection, childType, fieldValue, ctx);
      } else if (Array.isArray(fieldValue)) {
        // Lists of typed values (e.g. __Type.fields): element type is
        // inferred from the first element.
        out[responseKey] = fieldValue.map((el) => {
          if (el !== null && typeof el === 'object' && (el as TypedValue).__type) {
            return executeSelection(field.selection!, (el as TypedValue).__type, el, ctx);
          }
          return el;
        });
      } else {
        out[responseKey] = fieldValue;
      }
    } else {
      out[responseKey] = fieldValue;
    }
  }
  return out;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown> | null, operationName?: string | null): GraphQLResult {
  let defs: DefinitionNode[];
  try {
    defs = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentDefNode>();
  const operations = defs.filter((d): d is OperationNode => d.kind === 'operation');
  for (const d of defs) if (d.kind === 'fragment') fragments.set(d.name, d);
  const op = operationName
    ? operations.find((o) => o.name === operationName) ?? operations[0]
    : operations[0];
  if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
  const ctx: Ctx = { store, errors: [], variables: { ...(variables ?? {}) }, fragments };
  for (const v of op.variables) {
    if (!(v.name in ctx.variables) && v.defaultValue) {
      ctx.variables[v.name] = evalValue(v.defaultValue, ctx);
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(op.selection, rootType, {}, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

// Handle one request body (single document or a batch array). Returns the
// JSON-serialisable response body.
export function handleGraphQLRequest(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => {
      const q = item as { query?: string; variables?: Record<string, unknown> | null; operationName?: string | null };
      return executeGraphQL(store, String(q.query ?? ''), q.variables ?? null, q.operationName ?? null);
    });
  }
  const q = body as { query?: string; variables?: Record<string, unknown> | null; operationName?: string | null };
  return executeGraphQL(store, String(q.query ?? ''), q.variables ?? null, q.operationName ?? null);
}
