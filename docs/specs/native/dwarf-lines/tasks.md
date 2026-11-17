# Tasks

- [ ] Define `src/domain/native/dwarfLines.ts` schemas, limits, and validation tests.
- [ ] Extend `src/native/dwarf/DwarfSections.ts` with role selection and line relocation tracking.
- [ ] Implement `src/native/dwarf/DwarfLineParser.ts` (DWARF 2–5 headers, string/form resolution, state machine, sequence spans, and address lookup) with fixture and unit tests.
- [ ] Implement `src/native/dwarf/DwarfLinesProvider.ts`, `src/ports/binaryDiagnostics/DwarfLinesPort.ts`, and `src/application/binaryDiagnostics/DwarfLinesService.ts` with tests.
- [ ] Implement `src/domain/analysisView/dwarfLinesView.ts` and wire `dwarf-lines` into `analysisViewRequest.ts`, `analysisViewResult.ts`, and `analysisView.ts`.
- [ ] Register contracts, CLI command, composition bindings, server bindings, and conformance/lifecycle test entries.
- [ ] Write CLI acceptance, MCP boundary, filesystem boundary, and view tests, plus cross-check against real `gcc`/`clang` and `readelf` outputs.
- [ ] Write `docs/guides/native/dwarf-lines.md`, update documentation, README/translations, skill guidance, and advertised schema snapshots; run `npm run check`, `npm run docs:check`, and test suites.
