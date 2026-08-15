# Context

Deterministic discovery compiler for coding agents. Turns a task plus the
current working tree into a small, source-backed context capsule — no model,
no embeddings, no repo-local state.

Per `meta/cross-product/context.md` and `context-implementation-plan.md`:
Bun/TypeScript MVP, Tree-sitter for Go / TypeScript / JavaScript / Python (bespoke
walkers) plus Java / Ruby / Rust / C / C++ / C# / PHP / Bash (shared generic
walker), plain external content-addressed cache, deterministic lexical + graph
ranking.

## Commands

```text
context observe "<task>" [--budget N] [--json] [--root DIR]
               [--ignore pat[,pat]] [--no-gitignore]
context map <directory> [--root DIR]
context follow <symbol|qualified-id> [<edge>] [--root DIR]
context expand <handle|file:line> [--root DIR]
context impact <symbol|qualified-id|--diff> [--json] [--root DIR]
               [--ignore pat[,pat]] [--no-gitignore]
context init [--targets all|opencode,claude-code,codex,cursor,copilot,antigravity,pi]
             [--project] [--force] [--dry-run] [--hooks]
context config get [key]
context config set <key> <value>     keys: semantic on|off, model <name>
context --help
context --version   prints version, build commit, cache schema, runtime kind
```

`observe` (alias `prepare`) is orientation: DirMap, neighborhoods, spans.
`map` compiles a bounded local RepoMap over one directory (per-file symbols,
calls, tests). `follow` walks one edge kind (callers, callees, tests, inherit,
implement, contain, ref, import, all) with bounded depth and short trails.
`impact` is the symbol map (callers/callees/relations/tests) plus `--diff`.
Ambiguous bare names list their qualified candidates instead of silently
picking the first.

`--targets` rejects unknown agent names (exit 1, lists known targets).
`context config` reads/writes `~/.config/context/config.json` (honors
`XDG_CONFIG_HOME`); it never touches the repository.

## Install

### macOS, Linux, or WSL

```bash
curl -fsSL https://raw.githubusercontent.com/darvh/context/main/install.sh | bash
```

The installer selects the matching release ZIP for the current OS and
architecture. If no release is available, it falls back to a source install
and requires Bun. Useful flags: `--local`, `--targets <agents>`,
`--version <tag>`, `--force`, and `--dry-run`. Add `--hooks` to force the
source path and wire the Claude Code adapters.

### From a checkout

```bash
bun run install:local
```

Forward installer options after `--`, for example:

```bash
bun run install:local -- --targets pi --force
```

`context init` installs the host-neutral skill into each agent's skill
directory (same matrix as proof: opencode, claude-code, codex, cursor,
copilot, antigravity, pi), user or project scope. Idempotent: identical copies are
`up-to-date`, conflicts are skipped unless `--force`, absent home-scope agent
dirs are reported and never created silently. `--hooks` additionally wires the
UserPromptSubmit + agent-response hook adapters (claude-code settings today) —
explicit opt-in, never silent.

## Releases

Push a semantic version tag such as `v0.1.0`, or run the Release workflow from
`main` with a tag input. The workflow publishes one ZIP per supported target:

- Linux x64 and arm64
- macOS x64 and arm64
- Windows x64

Each ZIP contains the standalone `context` binary and its `grammars/` directory,
plus a `.sha256` checksum file.

## Development

```text
bun install
bun run context prepare "where is session persistence handled?" --root <repo>
bun test               # unit + smoke (launcher, cache safety, incremental)
bun run fixture        # generate the deterministic large-repo fixture (small)
bun run eval           # retrieval eval -> fixture subset (CI, no network)
bun run eval -- real   # + pinned real repos (clones at fixed revisions)
bun run bench          # variant idea checker: flat / DirMap / RepoMap / trails
bun run dup            # jscpd duplication check (src + eval scripts)
bun run unused         # knip unused-code check
bun run build          # standalone binary -> ./dist/context
bash scripts/smoke.sh ./dist/context   # clean-environment smoke suite
```

## Retrieval

Ranking fuses graph relationships, changed-file, explicit-path, and
entry-point signals (authoritative) with two fallback lanes:

- **BM25** (`src/bm25.ts`): SQLite FTS5/BM25, porter-stemmed, one row per
  symbol plus one row per non-code document *section*.
- **Docs lane** (`src/doc.ts`): non-code files (markdown/text read directly;
  Word/Excel/PowerPoint/OpenDocument/RTF/EPUB/PDF converted by
  `@firecrawl/anydoc` — a local Rust core, no LLM, no network) are indexed by
  their extracted text. Long documents are split into bounded sections
  (headings / paragraph runs, ≤4KB each, ≤40 per doc) that carry their source
  start and end line, so a 25KB file cannot bury its answer and `context
  expand` lands on the section that matched (a doc hit's range covers the
  whole section). They never enter the symbol graph; a matching doc carries a
  real BM25 score so a documentation query surfaces its document.
- Each hit's `reason` lists the signals that matched.

### Evaluation

`bun run eval` runs two task sets and reports per-task rows, not just
aggregates, so a retrieval change is accepted or rejected on real-data
evidence:

- `eval/tasks.json` — deterministic fixture subset (regression gates on
  known-shape repos; runs in CI, no network). Tasks record expected files,
  symbols, directories, edges, and changed files (dirty-tree gates), plus
  `bun run eval` enforces the serialized capsule budget per task (a violation
  exits 1).
- `eval/real-tasks.json` — reviewed tasks over pinned revisions of real
  repositories (gorilla/mux, express, flask), each recording query type,
  acceptable top-`k`, expected files/symbols, and why the answer is relevant.
  `bun run eval -- real` clones at the pinned revisions and reports
  baseline vs hybrid vs semantic (`--semantic`) with per-task regressions and
  raw JSON (`--json out.json`).

`bun run bench` is the variant idea checker: one pinned corpus, one budget,
four observation variants (flat hits / +DirMap / +neighborhood RepoMap /
+graph trails). It reports per-task deltas in file, directory, and trail
recall plus serialized tokens, so an observation change is accepted or
rejected per task rather than on an aggregate headline.

### Semantic fallback (optional, local)

Opt-in with `context config set semantic on` (or `CONTEXT_SEMANTIC=1`), wired
as a confidence-gated pipeline: exact/lexical → confidence gate → semantic
directory candidates → symbol/section candidates → rank fusion → bounded
graph expansion. A strong lexical pass (genuine term match or authoritative
signal) short-circuits the lane entirely — the embedding cost is only paid
for weak or empty queries. Directory records (path + public surface + lang)
are embedded alongside symbols and docs; on a weak query the semantic
directories lead the DirMap, and symbol hits append below the graph hits with
a `semantic` reason. When a query leaves terms unresolved, Context embeds the
query and symbol-level records with a local ONNX model
(`all-MiniLM-L6-v2` q8, ~23MB, runs on a typical dev laptop; override the
model with `context config set model <name>` or `CONTEXT_MODEL`) and appends
matches below the graph/lexical hits. Embeddings cover name + signature + doc
+ path + a bounded body snippet (≤20 lines) — the body is where undocumented
code keeps its semantics. Docs are embedded too (their extracted text). What's
stored, explicitly:

- **Embedded**: one vector per symbol (imports excluded) plus one per doc.
  Never whole files.
- **Cached**: float32 embeddings only, content-addressed by sha256 of the
  embedded text, in `~/.cache/context/semantic/<repo>-<model>.bin` (keyed by
  repo + `SEMANTIC_VERSION`). Edits re-embed only the changed records — line
  shifts and untouched files are zero-cost. Raw source never leaves the repo.
- **Not done**: no remote vector store, no hosted API, no silent network calls.
  The only network touch is the one-time model download from Hugging Face on
  first use. Model size, latency, and failure behavior are all visible; any
  failure degrades to the lexical/graph result.

Note: the semantic runtime boundary is explicit and enforced. The compiled
binary cannot load the ONNX runtime from its bundle, so when semantic is
enabled under the compiled runtime the command states so on stderr and
degrades to the lexical/graph result — it never fails and never silently
skips. The Bun source entrypoint (launcher fallback, installer source path)
runs the full lane. `context --version` reports which runtime you are on, and
`scripts/smoke.sh` verifies the boundary against a clean install.

Cache lives in `$XDG_CACHE_HOME/context` (default `~/.cache/context`). Every
cache/capsule/hook/semantic file is keyed by the canonical path of the
directory actually walked — the git repo root when a hook maps the whole repo,
otherwise the exact cwd/`--root` — so two checkouts, two sibling non-repo
dirs, or two agent accounts never collide, and a non-repo directory never
shares state with any other (`src/cache.ts`). Cache writes are atomic (unique
temp files) and fail-open: an unwritable cache directory never fails a
request. Incremental: only changed files reparse; extracted documents are
reused by CONTENT identity — a (size, mtime) match is only trusted when the
content hash agrees, so same-size or timestamp-preserving edits cannot leave
stale text. Parsing, document conversion, and embedding batches are bounded
by timeouts and fail open, so a slow converter or model never hangs a command.
Working-tree edits (staged, unstaged, untracked) are visible on the next call.

The installed command self-tests the compiled binary and falls back to the Bun
source entrypoint when the host cannot execute compiled binaries (wrong arch,
missing loader). See `scripts/mk-launcher.sh`.

## Invariants

- No model calls, annotations, embeddings, or API keys.
- No repository-local generated files; never writes into the project.
- Every assertion points to source and labels resolution quality.
- Deterministic output for a fixed tree + task.
- Emits `context:telemetry <json>` on stderr; all token counts are `estimated`.
- The capsule budget is truthful: measured on the final serialized form (both
  renderings), with a deterministic drop order (entry points → unresolved →
  files → DirMap → changed → next → hits); `tokensUsed` is the real cost,
  including its own literal.
- Observe is L0 → L1 → L2: a compact DirMap of the top task-affine
  directories first, then a neighborhood RepoMap (`map`), then exact evidence
  (`expand`/`find`). DirMap ranks directories by task affinity, never by
  symbol count alone.
- Changed files live in a bounded `changed` section, separate from task
  relevance; recent-change only boosts symbols the task is already about (or
  a query explicitly about recent work).
- Ambiguous symbol names surface qualified candidates (`file::name::line`);
  `follow`/`impact` never silently pick the first same-name symbol.
- The symbol graph stays authoritative: exact-name / recent-change /
  explicit-file hits pin the answer, and BM25/semantic matches append below.
  Docs (non-code) interleave only when they cover more query terms than the
  best code match, scored by their real BM25 (idf + length normalized) and
  floored by that coverage so a documentation query surfaces its document.
- Hub bonuses and 2-hop relation propagation are bounded (degree-capped), so
  a helper called by hundreds of tests can't drown a direct match.
- Imports are evidence edges, never ranking targets; tokenization
  (camelCase/snake_case) is computed once per graph, memoized across queries.
- Doc conversion (anydoc) and semantic inference are local and opt-in; no
  silent network calls during discovery.
- Parsing, conversion, and embedding work is time-bounded and fail-open: a
  slow stage degrades the output, never hangs the command.
- Retrieval changes ship with reproducible evidence: `bun run eval` per-task
  regressions on pinned real revisions, `bun run bench` budgets + preserved
  failure corpus.

## Hooks (host adapters, both fail open)

- `scripts/hook-user.ts` — UserPromptSubmit: injects one compact capsule per
  (task, working-tree) pair; never rewrites commands or mutates the repo.
- `scripts/hook-agent.ts` — agent-response (Claude Code `Stop`): reads the
  projected savings the user hook stored and emits a Graft-style
  `~X tokens saved (Y%, net ~Z after capsule)` line. **User-visible only** —
  it is telemetry, never injected back into the model context.

Savings projection (`src/savings.ts`) estimates the input tokens the capsule
replaces (its pointed-at source spans) minus capsule tokens; `estimated`, per
the plan's token accounting. The runtime decision (Bun over Rust) is recorded
in `spike/README.md`; the retrieval baseline lives in `eval/`. Retrieval
results on pinned real revisions are reproducible via `bun run eval -- real`;
agent-task (end-to-end) usefulness measurement is the next step, not yet
claimed.

See `skill/SKILL.md` for the host-neutral agent skill.
