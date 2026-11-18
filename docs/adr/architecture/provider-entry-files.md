# Declare each provider's entry files instead of a provider barrel

## Status

Accepted, 2026-11-15. Decided in issues #11358 and #11360.

## Context

Application, composition and the CLI/MCP adapters import provider folders
(`src/ghidra/`, `src/native/`, ...) directly. On 2026-11-15, 238 such imports
reached 167 files in 39 provider folders. Nothing stated which of those files a
provider meant to expose.

The rule for `src/domain` subsystems in
[domain-subsystems.md](domain-subsystems.md) is one `index.ts` per module.
A prototype with an `index.ts` for each provider showed that this does not fit
providers. Composition, the capability declarations and the CLI load single
provider files on purpose: some through dynamic `import()`, some for metadata
only, so that unused providers are never loaded. A barrel pulls in everything
it re-exports. Static runtime import closure, measured on the prototype:

| Importer                          | Single files | Through `index.ts` |
| --------------------------------- | ------------ | ------------------ |
| `capabilityDeclarations`          | 55           | 1408               |
| `doctorRuntime.ts`                | 1081         | 1255               |
| `javascriptAnalysisWorkerProcess` | 225          | 334                |
| `webSourceLocations`              | 161          | 226                |

A separate metadata entry kept `capabilityDeclarations` at 87 files, but it
would need two entries and a barrel discipline in every provider.

## Decision

`ENTRY_FILES` in `scripts/lib/module-layers.mjs` lists each provider's entry
files, relative to `src/<provider>/`. These are the files that composition and
the adapters wire: provider classes, identities, metadata, worker servers,
doctors and commands. The module-boundary check counts every application,
composition or adapter import of any other provider file in the `entry` map of
`scripts/lib/module-layers.baseline.json`. That count may only shrink.

- **Seed.** The entry files are the provider files that composition and the
  adapters imported when the rule was added. Application imports of other
  provider files stay counted (67 imports: 41 into `desktop`, 11 into
  `artifacts`, 8 into `reference`, 3 into `dotnet`, 2 into `browser` and 2
  into `frida`), because application should reach that code through ports.
- **Surface growth.** A new entry file is a reviewed change to the provider's
  public surface, and it appears in the diff of `module-layers.mjs`.
- **Other units.** `src/resources`, the shared provider toolkit, declares its
  `index.ts` as its only entry file. Every other unit reaches it through that
  file.
- **Provider to provider.** The entry rule does not apply here. Every import of
  another provider folder is already counted in the `crossProvider` map.
- **Not decided here.** No `index.ts` per provider, and no change to the domain
  subsystem rule.

## Consequences

- Each provider's public surface is written down, and lazy and metadata-only
  loading stays as it is.
- A rename of an entry file must update the table. A unit test fails when an
  entry file does not exist.
- The table states only which files are public, not which symbols. Symbol
  growth inside an entry file is not reported.
