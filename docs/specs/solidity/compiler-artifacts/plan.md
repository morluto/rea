# Compiler artifact implementation plan

1. Define exact selection and compiler Evidence schemas with explicit nullable
   decoded-byte identity and inference availability. Keep raw/hex inputs and
   historical Evidence compatible.
2. Own Standard JSON selection in `src/domain/evm/` with one strict, bounded
   format-aware parser shared by worker and Evidence consumers. Preserve original
   source ranges and raw JSON slices; validate reference spans without rewriting
   compiler objects.
3. Run selection in the existing bounded worker. Concrete bytes use EVMole;
   unavailable bytes retain compiler observations without engine inference.
   Validate worker provenance against the selected original carrier.
4. Share selection/result semantics through the existing service, CLI and MCP
   contract. Carry selection and unknowns through retained views; avoid display
   text reparsing or separate per-adapter interpretation.
5. Add producer-semantic tests and real public CLI/MCP verification using owned
   pinned compiler fixtures. Update the EVM guide and authored agent skill.
6. Run focused regressions, static/generated-document checks and the real EVM
   lane. Record completed-task elapsed/CPU/peak memory and serialized token
   estimates where measured; distinguish new capability cost from existing
   equivalent raw/hex inspection. Preserve unmeasured costs explicitly.
