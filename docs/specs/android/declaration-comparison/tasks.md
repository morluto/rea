# Tasks

- [x] Define declaration result semantics and canonical input/output contracts (R1–R5).
- [x] Authenticate sources and create retained derived Evidence without provider work (R1–R2).
- [x] Wire CLI/MCP and catalog/capability declarations (R1).
- [x] Verify semantic uncertainty and public CLI/MCP parity and recovery (acceptance).
- [x] Document supported fields, provenance and verification limitations.

Source semantic/application checks cover nulls, declared defaults, permission
provenance, authority ordering, ambiguity, incomplete inventories, source
authentication, summary recovery, cancellation and pre-grouping heap admission.
The public acceptance scenario additionally covers actual compact advertised
schema validation, MCP source retention/export and CLI inline/bundle parity.
The automated fixtures do not establish real JADX extraction. Manual validation
also ran pinned JADX 0.7.1 against two self-authored, aapt-compiled binary-manifest
APKs, then compared the actual inspection Evidence through the compiled CLI.
The APKs have no DEX and were neither installed nor executed. This establishes
static extraction and declaration comparison for these samples; it does not
establish business-code or runtime behavior. No speed improvement is claimed.
