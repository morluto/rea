# Antidote: canonicalize adversarial artifacts

## Problem

Some artifacts are deliberately hardened against AI-driven analysis without
changing how the program runs. Three families recur:

- **Poison / deception** — format-valid canaries, honey metadata, and decoy
  control flow that lead an agent to confident but wrong conclusions.
- **Exhaustion** — non-semantic padding that inflates an artifact past an
  analyzer's documented resource limits (for example, WASM custom sections,
  inflated Electron `.asar` header inventories, deeply nested or oversized JSON).
- **Hallucination** — truncated inventories and ambiguous dead ends that push an
  agent into fabricating structure.

The Blind-LLM-Agents (BLA) project is one concrete implementation of this class.
The goal is to neutralize the **class**, not a single shield, and to keep the
counter shield-agnostic so future shields are covered without new logic.

## Non-goals

- Defeating a program's real protection to recover protected logic. The pass is
  not a packer/virtualization unpacker and makes no behavior-recovery claim.
- Executing, importing, instrumenting or mutating the target in any way.
- Changing REA's existing pipelines. The feature is additive and opt-in: nothing
  changes unless `canonicalize_artifact` / `rea antidote` is invoked.

## Design principles

1. **Separate extraction from reasoning.** Parse with real, deterministic logic
   and emit structured facts. Raw adversarial bytes never reach a token budget.
2. **Canonicalize to the behavior-relevant core.** Drop non-semantic padding,
   bound and sample oversized inventories, and collapse high-redundancy decoy
   runs to an exemplar, a count and a digest.
3. **Reachability first.** Prioritize structure reachable from real entrypoints
   and flag decoys that nothing reachable references.
4. **Trust execution over description.** Represent `truncated` / `unverified` as
   a first-class state instead of confabulating absence.

The pass is **lossless for behavior-relevant data**: it only changes what the
analyzer ingests, never the target. Everything collapsed is retained by
reference (count + aggregate bytes + SHA-256) so nothing is silently lost, and a
region the pass cannot prove non-semantic is reported as `unverified`, never
dropped.

## Architecture

The feature mirrors REA's existing in-process, target-free analyzer pattern
(as used by `inspect_elf_notes` and `inspect_byte_entropy`).

- `src/domain/canonicalize/` — pure engine. `canonicalizeArtifact.ts` holds the
  Zod input/result schemas and named budget constants; `normalizer.ts` defines
  the pluggable `ArtifactNormalizer` interface, the uniform fact model and
  shared helpers; `engine.ts` selects a byte-based normalizer from a
  config-driven `CanonicalizeProfile`; `normalizers/` holds one module per
  byte-based format; `asarInventory.ts` is a pure classifier for ASAR inventory
  entries (see below).
- `src/application/canonicalize/` — `CanonicalizePort` and `CanonicalizeService`
  (shared CLI/MCP workflow: validate input, run the provider, assemble Evidence).
- `src/canonicalize/CanonicalizeProvider.ts` — reads one bounded, identity-checked
  regular file through the shared stable artifact reader, then runs the pure
  byte-based engine (WASM, JSON) or, for Electron `.asar`, the adapter in
  `src/canonicalize/asarCanonicalize.ts`, which reuses REA's owning ASAR reader
  (`parseAsarHeaderExtents`, `readAsarListing`) and feeds the validated entries
  to the pure `asarInventory` classifier. ASAR parsing is not reimplemented in
  the pure domain layer, which cannot depend on the adapter-layer reader.
- `src/contracts/canonicalize/` — the `canonicalize_artifact` tool contract.
- `src/composition/canonicalize.ts`, `src/cli/canonicalizeCommands.ts`,
  `src/server/registerCanonicalizeTool.ts` — composition and the two adapters.

### Normalizer interface

A normalizer is deterministic and side-effect-free. It recognizes a format from
a bounded prefix, bounds its own work by the supplied budget, and returns the
uniform fact model (`core`, `collapsed`, `reductions`, `coverage`,
`limitations`). New formats and shields are added declaratively by registering a
normalizer in the profile, not by forking the engine.

## v1 formats

- **WASM** (`wasm-sections`): a defensive LEB128 section walk. Core sections and
  link-relevant custom sections (`linking`, `dylink`, `dylink.0`,
  `target_features`, `reloc.*`) are behavior-relevant and retained; all other
  custom sections are non-semantic to execution and collapsed to an exemplar and
  a digest. Both the retained-fact count (including `reloc.*`) and each retained
  section name are bounded, so neither a flood of sections nor a multi-megabyte
  section name can exhaust the pass. This neutralizes custom-section exhaustion
  regardless of section names.
- **Electron `.asar`** (`asar-listing`): REA's owning ASAR reader validates the
  Pickle framing and the header inventory (depth, node schema and expanded-path
  byte budgets) before any allocation; the pure `asarInventory` classifier then
  classifies the validated entries. Proven reachability from `package.json`
  `main`/`exports` — including nested conditional and subpath `exports` such as
  an `import`/`require` pair — wins over every heuristic: a reachable entry is
  never mislabeled a decoy, and it is retained ahead of unverified entries so an
  earlier flood of members cannot push a real entrypoint into the overflow
  digest. Only non-reachable abnormally long paths are flagged as unreferenced
  inflation. A header beyond this pass's fixed header budget (the pass applies a
  fixed cutoff, not the configurable `asar.max_header_bytes` setting) is noted
  without failing.
- **Structured JSON** (`json-structure`): a bounded, iterative, depth- and
  node-capped walk that retains bounded behavior-relevant content (keys and
  scalar values) rather than only a count. Arrays are enumerated without
  materializing every element, so a long array cannot exhaust the heap before
  the cap. Because `JSON.parse` builds the whole value before those caps apply,
  input beyond a fixed structural-canonicalization size budget is reported as
  partial with the artifact's own digest instead of being parsed. Nesting beyond
  `max_depth` and children beyond the fact budget are left `unverified` with
  partial coverage, never asserted as padding. This also covers oversized
  `tshark`/pcap JSON dumps.

Unrecognized inputs retain byte identity and report their structure as
`unverified`. Every collapse records a reduction whose `group_sha256` identifies
the omitted items by reference, and declared sizes (such as a >4 GiB ASAR
unpacked member) are modeled as non-negative safe integers, not 32-bit extents.

## Surfaces

- MCP tool `canonicalize_artifact` (native family, `native-provider` kind),
  returning a canonical Evidence record. Results carry REA's untrusted-content
  marker, because facts derive from a potentially adversarial target.
- CLI `rea antidote <path> [--antidoteFormat auto|wasm|asar|json]
  [--max-file-bytes] [--max-facts] [--max-depth] --json`. The input normalizer
  uses `--antidoteFormat`, distinct from the global `--format` output control.

## Safety

The input is untrusted. The pass never executes or imports target code, parses
defensively, and bounds its own memory, structural depth and inventory walks so
the exhaustion vector cannot turn the pass itself into the victim.
