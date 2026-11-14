# Implementation plan

## Boundary and contract

Follow the existing PE resource inspectors. `decodeDelphiFormStream` in
`src/native/pe/DelphiFormStream.ts` owns filer-stream bytes and decode budgets;
`src/domain/native/delphiForm.ts` owns the result schema and code-page table.
`readDelphiForms` in `src/native/pe/PeResourceParser.ts` selects RT_RCDATA
payloads, shares the remaining metadata allowance and accounts each decoded
form. `PeResourcesService` owns cross-field provenance validation before the
inventory becomes public Evidence; the CLI and MCP tools consume that Evidence
and add no interpretation.

Ranges are absolute file offsets into the selected image. Strings retain their
raw bytes beside the decode. A stopped decode keeps the partial value on its
declaring property and stops every ancestor rather than reading unread bytes as
siblings.

## Incremental work and validation

1. Define the value, object and resource contracts; add synthetic `TPF0`
   fixtures and failing decode tests.
2. Implement signature detection, component recursion, value decoding, code
   pages and text/binary projections with source ranges.
3. Add depth, count, text, structural-byte and complete-result budgets; keep
   partial values at each producing boundary.
4. Integrate with the PE resource inventory and share the remaining metadata
   allowance; cover crowded inventories and multi-form payloads.
5. Validate provider provenance, declared value types and string labels before
   Evidence; cover malformed provider output through the service.
6. Update the native guide, CLI/MCP contract and limitations; run focused
   tests, repository checks and documentation checks.

## Effects and compatibility

The workflow reads a caller-selected local file and performs static byte
inspection. It adds no target execution, injection, mutation or protection
recovery. Existing PE inventory fields remain unchanged; `delphi_forms` is an
additional result array.

## References

- Free Pascal `rtl/objpas/classes/reader.inc` (`TBinaryObjectReader`)
- Free Pascal `rtl/objpas/classes/classesh.inc` (`TFilerFlag`)
- Delphi `System.Classes.TValueType`
