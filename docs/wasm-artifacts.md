# Offline WebAssembly artifacts

`inspect_wasm_artifact` / `inspect-wasm-artifact` inspects explicitly selected
local WASM bytes using caller-supplied WABT 1.0.42. No active binary target is
required. REA does not install tools or fetch artifacts and does not execute WASM.

Set `REA_WABT_BIN_DIRECTORY` to an absolute directory containing executable
`wasm-validate`, `wasm-objdump` and `wasm2wat` (with `.exe` on Windows). Missing
executables, unsupported banners and inaccessible tools produce actionable
unavailable diagnostics. Capability discovery reports configured availability;
execution validates tool files and version banners. Host process-ownership and
private-workspace controls must also be available. The real-tool profile has
been exercised on macOS arm64; other hosts require their own verification.

```bash
REA_WABT_BIN_DIRECTORY=/absolute/wabt/bin rea inspect-wasm-artifact \
  /artifacts/module.wasm --glue_paths /artifacts/glue.js \
  --candidate_paths /artifacts/other/module.wasm --format json
```

Equivalent MCP input:

```json
{
  "name": "inspect_wasm_artifact",
  "arguments": {
    "path": "/artifacts/module.wasm",
    "glue_paths": ["/artifacts/glue.js"],
    "candidate_paths": ["/artifacts/other/module.wasm"]
  }
}
```

Each selected regular file is read through the existing stable artifact reader;
symlinks, changing files and files over 8 MiB fail closed. WASM bytes are copied
into a private workspace as read-only `module.wasm`; its digest is rechecked
before and after each tool. WABT validates with `--enable-all`,
reports sections through `wasm-objdump -h -x`, and decodes through
`wasm2wat --enable-all`. The result retains selected byte SHA-256 and size,
section payload ranges, full header/detail output, exact import/export WAT
forms, decoded WAT and its UTF-8 SHA-256. Producer format drift and invalid or
truncated modules are failures, with validation diagnostics and partial Evidence
retaining selected byte identity and tool provenance.

The tool profile preserves upstream release/source identity, resolved executable
paths, executable digests, exact banners and arguments. Executable digests are
checked again after each command. Caller-supplied tools are trusted programs;
version and digest recording are not publisher authentication or an OS sandbox.
Each subprocess has a 30-second deadline and 32 MiB combined output budget;
truncation fails. All commands use existing owned-process cancellation and
cleanup. Workspace cleanup failures remain explicit errors with resource paths.

WAT is a decoded representation, not original source or proof of runtime
behavior. Custom annotations can preserve payloads, but WAT does not establish original
binary layout or round-trip byte identity. Original byte identity and objdump
output retain that distinction. Import/export forms retain exact escaped WAT names. Unescaped objdump display
names are not parsed as unambiguous identifiers.

Optional JavaScript glue uses the existing Babel parser and AST traversal. It
retains `.wasm` string literals and literal templates with source coordinates,
selected glue byte identity and parser status. Relative filesystem matches become
local path candidates. URLs, query/fragment variants and unmatched paths retain
basename candidates, including multiple matches, or remain unresolved. These are
literal associations, not proven data flow, runtime loading or URL-to-file
identity. Computed strings, aliases and dynamic imports require further evidence.
Candidates are caller-selected files; their identity does not imply validation.

Both CLI and MCP use the same typed port and application service. MCP publishes
SDK-compatible schemas and records Evidence for `get_evidence_bundle` readback.
See [WABT provenance](../third_party/wabt/README.md) and
[testing](testing.md#offline-wasm-artifacts) for real-tool verification.
