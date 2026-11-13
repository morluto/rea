# Implementation plan

## Boundary and contract

Follow the existing binary-diagnostics inspectors. `parseWindowsShortcut` in
`src/native/windows/WindowsShortcutParser.ts` owns Shell Link bytes and
coverage; `src/domain/native/windowsShortcut.ts` owns the result schema.
`WindowsShortcutProvider` (`rea-windows-shortcut`, built in) owns path
validation and the stable regular-file read through `readStableArtifact` and
`ArtifactResourceScope`. `WindowsShortcutService` owns Evidence provenance with
`subject.format: "file"`. The CLI command and MCP tool consume that Evidence
and add no interpretation.

ANSI strings use a byte-preserving Latin1 projection because the original
system code page is not observable from the file. `IsUnicode` selects
UTF-16LE. Missing optional sections are reported as observed absence only.

## Incremental work and validation

1. Define the contract, limits and observations; add failing parser fixtures.
2. Implement the parser for the header, IDList, LinkInfo, StringData and
   ExtraData with budgets and partial coverage.
3. Add the provider, service, composition, capability declaration and tool
   effects; cover cancellation, symlink rejection and finalization cleanup.
4. Add the CLI command and MCP tool; cover acceptance and advertisement.
5. Update the guide, CLI page, README rows and the authored skill; run focused
   tests, repository checks and the documentation route build.

## Effects and compatibility

The workflow reads one caller-selected local file. It adds no target execution,
injection, mutation, protection recovery or network access, so no maintainer
scope decision is required. Existing tools and `inspect_artifact` routing are
unchanged.

## References

- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/
