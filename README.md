# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/iksantuy/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/iksantuy/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process: git smart HTTP (upload-pack
protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API under `/api/v3`; the
GraphQL v4 API at `/api/graphql`; and a Model Context Protocol endpoint at `/mcp`. It serves from its
own in-memory store — no git binary, no package, no network.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=tok node main.ts
```

`main.ts` binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, serves until
the env answers `{"done": true}` on `GET $MAKEFUN_ENV_URL/done`, then exits 0.

## What it implements

| Surface | What is there |
| --- | --- |
| `/{owner}/{repo}.git/info/refs`, `/git-upload-pack` | protocol v2: capability advertisement, `ls-refs` (symrefs, peel, `ref-prefix`, unborn), `fetch` with wants/haves, `shallow`/`deepen`, sideband-framed packfiles |
| `/{owner}/{repo}.git/info/refs`, `/git-receive-pack` | protocol v0: ref advertisement with `report-status`, `side-band-64k`, `delete-refs`; pack parsing (full objects, `ofs-delta`, `ref-delta`); per-ref report lines; every update must fast-forward |
| `/api/v3/…` | API root and meta, user repos with `Link` pagination, repositories (create/patch/delete), branches, `git/refs`, commits, contents (create/update/409 on a stale sha/delete/directory listing), labels, issues, comments, pull requests, pull files and squash merge (404 unknown, 405 conflicted) |
| `/api/graphql` | a parser and executor for the documents `gh` and github-mcp-server send: `viewer`, `repository`, `node`, `__type` introspection, `issues`/`pullRequests` connections with cursors, `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`, batched operations, field errors |
| `/mcp` | JSON-RPC 2.0 over streamable HTTP at revision 2026-07-28 (`server/discover`) with the `initialize` handshake kept: `tools/list` (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request, list_pulls) and `tools/call`, all acting on the same store REST reads |

Git objects are content addressed (`sha1("<type> <len>\0" + bytes)`); trees, commits, tags, packfiles
and deltas are built and parsed here, so the trial needs nothing installed and no network.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register it, wait for done).
- `app.ts` — the HTTP router and the bearer-token check.
- `gitproto.ts` — pkt-line framing, packfile read/write, delta resolution, upload-pack and receive-pack.
- `rest.ts` — the REST v3 resources and the pull-request merge path.
- `gql.ts` — the GraphQL lexer, parser, resolvers and introspection.
- `mcp.ts` — the MCP tools and the JSON-RPC transport.

## License

MIT — see `LICENSE`.
