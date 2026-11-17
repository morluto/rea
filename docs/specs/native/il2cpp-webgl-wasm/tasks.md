# Tasks

- [x] Read wasm32 module sections and rebuild initial linear memory
      (`src/wasm/WasmModuleImage.ts`; `src/wasm/WasmModuleImage.test.ts`).
- [x] Open a module as an IL2CPP image and link methods to table slots and
      function indices, with refusals and capacity reasons
      (`src/il2cpp/Il2cppBinaryImage.ts`, `src/il2cpp/Il2cppBinaryFile.ts`;
      `tests/boundary/il2cpp/il2cppBinaryFile.test.ts`).
- [x] Add wasm rows to the report schema, admission and paging
      (`tests/boundary/il2cpp/il2cppMetadataAdmission.test.ts`,
      `src/domain/analysisView/il2cppMetadataView.test.ts`).
- [x] Name wasm allowances in provider refusals and return schema-valid wasm
      reports (`tests/boundary/il2cpp/il2cppMetadataProvider.test.ts`).
- [x] Refuse Ghidra seeds for wasm reports
      (`tests/boundary/il2cpp/il2cppGhidraSeeds.test.ts`).
- [x] Document the behavior in [IL2CPP metadata](../../../il2cpp-metadata.md#unity-webgl-wasm32)
      and index this record in [feature specifications](../../README.md).
