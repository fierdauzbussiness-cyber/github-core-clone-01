# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fierdauzbussiness-cyber/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fierdauzbussiness-cyber/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge: git smart-HTTP protocol (upload-pack v2 + v0, receive-pack v0), REST v3 API, GraphQL API and an MCP server — in one Node 22 process, stdlib only, no dependencies, no network at grade time. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, registers it with the trial environment via `POST $MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done` until the trial ends and exits 0. `MAKEFUN_ENV_URL` must be set (exit 1 otherwise).

For local development, run the app directly:

```sh
node --experimental-strip-types app.ts
```

(or import `createApp()` from `app.ts` and listen on a port of your choice — the kit's local runner dials the server directly by URL.)

## What it implements

- **Git smart HTTP** (`/<owner>/<repo>.git`): upload-pack v2 (ls-refs with peel/symrefs/unborn/ref-prefix, fetch with thin-pack, shallow/deepen, ACK/NAK, shallow-info) and v0, receive-pack v0 with `report-status` / `side-band-64k` / `delete-refs`. Full packfiles (no deltas on the wire); OFS/REF deltas resolved on ingest. Byte-exact commit/tag round-trips, git-style tree sorting, fast-forward enforcement (`non-fast-forward` refusals), mixed report-status.
- **REST v3** (`/api/v3`): repos (create/get/patch/delete, paginated `GET /user/repos` with `Link: rel="next"`), branches, refs, commits, contents (create/update/delete with stale-sha 409), issues, labels, comments, pull requests (create/list/files/squash-merge with three-way conflict detection → 405). JSON everywhere, `X-GitHub-Request-Id` on every reply, 401 without a token, 400 on malformed JSON.
- **GraphQL** (`POST /api/graphql`): a small parser + executor (variables, inline enum lists, inline input objects, aliases, inline fragments, batch arrays, `__type` introspection) covering viewer, repository, issues (cursor pagination), pull requests (state, mergeable, files), node round-trips, and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations.
- **MCP** (`POST /mcp`, JSON-RPC 2.0): `server/discover` (era 2026-07-28 preferred), legacy `initialize`, `tools/list` (byte-identical every call) and six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` — with `structuredContent` on every result.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Trial lifecycle entrypoint (bind → register → poll done → exit). |
| `app.ts` | HTTP server: routing, auth, body parsing, JSON/git responses. |
| `store.ts` | In-memory model: git objects, refs, repos, issues, PRs; graph helpers (merge-base, diff, squash merge, tree build). |
| `git.ts` | pkt-line codec, packfile read/write, upload-pack v2/v0, receive-pack. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser + executor. |
| `mcp.ts` | MCP JSON-RPC server + the six tools. |

## Local grading (measured, not claimed)

Run the kit's own runner against a locally started forge:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8901 --token TESTTOKEN --perf
```

Result on a fresh server (2026-11-19, kit's local runner): **120/120 checks pass** — feature 600, agent 200, perf 172 (push p50 589 ms, clone p50 119 ms, read p50 918 ms, write p50 123 ms) — **score 972/1000**. Perf varies with host CPU load (a contended run measured 119); the conformance result (120/120) was stable across every run. The live field is near-perfect (median ~924, top-20 threshold ~954), so this entry is competitive but not guaranteed a paid place — the graded trials decide.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
