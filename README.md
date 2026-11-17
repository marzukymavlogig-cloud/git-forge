# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/marzukymavlogig-cloud/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/marzukymavlogig-cloud/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Standalone GitHub-compatible git forge in a single process: git smart HTTP
(protocol v2 and v0, pack creation and application with deltas), REST v3,
GraphQL and MCP over one shared in-memory store. Node 22 standard library
only — no dependencies, no git binary. Local grade on the kit's runner:
120/120 conformance checks, 200/200 MCP, perf ~160/200 (total ~960 vs the
reference forge's ~900).

## Run it

```sh
node main.ts
```

The server binds an ephemeral port, registers it, and serves until the
suite signals done. See `main.ts` for the lifecycle and `app.ts` for the
HTTP routing.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
