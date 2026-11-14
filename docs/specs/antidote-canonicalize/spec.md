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
  shared helpers; `engine.ts` selects a normalizer from a config-driven
  `CanonicalizeProfile`; `normalizers/` holds one module per format.
- `src/application/canonicalize/` — `CanonicalizePort` and `CanonicalizeService`
  (shared CLI/MCP workflow: validate input, run the provider, assemble Evidence).
- `src/canonicalize/CanonicalizeProvider.ts` — reads one bounded, identity-checked
  regular file through the shared stable artifact reader and runs the pure engine.
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
  a digest. This neutralizes custom-section exhaustion regardless of section
  names.
- **Electron `.asar`** (`asar-header`): a bounded Pickle/JSON header read. The
  inventory is bounded and sampled; entries reachable from `package.json`
  `main`/`exports` are behavior-relevant; abnormally long paths are flagged as
  unreferenced inflation; a header beyond REA's documented `asar.max_header_bytes`
  is noted.
- **Structured JSON** (`json-structure`): a bounded, iterative, depth- and
  node-capped walk. Nesting beyond `max_depth` and high-cardinality sibling runs
  are collapsed. This also covers oversized `tshark`/pcap JSON dumps.

Unrecognized inputs retain byte identity and report their structure as
`unverified`.

## Surfaces

- MCP tool `canonicalize_artifact` (native family, `native-provider` kind),
  returning a canonical Evidence record. Results carry REA's untrusted-content
  marker, because facts derive from a potentially adversarial target.
- CLI `rea antidote <path> [--format auto|wasm|asar|json] [--max-file-bytes]
  [--max-facts] [--max-depth] --json`.

## Safety

The input is untrusted. The pass never executes or imports target code, parses
defensively, and bounds its own memory, structural depth and inventory walks so
the exhaustion vector cannot turn the pass itself into the victim.
