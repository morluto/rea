# Tasks

- [x] Define the domain contract, budgets and standing limitations.
- [x] Decode ELF dynamic tags, arrays, legacy `.ctors` / `.dtors` and
      `DT_INIT` / `DT_FINI` with a shared slot budget.
- [x] Resolve ELF slots through the shared dynamic relocation owner, then
      section REL / RELA records, under total symbol and relocation budgets.
- [x] Decode Mach-O initializer pointers, `__init_offsets` and terminators.
- [x] Page results and count every examined slot, including sentinels.
- [x] Wire the shared service into CLI and MCP with Evidence provenance.
- [x] Cover parsers, service, CLI acceptance, filesystem and MCP boundaries.
- [x] Document the tool in the native initializers guide and CLI reference.
