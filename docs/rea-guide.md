# REA (Reverse Engineer Anything) — Guide

Official sources only: github.com/morluto/rea, rea.tools, npm `rea-agents` (maintainer: morluto).

There is no separate "REA agent" process. REA = **MCP server + CLI + `reverse-engineer-anything` skill**, which turns your existing coding agent (Claude Code, Codex, Cursor, Gemini CLI, Grok Build, ...) into an evidence-aware reverse-engineering agent.

| Piece                             | What it does                                                                                                                                                | Where it goes                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| MCP server (`rea mcp`)            | Gives the agent tools (`analyze_javascript_application`, `decompile`, `xrefs`, process capture, ...)                                                        | Agent config (e.g. `~/.cursor/mcp.json`, `~/.claude.json`)            |
| Skill `reverse-engineer-anything` | `SKILL.md` + references (native, JS, Android, runtime, evidence workflows) telling the agent when/how to use the tools, handle Evidence, page large results | Agent skills dir (e.g. `~/.agents/skills/reverse-engineer-anything/`) |

Without the skill the tools exist but get used poorly.

## Contents

1. [Setup](#setup)
2. [Usage](#usage)
   - [Best way to use REA (agent-driven)](#best-way-to-use-rea-agent-driven)
   - [CLI Evidence patterns](#cli-evidence-patterns)
   - [Limits and obfuscation](#limits-and-obfuscation)
3. [Evidence model](#evidence-model)
   - [Evidence records](#evidence-records)
   - [Residual unknowns](#residual-unknowns)
   - [Hashing and identity (SHA-256)](#hashing-and-identity-sha-256)
   - [Evidence Bundle](#evidence-bundle)
4. [Obligation Ledger](#obligation-ledger)
   - [Overview](#overview)
   - [Closure](#closure-semantics)
5. [Architecture patterns](#architecture-patterns)
   - [Related patterns](#related-patterns)
6. [Design implications](#design-implications)
   - [For agents and users](#for-agents-and-users)
   - [For reconstruction and verification](#for-reconstruction-and-verification)
   - [For tooling and workflow](#for-tooling-and-workflow)
   - [Trade-offs](#trade-offs)
7. [Version history](#version-history)

## Setup

Setup connects a local agent to the REA server and can install the workflow skill. It shows the planned file changes and waits for approval before writing configuration. Ghidra and IDA are bring-your-own; setup can optionally install Hopper with separate approval.

Requirements, supported agents, and engine configuration are in [Installation and setup](getting-started/installation.md). Windows analysis has its own boundary in [Windows Ghidra P0](providers/windows-ghidra-p0.md).

## Usage

### Best way to use REA (agent-driven)

1. Run setup once (`npx rea-agents setup` or `rea setup`), pick your agent, review proposed changes, approve.
2. Restart the agent so the MCP server and skill load.
3. Prompt with a **narrow, concrete question plus an acceptance criterion**, e.g.:
   - "Understand how search works in the Notes app, show me the evidence, and build a similar feature for my project."
   - "Use REA to inspect this binary. Why does 200 + 10% give 220? Cite the Evidence IDs and label each conclusion as observation, inference, or unknown."
   - "Analyze this Electron app. Find the renderer-to-main IPC path for clipboard writes, show the evidence, and list what remains uncertain."

#### Practical tips

- One specific behavior/feature at a time, not "reverse engineer the whole app".
- Static analysis first; runtime/process capture only when needed, in a safe environment.
- Ask the agent to cite Evidence IDs and label observation / inference / unknown, and list limitations.
- Only software you own or are authorized to examine.
- Keep updated: `rea update` (then re-run the setup command it prints) — REA ships frequently.
- For large targets use summaries / paged views instead of loading everything.

### CLI Evidence patterns

Each CLI call is a separate process, so save results to reuse them. Import, export, comparison, and saved views are in [CLI and Evidence](getting-started/cli.md#import-export-and-compare-evidence). Large results should be saved, then read through summaries or pages rather than loaded whole. Snapshots reuse an exact prior result when the target bytes, operation, and parameters match.

### Limits and obfuscation

REA has **no dedicated automatic deobfuscator**.

- **Native**: pseudocode, asm, strings, symbols, xrefs. Light protections are often workable. Strong packers, control-flow flattening, virtualization and anti-analysis leave stubs — decompiling an unpacking stub does not recover the program. The agent can write Ghidra/IDA scripts, use Frida runtime observation, and combine static + dynamic evidence.
- **JS/Electron**: recovers modules, imports, IPC, source maps (Wakaru in some paths). Minified code is partly usable via the semantic graph; heavy obfuscation means more unknowns and manual cleanup.
- **General**: every result carries evidence, confidence and limitations — you must verify. Commercial (especially Android) packers are a known gap. **Runtime analysis is NOT sandboxed** and runs with your permissions: use an isolated environment. Lawful use only.

## Evidence model

### Evidence records

A record is one observation: who produced it, what it looked at, what it returned, how confident that result is, and what it could not establish. Conclusions stay attached to that record instead of floating free of it.

Every record and every exported bundle declares `evidence_format: 2`. Readers refuse a missing or different revision. The subject names its target in `subject.identity`. `subject.name` and `subject.local_path` are display facts, not the identity. The Evidence ID commits to `subject.identity` and the rest of the semantic observation. It does not commit to `evidence_format`, the ID itself, the display facts, or caller-selected input paths. Import recomputes the ID and rejects a mismatch.

The record contract, including `evidence_format` and `subject.identity`, is in [MCP runtime contracts](reference/mcp-contracts.md#retained-application-evidence-inputs). Retained views, import, and export are in [CLI and Evidence](getting-started/cli.md#import-export-and-compare-evidence).

### Residual unknowns

A residual unknown is a versioned question that the observation did not answer. Its status is `open`, `investigating`, `blocked`, `contradicted`, or `resolved`. Supporting and contradicting Evidence stay linked, and a resolution is present only when the question is closed. The stable ID commits to the question, domain, and scope digest, and also to a comparison-conclusion scope when the unknown has one.

Session tools create and replace these records. `update_unknown` replaces the current head; it is not a patch. Resolving the unknown record does not, by itself, clear an obligation that still lists that ID. That behavior is part of the [reconstruction obligation ledger](reference/reconstruction-obligation-ledgers.md). Tool behavior for recording and updating unknowns is in [MCP runtime contracts](reference/mcp-contracts.md#tool-results).

### Hashing and identity (SHA-256)

Evidence IDs, unknown IDs, and ledger digests are SHA-256 over canonical JSON, so the same inputs produce the same ID and a changed input produces a different one. For an Evidence record, the hashed subject is `subject.identity`, not a separate digest, format, or architecture field on the subject. A file identity's byte hash is `subject.identity.sha256`. Changing those bytes changes every Evidence ID that commits to that identity.

`ledger_id` and `closure_digest` identify one complete ledger evaluation. Their fields and closure rules are owned by [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md).

#### Background: SHA-256 collision resistance

SHA-256 gives a 256-bit digest. Collision resistance is bounded by the birthday paradox at about \(2^{128}\) operations; preimage and second-preimage resistance stay at \(2^{256}\). As of 2026, full 64-round SHA-256 has no known practical collision. Published attacks reach only reduced-round versions (practical collisions around 31 steps, research results around 37–38 steps), and they don't extend to the full algorithm. It remains the standard for integrity, content addressing, Merkle trees, and signatures, which is why REA's IDs can rely on it. (It's unsuitable for password hashing because it's too fast; use memory-hard functions there.)

### Evidence Bundle

The portable, content-addressed container for the observational layer: what you export, import, compare, and feed into ledgers.

| Section                                                         | Contents                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **records**                                                     | Immutable records (`ev_…`) with `evidence_format: 2`. The subject is `subject.identity`. Each record also carries the producer, operation, parameters, results, confidence, authority, environment, limitations, and locations. |
| **unknowns**                                                    | Residual unknowns (`unk_…`) with revision history, status, severity, supporting and contradicting Evidence IDs, and a resolution when closed.                                                                                   |
| **artifacts / providers / environments / scenarios / captures** | Supporting inventory: artifact digests, provider identities, execution environments, recorded scenarios, process and runtime captures.                                                                                          |

**Invariants**

- IDs are content-addressed. `evidence_id` omits subject `name` and `local_path`, and the ID field itself. Paths inside parameters, results, and locations stay in the hash.
- Import recomputes IDs and rejects tampering or conflicting duplicates.
- A bundle is not secret-free. REA redacts transport authentication credentials and values the caller explicitly marks sensitive. It does not infer secrecy from names or text. Sensitive process-capture input has its own representation in [Process capture](guides/runtime/process-capture.md). Inspect a capture before sharing its bundle.
- Canonical export is deterministic JSON with stable key order.
- Snapshots keep exact prior results when target bytes, operation, and parameters match.

The bundle is the source of truth for observations; it doesn't decide whether a reconstruction claim is proven.

#### Bundle vs. unknowns registry vs. obligation ledger

| Aspect               | Evidence Bundle                               | Residual Unknowns Registry                          | Obligation Ledger                                                                                                                      |
| -------------------- | --------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose              | Store immutable observations and provenance   | Track open questions and how they evolve            | Decide which reconstruction claims are proven                                                                                          |
| Identity             | Collection of `ev_…` and `unk_…` records      | Versioned `unk_…` heads with revision digests       | `ledger_id` + `closure_digest` over the complete result                                                                                |
| Mutability           | Immutable records; new ones are added         | Revisioned, append-only history                     | Derived; rebuilt from the bundle, reviewed obligations, and manifest                                                                   |
| What it proves       | "Observed or inferred under these conditions" | "Still open, or resolved by these Evidence IDs"     | Per-obligation status (`verified`, `unowned`, `blocked`, `out-of-scope`, …) and a ledger status (`ready`, `open`, `failed`, `unknown`) |
| Closure              | None (observations only)                      | `resolved` with a resolution object citing Evidence | Status `verified`: unique owner, fixtures, and a passing verifier of comparable authority                                              |
| Disposition handling | Explicit limitations and unknowns fields      | Status + resolution                                 | Input `disposition` on reviewed obligations; derived output `status`; blocked and out-of-scope never count as verified                 |
| Relationship         | Input to the other two                        | Linked from obligations via `residual_unknown_ids`  | Consumes the bundle, reviewed obligations, and manifest; unknowns keep claims open                                                     |

**How they fit:** the bundle captures what was observed and what's unknown; the unknowns registry makes open questions durable and versioned; the obligation ledger consumes the bundle, reviewed obligations, and a manifest and gives a deterministic verdict whose `closure_digest` covers every obligation, status, unknown link, and Evidence reference. The ledgers build on the bundle without replacing the original records.

## Obligation Ledger

### Overview

- Built by `build_reconstruction_obligation_ledger` (MCP) or `rea build-reconstruction-obligation-ledger` (CLI) from an Evidence bundle, reviewed obligations, and a manifest.
- Application-graph and process-capture records can generate candidate obligations. A manifest binding is supplied by the caller. A reviewed obligation is for a claim the bundle does not already generate.
- Static graph facts create **candidate** obligations only. They don't prove runtime behavior. The ledger is conservative.

The ledger is identified by a deterministic `ledger_id` (`rol_…`) and `closure_digest`. The request, dispositions, statuses, and proof rules are in [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md).

```
Evidence Bundle (ev_ records | unk_ unknowns | captures/artifacts/providers)
        |
        v
build_reconstruction_obligation_ledger
  - static graph and process captures -> candidate obligations
  - manifest supplies owners, fixtures, verifiers
  - unknowns/contradictions keep claims open
        |
        v
Obligation Ledger (obligations e.g. protocol.rpc.cancel; per-obligation status; ledger status; ledger_id rol_… + closure_digest)
```

The text diagram above is the flow. The image in [Layered architecture (image)](#layered-architecture-image) is the same model. VitePress does not render Mermaid.

| Input                                                                                      | Role                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence records (`ev_…`), residual unknowns (`unk_…`), captures, artifacts, and providers | Evidence bundle                                                                                                                           |
| Reviewed obligations                                                                       | Input disposition `active`, `blocked`, or `out-of-scope`, for claims the bundle does not already generate                                 |
| Manifest                                                                                   | Bindings (owners, fixtures, verifiers) and contradictions                                                                                 |
| `build_reconstruction_obligation_ledger`                                                   | Turns graph and process-capture facts into candidate obligations. Unknowns and contradictions keep claims open.                           |
| Obligation ledger                                                                          | Per-obligation status, `residual_unknown_ids`, diagnostics, Evidence ID links, ledger status, `ledger_id` (`rol_…`), and `closure_digest` |

#### Reading the diagram

1. **Evidence bundle.** Holds the raw inputs: evidence records (`ev_…`, immutable observations with provenance, confidence, locations, and limitations), residual unknowns (`unk_…`, versioned open questions linked to supporting and contradicting Evidence), and supporting artifacts, captures, and provider metadata.
2. **`build_reconstruction_obligation_ledger`.** Takes the bundle, the reviewed obligations (each with an input `disposition`), and a manifest. Application-graph and process-capture records become _candidate_ obligations. A listed residual-unknown ID, missing authority, or a contradiction keeps a claim from reaching `verified`. The ledger does not consult the unknown's status.
3. **Obligation ledger.** Lists reconstruction claims, each with a derived output `status` and `diagnostics`. An obligation reaches `verified` only from a sufficient manifest binding. The proof contract is [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md). The ledger also gets an overall status and is identified by `ledger_id` (`rol_…`) and `closure_digest`.

This structure lets agents and humans tell apart "we observed this," "this remains unknown," and "this reconstruction claim is proven."

#### Layered architecture (image)

![REA evidence model: Evidence Bundle (content-addressed Evidence records and versioned residual unknowns with statuses open, investigating, blocked, contradicted, resolved) feeding build_reconstruction_obligation_ledger, which derives the Obligation Ledger (ledger_id rol_…, closure_digest) and its per-obligation statuses unowned, characterized, implemented, verified, contradicted, blocked, out-of-scope, unknown](./assets/rea-evidence-model.jpg)

_Caption: the IDs in the image are shortened placeholders; real `unk_` IDs are `unk_` + 64 hex characters. The image is an overview. The contracts are the linked reference pages._

The ledger as a whole carries `ledger_id` (`rol_…`) + `closure_digest`, which identify the complete result. Each reviewed obligation is submitted with an input disposition (`active`, `blocked`, `out-of-scope`); each output obligation has a derived `status`, `diagnostics`, `residual_unknown_ids`, and evidence links (`ev_…`). `blocked` and `out-of-scope` do not count as verified. See [Closure semantics](#closure-semantics).

### Closure semantics

An obligation reaches `verified` only when one manifest binding supplies a unique owner, the required fixtures, and a passing verifier of comparable authority. Static observations can create candidates. They do not prove the claim by themselves. `blocked` and `out-of-scope` stay visible and do not count as verified. A listed residual-unknown ID keeps the claim open even after that unknown record is resolved.

Request shape, reviewed obligations, manifest bindings, proof applicability, and closure status are owned by [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md).

## Architecture patterns

A few consistent patterns run through REA's Evidence model, MCP/CLI surface, and session handling.

### 1. Content-addressed, immutable Evidence

Each observation is an immutable record whose `evidence_id` (`ev_…`) is a SHA-256 of the canonical semantic projection in [Hashing and identity](#hashing-and-identity-sha-256). That projection commits to `subject.identity`. `subject.name` and `subject.local_path` are display fields and are not hashed. Paths inside parameters, results, and locations are. The same projection always gives the same ID, and import recomputes it and rejects tampering or conflicting duplicates. This gives deduplication and exact reuse (snapshots, comparisons), tamper-evident records, and stable citations. Residual unknowns follow a similar revisioned pattern (`unk_…` IDs with digest chains).

### 2. Provider-neutral domain with adapter boundaries

Public tool names and Evidence schemas are provider-neutral. Ghidra, Hopper, IDA, JADX, the JS analyzer, and others are adapters producing the same Evidence shape. Domain and application layers hold no provider-specific code, and dependencies flow inward (domain, adapters, workflows, CLI/MCP). The JavaScript Application Graph is a pure, side-effect-free domain model that validates facts and derives identities without I/O.

### 3. Session-owned Evidence ledger

Each MCP connection (or CLI process) owns an in-memory `EvidenceLedger` of immutable records and unknown revisions. Tools return Evidence inline and retain it in the session. `analyze_function` returns summary Evidence by default and keeps the complete dossier retained; [MCP runtime contracts](reference/mcp-contracts.md#tool-results) says how to select that dossier. `retained-evidence` references are scoped to the connection. Export produces a portable Evidence Bundle; import validates and merges atomically. Agents can cite earlier results without re-running them, and full export still supports offline or cross-session use.

### 4. Fail-closed and explicit unknowns

Missing coverage is recorded as unknown, not absence. Limitations are first-class fields, and residual unknowns stay linked instead of being dropped. The contribution rule is fail-closed: don't integrate a capability while material scope, authority, side-effect, or verification questions remain unresolved. Unresolved identity or applicability stays unknown rather than treated as absent or aligned.

### 5. Conservative derived ledgers

The obligation ledger is a deterministic projection over an Evidence bundle, reviewed obligations, and a manifest. Static graph facts create candidates only. Reaching `verified` needs a unique owner, required fixtures, and a passing verifier of comparable authority. Statuses and proof rules are in [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md). The result is identified by `ledger_id` (`rol_…`) and `closure_digest`.

### 6. Shared CLI / MCP contracts with agent-aware delivery

CLI and MCP share workflows and Evidence contracts. MCP returns Evidence inline, with paging and summaries for large results, and retains it in the session. Default delivery is not the complete record for every tool; see [MCP runtime contracts](reference/mcp-contracts.md#tool-results). Delivery favors summaries and retained references to save agent tokens while keeping full Evidence reachable. Tools are composable primitives rather than rigid call sequences.

### 7. Ownership and lifecycle invariants

Resources (provider processes, temporary workspaces, captures) have clear owners. A failed cleanup keeps ownership for retry instead of assuming success. Proof of ownership is kept separate from validity or readiness. Lifecycle changes must preserve identity and handle cancellation, late handshakes, and mixed child outcomes.

### Pattern summary

| Pattern                                | Purpose                                              | Example                                  |
| -------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| Content-addressed immutability         | Stable, tamper-evident identity                      | `ev_…` / `unk_…` IDs, `closure_digest`   |
| Provider-neutral domain                | Same contracts across tools                          | Evidence schema, Application Graph       |
| Session ledger + portable bundle       | Local reuse plus exportable audit trail              | `EvidenceLedger`, evidence import/export |
| Fail-closed / explicit unknowns        | No silent assumptions                                | Residual unknowns, limitations arrays    |
| Conservative derived projections       | Auditable higher-level claims                        | Obligation ledger                        |
| Shared contracts, agent-aware delivery | CLI and MCP equivalent; summaries plus full Evidence | MCP inline Evidence + paging             |
| Ownership and lifecycle invariants     | Safe cleanup and retry                               | Provider processes, workspaces, captures |

The patterns reinforce each other: content-addressed Evidence makes both the session ledger and the obligation ledger reproducible and auditable, and the fail-closed rule keeps incomplete knowledge visible instead of filled in.

### Related patterns

REA's append-only, content-addressed records resemble **event sourcing** (Evidence and unknown revisions as the stream, the obligation ledger as a projection), and its tool surface loosely mirrors **CQRS** (analysis tools append records; summaries, views, and ledgers are read-side projections). Background on event sourcing, CQRS, command handlers, the mediator pattern, the observer pattern, and the factory pattern is in [architecture patterns](./architecture-patterns.md).

## Design implications

Immutable Evidence, residual unknowns, and a conservative obligation ledger have practical consequences.

### For agents and users

- **Fewer silent hallucinations.** An agent can't treat missing information as a negative fact or invent a confident answer; open questions stay as residual unknowns and must be cited or left explicit.
- **Traceable conclusions.** Every claim walks back to specific `ev_…` records or to an explicit unknown, so findings are easy to audit or challenge.
- **Scoped work is visible.** `out-of-scope` and `blocked` are recorded and never count as verified, so the investigation's boundary stays clear instead of disappearing into a narrative.

### For reconstruction and verification

- **Closure is expensive on purpose.** An obligation reaches `verified` only with a unique owner, required fixtures, and a passing verifier of comparable authority; static graphs alone can't prove runtime behavior. That raises the bar for "we reconstructed it."
- **Partial progress stays useful.** You can ship or reason about a reconstruction while some obligations stay blocked or out-of-scope; the ledger shows exactly what's left open.
- **Reproducible verdicts.** The same Evidence bundle, reviewed obligations, and manifest always yield the same `closure_digest`. See [Reconstruction obligation ledgers](reference/reconstruction-obligation-ledgers.md).

### For tooling and workflow

- **Evidence is reusable.** Content-addressed, portable records feed comparisons, snapshots, unknown updates, and ledgers without re-running analysis.
- **Unknowns become work items.** Residual unknowns can be listed, filtered, and resolved later, turning "I don't know" into something trackable.
- **Authority is explicit.** Observed, derived, and inferred results are distinguished, and closure requires comparable authority, so a unit test isn't mistaken for proof of runtime behavior.

### Trade-offs

- **More ceremony.** Useful observations must be captured as Evidence and open questions recorded as unknowns, which makes exploratory work feel heavier.
- **Large artifacts.** Full Evidence for real applications can be big; the design assumes paging, summaries, and retained references rather than loading everything at once.
- **Conservative bias.** The ledger would rather leave claims `unowned`, `unknown`, or `implemented` (and the ledger `open`, `unknown`, or `failed`) than declare them `verified`: safer for auditability, slower when you want a quick "good enough" reconstruction.

Overall, the design favors auditability and honesty over speed of assertion. It's harder to over-claim, and easier for a later reader to see what was observed, what remains unknown, and which claims were actually proven.

## Version history

| Version | Notable additions                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1     | Android APK analysis (headless JADX), firmware (Binwalk/Unblob), stronger IDA support                                                                                                      |
| 5.0     | Better macOS bundle handling, Wakaru module recovery, browser/source-map improvements                                                                                                      |
| 6.0     | EVM bytecode, ELF layout + crash analysis, LLDB tracing, wider Ghidra Windows support                                                                                                      |
| 6.1–6.4 | Android device/ADB workflows, JEB integration, better large-analysis handling, more native architectures                                                                                   |
| 6.5     | Improved JS source selection & cross-bundle recovery, retained Evidence paging, SQLite snapshots, packet/signal/HAR/QUIC analysis, WASM, Rust metadata, Electron fuses, more agent clients |

The table above is historical. It is not the current Evidence or ledger contract. Current commands and tools are in the [generated catalog](reference/mcp-contracts.md#generated-catalog).

#### Beta observations (October 2026)

These notes are from one static run during the 6.7.0 beta. They are not the current record shape. That shape is `evidence_format: 2` with `subject.identity`, as linked above.

- `ev_`, `unk_`, `ledger_id`, and `closure_digest` were identical on rerun.
- `analyze` and `function` opened no residual unknowns on their own; the one linked unknown was recorded explicitly.
- Obligation statuses and ledger statuses are separate sets; there is no `closed` status and `failed` is ledger-level only.
- In that static run, an empty manifest left every active obligation `unowned`. That result is scoped to the run. Bindings are hand-written. Hand-written obligations are only for claims the bundle does not already generate.
- The XOR-obfuscated string was not recovered as plaintext; stripped-build function names were not recovered.
