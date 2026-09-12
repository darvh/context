# Context

Deterministic discovery compiler for coding agents. Turns a task plus the current working tree into a small, source-backed context capsule — the deterministic core needs no model, no embeddings, and no repo-local state (an opt-in local semantic lane exists for weak queries).

Bun/TypeScript MVP, Tree-sitter for Go / TypeScript / JavaScript / Python (bespoke walkers) plus Java / Ruby / Rust / C / C++ / C# / PHP / Bash (shared generic walker), plain external content-addressed cache, deterministic lexical + graph ranking.

## Core principles

- **Local-first:** exact lookup, filters, and the semantic lane all run on-device — no remote index, no hosted search.
- **Progressive:** the exact/lexical pass answers first; the embedding lane runs only when lexical evidence is weak, so extra work happens only when it can change the answer.
- **One result model:** ranked hits backed by provenance, per-hit confidence, and handles that fetch exact spans — one capsule, no separate human/agent results.
- **Hybrid where it pays:** lexical and graph ranking always; embeddings as an opt-in local lane for weak queries.
- **Incremental content-addressed cache:** only changed files reparse; schema-versioned snapshots replace atomically.
- **Evidence over answers:** generation stays outside the search kernel, keeping retrieval fast, inspectable, and model-independent.
- **Native operations:** search, filter, traverse, compare, and fetch — no UI to scrape.

## Commands

```text
context observe "<task>" [--budget N] [--json] [--root DIR]
               [--ignore pat[,pat]] [--no-gitignore]
context map <directory> [--root DIR]
context follow <symbol|qualified-id> [<edge>|symbol2] [--root DIR]
context expand <handle|file:line> [--root DIR]
context read <file> [--root DIR]
context impact <symbol|qualified-id|--diff> [--json] [--root DIR]
               [--ignore pat[,pat]] [--no-gitignore]
context init [--targets all|opencode,claude-code,codex,cursor,copilot,antigravity,pi]
             [--project] [--force] [--dry-run] [--hooks]
context config get [key]
context config set <key> <value>     keys: semantic on|off, model <name>
context --help
context --version   prints version, build commit, cache schema, runtime kind
```

`observe` is orientation: DirMap, neighborhoods, spans, and a `confidence` label (`strong` / `weak` / `conflicted` / `empty`). `map` compiles a bounded local RepoMap over one directory (per-file symbols, calls, tests). `follow` walks one edge kind (call, import, inherit, implement, ref, contain, test, all) with bounded depth and short trails; caller/callee analysis is `impact`'s job. `follow <symbol> <symbol2>` renders the minimal connecting subgraph between two symbols. `impact` is the symbol map (callers/callees/relations/tests + `documented_by` docs) plus `--diff`. Ambiguous bare names list their qualified candidates (`file::name::line`) instead of silently picking the first.

`--targets` rejects unknown agent names (exit 1, lists known targets). `context config` reads/writes `~/.config/context/config.json` (honors `XDG_CONFIG_HOME`); it never touches the repository.

## Install

### macOS, Linux, or WSL

```bash
curl -fsSL https://raw.githubusercontent.com/darvh/context/main/install.sh | bash
```

The installer is binary-first: it selects the matching release ZIP for the
current OS and architecture, verifies its published SHA-256, unpacks to
`~/.local/share/context` (honoring `XDG_DATA_HOME` and `CONTEXT_HOME`), and
writes a launcher to `~/.local/bin` (adds it to your shell `PATH`; opt out with
`--no-modify-path`). If no release is available — or with `--from-source` — it
falls back to a source install and requires Bun. Hooks are self-hosted by the
compiled binary, so `--hooks` (on by default) no longer forces a source build;
`--no-hooks` opts out. Useful flags: `--local`, `--targets <agents>`,
`--version <tag>`, `--force`/`--no-force`, `--dry-run`, `--uninstall`, and
`--help`. The skill follows the `skills/<name>/SKILL.md` convention, so it is
discoverable by `gh skill install darvh/context`.

### From a checkout

```bash
bun run install:local
```

Forward installer options after `--`, for example:

```bash
bun run install:local -- --targets pi --force
```

`context init` installs the host-neutral skill into each agent's skill directory (same matrix as proof: opencode, claude-code, codex, cursor, copilot, antigravity, pi), user or project scope. Idempotent: identical copies are `up-to-date`, conflicts are skipped unless `--force`. Manual init reports absent home-scope agent dirs as `agent-miss` and never creates silently; the installer probes each agent's config dir / PATH binary and only targets agents that are actually installed. `--hooks` is the default and wires the UserPromptSubmit / SessionStart / PostToolUse adapters; `--no-hooks` opts out. The compiled binary self-hosts those adapters, so hook wiring needs neither Bun nor a scripts/ directory. The one-line steering instruction installs into each hook-less host's instructions file: home scope only where the host natively reads a global file (opencode's `~/.config/opencode/AGENTS.md`, seeded from `~/.claude/CLAUDE.md` when created so existing instructions are never shadowed), project scope as the shared repo-root `AGENTS.md` (one marker block).

## Releases

Push a semantic version tag such as `v0.1.0`, or run the Release workflow from `main` with a tag input. The workflow publishes one ZIP per supported target:

- Linux x64 and arm64
- macOS x64 and arm64
- Windows x64

Each ZIP contains the standalone `context` binary (grammars and skill embedded),
the source tree for the Bun fallback, and a `.sha256` checksum file. The
onnxruntime shared library is bundled only for Linux x64 (the release build
host); elsewhere the semantic lane degrades to the lexical/graph result.

## Development

```text
bun install
bun run context observe "where is session persistence handled?" --root <repo>
bun test               # unit + smoke (launcher, cache safety, incremental)
bun run fixture        # generate the deterministic large-repo fixture (small)
bun run eval           # retrieval eval -> fixture subset (CI, no network)
bun run eval -- real   # + pinned real repos (clones at fixed revisions)
bun run bench          # observation ablation: flat / DirMap / RepoMap / trails
bun run dup            # jscpd duplication check (src + eval scripts)
bun run unused         # knip unused-code check
bun run build          # standalone binary -> ./dist/context
bash scripts/smoke.sh ./dist/context   # clean-environment smoke suite
```

## Retrieval

The authoritative lane fuses graph relationships, changed-file, explicit-path, entry-point, and exact-name signals; BM25 and the optional semantic lane append below, never re-rank. Each hit's `reason` lists the signals that matched.

- **Graph + lexical** (`src/rank/query.ts`): symbol terms are name + signature + doc + path + bounded **runtime strings** from the symbol body (so a query quoting an error/log/config string matches lexically) + **irregular-form expansion** (`kept` → `keep`). Propagation is 2-hop, degree-capped; imports are evidence edges, never ranking targets.
- **Intent-gated lanes** (only fire when the task asks):
  - *diagnostic-first*: a task naming a failing test verbatim pins it (`test-name-pin`), stack `file:line` refs are explicit-file pins;
  - *negative constraints*: "not tests", "without legacy", "only config under X" penalize the excluded scope before propagation;
  - *recent-change*: only boosts files the task is already about (or an explicit recent-work query); dirty files live in a bounded `changed` section, separate from relevance;
  - *co-change*: for explicit history/regression intent, files that changed together in the last commits boost each other;
  - *session-delta*: when `CONTEXT_SESSION_ID` is set, symbols already shown in that agent session get a novelty penalty (disposable per-tree state, no profiling).
- **BM25** (`src/rank/bm25.ts`): SQLite FTS5/BM25, porter-stemmed, one row per symbol plus one row per non-code document *section*.
- **Typed artifacts** (`src/out/artifacts.ts`): env vars (`process.env.X`, `os.Getenv(...)`, `ENV[...]`, ...) and config keys (`config.get("key")`) become first-class config symbols, so `DATABASE_URL` resolves exactly.
- **Docs lane** (`src/core/doc.ts`): prose/markup files are indexed by extracted text; HTML is normalized to Markdown locally, while Word/Excel/PowerPoint/OpenDocument/RTF/EPUB/PDF are converted by `@firecrawl/anydoc` (a local Rust core, no LLM, no network). JSON/XML/YAML/TOML/INI/CSV remain readable through `context read` but stay out of the prose docs lane. Long documents are split into bounded sections (headings / paragraph runs, ≤4KB each, ≤40 per doc) that carry their source start and end line, so a 25KB file cannot bury its answer and `context expand` lands on the section that matched (a doc hit's range covers the whole section; binary formats expand from the cached extracted Markdown, never raw bytes). `context read <file>` dumps the cached normalized Markdown for HTML/binary documents and the original text for structured files. They never enter the symbol graph; a matching doc carries a real BM25 score so a documentation query surfaces its document.
- **Code↔doc links** (`src/graph/links.ts`): exact-token/path mentions of exported symbols in document sections produce deterministic links; `impact` shows `documented_by`.
- **Compiler-backed overlay** (`src/graph/overlay.ts`, `src/graph/scip.ts`): a binary SCIP index (`index.scip`) or a documented JSON facts file (`.context/facts.json`) merges into the tree-sitter graph — exact definitions, references, and implementations upgrade confidence. Tree-sitter behavior is unchanged when no overlay exists; Context never generates indexes itself.

### Budget-aware packing

The capsule is selected by utility per serialized token — relevance × confidence × novelty — with authoritative pins first and minimal orientation (top directory + top hit) guaranteed. The budget is truthful: measured on the final serialized form (both renderings); `tokensUsed` is the real cost, including its own literal.

### Evaluation

`bun run eval` runs two task sets and reports per-task rows, not just aggregates, so a retrieval change is accepted or rejected on real-data evidence. Per task it measures: file/symbol recall, MRR, exact-evidence-range recall, unrelated items in the capsule (pure dirty-driven hits; 0 across the pinned corpus), calls-to-evidence (rank of the first expected file), serialized tokens vs budget (a violation exits 1), plus cold/warm latency and index size.

- `eval/tasks.json` — deterministic fixture subset (regression gates on known-shape repos; runs in CI, no network). Tasks record expected files, symbols, directories, edges, evidence ranges, dirty files, and semantic needle queries (reported separately as ceiling tasks, never as misses).
- `eval/real-tasks.json` — reviewed tasks over pinned revisions of real repositories (gorilla/mux, express, flask). `bun run eval -- real` clones at the pinned revisions and reports baseline vs hybrid vs semantic (`--semantic`) with per-task regressions and raw JSON (`--json out.json`).

`bun run bench` is the observation ablation: retrieval is shared, and flat / DirMap / RepoMap / trails vary what the agent observes, each against a declared budget (observe 1200; map/trails follow-up calls 400 each, reported separately). A variant ships only when recall does not regress and it stays within its budget.

### Semantic fallback (optional, local)

Opt-in with `context config set semantic on` (or `CONTEXT_SEMANTIC=1`), wired as a confidence-gated pipeline: exact/lexical → confidence gate → semantic directory candidates → symbol/section candidates → rank fusion → bounded graph expansion. A strong lexical pass (genuine term match or authoritative signal) short-circuits the lane entirely — the embedding cost is only paid for weak or empty queries. Directory records (path + public surface + lang) are embedded alongside symbols and docs; on a weak query the semantic directories lead the DirMap, and symbol hits append below the graph hits with a `semantic` reason. When a query leaves terms unresolved, Context embeds the query and symbol-level records with a local ONNX model (`all-MiniLM-L6-v2` q8, ~23MB, runs on a typical dev laptop; override the model with `context config set model <name>` or `CONTEXT_MODEL`) and appends matches below the graph/lexical hits. Embeddings cover name + signature + doc
+ path + a bounded body snippet (≤20 lines) — the body is where undocumented
code keeps its semantics. Docs are embedded too (their extracted text). What's stored, explicitly:

- **Embedded**: one vector per symbol (imports excluded) plus one per doc. Never whole files.
- **Cached**: float32 embeddings only, content-addressed by sha256 of the embedded text, in `~/.cache/context/semantic/<repo>-<model>.bin` (keyed by repo + `SEMANTIC_VERSION`). Edits re-embed only the changed records — line shifts and untouched files are zero-cost. Raw source never leaves the repo.
- **Not done**: no remote vector store, no hosted API, no silent network calls. The only network touch is the one-time model download from Hugging Face on first use. Model size, latency, and failure behavior are all visible; any failure degrades to the lexical/graph result.

Note: the semantic lane runs in both runtimes. The compiled binary embeds the onnxruntime native binding (vendored `.node`, resolved via tsconfig paths) and loads its runtime library from the file beside the binary (`libonnxruntime.1.24.3.dylib` / `libonnxruntime.so.1`), so the installed system needs neither Bun nor Node — the binary self-hosts everything, including the hook adapters (`context hook-user` / `hook-agent` / `hook-session`). Any embedding or model failure degrades to the lexical/graph result, never a crash. On hosts that cannot execute compiled binaries, the launcher falls back to the Bun source entrypoint (documented last resort; the source path also needs Bun for installs from a checkout).

## Cache

Cache lives in `$XDG_CACHE_HOME/context` (default `~/.cache/context`). Every cache/capsule/hook/semantic file is keyed by the canonical path of the directory actually walked — the git repo root when a hook maps the whole repo, otherwise the exact cwd/`--root` — so two checkouts, two sibling non-repo dirs, or two agent accounts never collide, and a non-repo directory never shares state with any other (`src/core/cache.ts`). Cache writes are atomic (unique temp files) and fail-open: an unwritable cache directory never fails a request. Incremental: only changed files reparse; extracted documents are reused by CONTENT identity — a (size, mtime) match is only trusted when the content hash agrees, so same-size or timestamp-preserving edits cannot leave stale text. Parsing, document conversion, and embedding batches are bounded by timeouts and fail open, so a slow converter or model never hangs a command. Working-tree edits (staged, unstaged, untracked) are visible on the next call.

Git is optional: without a git binary every lane fails open (no changed context, `git_head` omitted, co-change dormant) and retrieval is unaffected.

The installed command self-tests the compiled binary and falls back to the Bun source entrypoint when the host cannot execute compiled binaries (wrong arch, missing loader). See `scripts/build/mk-launcher.sh`.

## Invariants

- No model calls, annotations, embeddings, or API keys (semantic is opt-in).
- No repository-local generated files; never writes into the project.
- Every assertion points to source and labels resolution quality.
- Deterministic output for a fixed tree + task.
- Emits `context:telemetry <json>` on stderr; all token counts are `estimated`.
- The capsule budget is truthful: measured on the final serialized form (both renderings); `tokensUsed` is the real cost, including its own literal.
- Observe is L0 → L1 → L2: a compact DirMap of the top task-affine directories first, then a neighborhood RepoMap (`map`), then exact evidence (`expand`). DirMap ranks directories by task affinity, never by symbol count alone; the capsule reports its confidence (`strong`/`weak`/ `conflicted`/`empty`).
- Changed files live in a bounded `changed` section, separate from task relevance; recent-change only boosts symbols the task is already about (or a query explicitly about recent work).
- Ambiguous symbol names surface qualified candidates (`file::name::line`); `follow`/`impact` never silently pick the first same-name symbol.
- The symbol graph stays authoritative: exact-name / recent-change / explicit-file hits pin the answer, and BM25/semantic matches append below. Docs (non-code) interleave only when they cover more query terms than the best code match, scored by their real BM25 (idf + length normalized) and floored by that coverage so a documentation query surfaces its document.
- Hub bonuses and 2-hop relation propagation are bounded (degree-capped), so a helper called by hundreds of tests can't drown a direct match.
- Imports are evidence edges, never ranking targets; tokenization (camelCase/snake_case) is computed once per graph, memoized across queries.
- Doc conversion (anydoc) and semantic inference are local and opt-in; no silent network calls during discovery.
- Parsing, conversion, and embedding work is time-bounded and fail-open: a slow stage degrades the output, never hangs the command.
- Retrieval changes ship with reproducible evidence: `bun run eval` per-task regressions on pinned revisions, `bun run bench` budgets per variant.

## Hooks (host adapters, all fail open)

Wiring is per-host, matching what each agent actually supports:

| Host | Skill | SessionStart | UserPromptSubmit | PostToolUse | Statusline |
|---|---|---|---|---|---|
| claude-code | ✓ | ✓ orientation | ✓ capsule | ✓ blast radius | ✓ (only host with a statusLine channel) |
| codex | ✓ | ✓ (matcher `startup\|resume\|compact`) | ✓ capsule | ✓ blast radius (`systemMessage`) | — |
| opencode | ✓ | — (no hook) | compaction plugin | ✓ blast radius (`tool.execute.after`) | — |
| cursor / copilot / antigravity / pi | ✓ | — | — | — | — |

- `scripts/hook-user.ts` — UserPromptSubmit: injects one compact capsule per (task, working-tree) pair: DirMap cards first (task-affine directories, plus the directories of any attached files, marked `[attached]`), then paths and relevant symbols — symbols already shown this session are flagged `(already shown)` (one-time full orientation, then only what is new). Never rewrites commands or mutates the repo. A cheap repo-affinity gate skips the build entirely for pure-chat prompts (no shared term with any cached file path or symbol name). The same hook folds the projected savings into the per-session running total the statusline shows.
- `scripts/hook-edit.ts` — PostToolUse on Write/Edit/MultiEdit (Claude Code) or apply_patch (Codex): computes the blast radius of the edited file (symbols in it that other files depend on) and marks the graph dirty, which drives the statusline's `⚠ N stale` badge. Claude Code gets it injected via `hookSpecificOutput.additionalContext`; Codex has no PostToolUse additionalContext, so it surfaces the same text as `systemMessage`.
- `scripts/hook-session.ts` — SessionStart: a session-start orientation — "reach for `context observe` first" directive plus a compact repo overview (top directories by size, symbol/edge totals) built from the incremental graph, bounded by a 6s timeout. Emitted as `additionalContext` JSON, which both Claude Code and Codex accept.
- `statusline` (Claude Code only) — live `statusLine`/`subagentStatusLine`: `context · N symbols / M edges · fresh | ⚠ N changed · saved ~N tok`, plus `ctx N%` and the last edited file. Reads the hook-maintained cache only — a pure read, no subprocess, so the host's per-render call stays cheap.
- opencode plugin — wires blast radius onto opencode's `tool.execute.after` for `edit`/`write`/`apply_patch` and keeps the capsule alive across compaction.

There is no Stop/agent hook: Claude Code does not render Stop output, and the session token savings already live in the statusline, so the per-turn line was removed.

Savings projection (`src/out/savings.ts`) estimates the input tokens the capsule replaces — the whole files its hits point at, capped (≤4 files, ≤4KB each, ≤12KB total) minus capsule tokens, labeled `estimated` everywhere. The runtime decision (Bun over Rust) is recorded in the commit history; the retrieval baseline lives in `eval/`. Retrieval results on pinned real revisions are reproducible via `bun run eval -- real`; agent-task (end-to-end) usefulness measurement is the next step, not yet claimed.

See `skills/context/SKILL.md` for the host-neutral agent skill.

## Acknowledgments

The agent-integration layer — skill wiring, per-event hooks, the statusline, and post-edit dependents — is inspired by [graft](https://github.com/NanoNets/Graft) (same job: stop agents from re-exploring a repo every session; similar wiring). The engine underneath is deliberately different:

- **No LLM, no key.** graft's prose node graph is written by a model optionally through your provider key; context is deterministic tree-sitter + lexical/graph ranking, `$0` end to end. The semantic fallback is opt-in and runs a local ONNX model — no hosted API.
- **No repo-local state.** graft writes `graft/` into the repository; context keeps everything in `~/.cache/context` and never touches the project.
- **Different retrieval.** Context packs capsules by utility per token, session-delta novelty, BM25 + a local semantic lane, an SCIP/compiler overlay, and a docs lane with code↔document links — none of which graft ships.
