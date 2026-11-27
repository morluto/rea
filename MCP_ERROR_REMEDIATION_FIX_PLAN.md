# MCP Error Remediation Fix Plan

## Issue Summary

GitHub Issue #14162 identifies four problems with MCP error remediation:

1. **Unknown tool name** returns generic error without naming similar tools
2. **Symbol name passed to xrefs** returns `invalid_format` without mentioning `find_xrefs_to_name`
3. **Hopper/IDA/Ghidra errors** embed CLI commands in remediation instead of MCP tools
4. **capability_unavailable** doesn't suggest alternative providers

---

## Root Cause Analysis

### 1. Unknown Tool Name

- **Location**: MCP SDK handles unknown tools via `McpServer` default behavior
- **Current**: Generic "Method not found" error
- **Fix**: Custom error handler in `EvidenceMcpServer` to intercept unknown tool calls and suggest similar tools

### 2. Symbol Name in xrefs

- **Location**: Provider input validation (e.g., `IdaInput.ts:25-34`, `GhidraProvider`, `HopperProvider`)
- **Current**: Schema validation rejects non-hex strings with `invalid_format`
- **Fix**: Pre-validate in provider input handling to detect symbol names and suggest `find_xrefs_to_name`

### 3. CLI Commands in Remediation

- **Location**: `analysisErrorPresentation.ts` - multiple remediation messages contain `rea doctor`, `rea analyze`, etc.
- **Current**: Remediation actions reference CLI commands
- **Fix**: Replace CLI commands with equivalent MCP tool calls in remediation messages

### 4. capability_unavailable Alternative Providers

- **Location**: `analysisErrorPresentation.ts` - `UNSUPPORTED_PROVIDER_TAGS` handling, `analysisErrorProjection.ts` - `providerErrorDetails`
- **Current**: Generic "Choose another analysis or target" message
- **Fix**: Include available alternative provider IDs in error details and remediation

---

## Files to Modify

### Core Error Projection & Presentation

| File                                      | Changes                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/analysisErrorPresentation.ts` | 1. Add specific `AnalysisCapabilityUnavailableError` handling with alternative provider suggestions<br>2. Replace CLI commands with MCP tool equivalents in all remediation messages<br>3. Add handling for symbol-name-in-xrefs case |
| `src/domain/analysisErrorProjection.ts`   | 1. Enhance `providerErrorDetails` to include alternative provider IDs for `AnalysisCapabilityUnavailableError`<br>2. Add `similar_tools` field for unknown tool errors                                                                |
| `src/domain/analysisErrorCore.ts`         | 1. Add `similarTools` field to `AnalysisInputError` for unknown tool suggestions                                                                                                                                                      |

### Provider Input Validation

| File                                               | Changes                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/ida/IdaInput.ts`                              | Detect symbol names in xrefs address parameter, suggest `find_xrefs_to_name` |
| `src/ghidra/GhidraProvider.ts` / `GhidraClient.ts` | Add similar symbol name detection for xrefs                                  |
| `src/hopper/HopperClient.ts`                       | Add similar symbol name detection for xrefs                                  |

### MCP Server Error Handling

| File                                   | Changes                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| `src/server/EvidenceMcpServer.ts`      | Add custom error handler for unknown tool names with fuzzy matching |
| `src/server/ErrorEvidenceTransport.ts` | (Already exists inline) - Enhance error recovery                    |

### Tool Contracts & Discovery

| File                                     | Changes                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `src/contracts/toolContractTypes.ts`     | Add `similarTools` metadata field to `ToolContract`               |
| `src/contracts/enhancedToolContracts.ts` | Ensure `find_xrefs_to_name` is properly documented as alternative |

---

## Detailed Code Changes

### 1. Unknown Tool Name - `EvidenceMcpServer.ts`

```typescript
// Add to EvidenceMcpServer class
private findSimilarTools(unknownTool: string): string[] {
  const allTools = Array.from(this.tools.keys());
  return allTools
    .map(tool => ({ tool, distance: levenshtein(unknownTool, tool) }))
    .filter(({ distance }) => distance <= 3)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ tool }) => tool);
}

// Override tool call handling to intercept unknown tools
override async callTool(name: string, args: unknown): Promise<CallToolResult> {
  if (!this.tools.has(name)) {
    const similar = this.findSimilarTools(name);
    return this.delivery.toErrorToolResult(
      new AnalysisInputError("unknown_tool", undefined, [
        {
          path: ["tool_name"],
          reason: "unknown_tool",
          message: similar.length > 0
            ? `Unknown tool "${name}". Did you mean: ${similar.join(", ")}?`
            : `Unknown tool "${name}". Use list_tools to see available operations.`,
          similar_tools: similar,
        },
      ]),
    );
  }
  return super.callTool(name, args);
}
```

### 2. Symbol Name in xrefs - `IdaInput.ts`

```typescript
// In parseIdaInput, before address format validation
if (operation === "xrefs" && typeof parameters.address === "string") {
  const addr = parameters.address;
  // Detect symbol name pattern (not hex, not empty)
  const looksLikeSymbol =
    addr.length > 0 &&
    !/^[0-9a-f]+$/iu.test(addr) &&
    !/^0x/iu.test(addr) &&
    !/:0x/iu.test(addr);

  if (looksLikeSymbol) {
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: ["address"],
          reason: "invalid_value",
          message: `Expected a hexadecimal address, received a symbol name. Use find_xrefs_to_name with { name: ${JSON.stringify(addr)} } to resolve references by symbol name.`,
          suggestion: "find_xrefs_to_name",
          suggestion_args: { name: addr },
        },
      ]),
    );
  }
}
```

### 3. CLI Commands → MCP Tools - `analysisErrorPresentation.ts`

Replace all instances of CLI commands in remediation messages:

| CLI Command                        | MCP Tool Equivalent                         |
| ---------------------------------- | ------------------------------------------- |
| `rea doctor`                       | `binary_session` (to check provider health) |
| `rea analyze <directory>`          | `analyze_javascript_application`            |
| `rea inspect-wasm-artifact <path>` | `inspect_wasm_artifact`                     |
| `open_binary`                      | `open_binary` (already MCP)                 |
| `close_binary`                     | `close_binary` (already MCP)                |
| `get_evidence_bundle`              | `get_evidence_bundle` (already MCP)         |
| `export_evidence_bundle`           | `export_evidence_bundle` (already MCP)      |
| `inspect_analysis_view`            | `inspect_analysis_view` (already MCP)       |

Example replacements:

```typescript
// Before
"Run `rea doctor` and review the reported details";

// After
"Check provider health with binary_session and review the reported details";

// Before
"For static inspection, call inspect_wasm_artifact with {...} or run `rea inspect-wasm-artifact <path> --format json`";

// After
"For static inspection, call inspect_wasm_artifact with {...}";
```

### 4. capability_unavailable Alternative Providers - `analysisErrorProjection.ts`

```typescript
// In providerErrorDetails function, enhance AnalysisCapabilityUnavailableError case
if (error instanceof AnalysisCapabilityUnavailableError) {
  // Get available alternative providers from session/capability inventory
  const alternatives = getAlternativeProviders(
    error.providerId,
    error.operation,
  );
  return {
    provider_id: error.providerId,
    operation: error.operation,
    reason: error.reason,
    ...(alternatives.length > 0 ? { alternative_providers: alternatives } : {}),
    ...(error.cleanupIncomplete
      ? { cleanup: "incomplete", resources: [...error.cleanupResources] }
      : {}),
    ...(error.diagnostics === undefined
      ? {}
      : { diagnostics: error.diagnostics }),
  };
}

// In analysisErrorPresentation.ts, add specific handling
if (error instanceof AnalysisCapabilityUnavailableError) {
  const alternatives = error.diagnostics?.alternative_providers ?? [];
  const altMsg =
    alternatives.length > 0
      ? ` Available alternatives: ${alternatives.join(", ")}.`
      : "";
  return `Provider ${error.providerId} cannot execute ${error.operation}: ${error.reason}.${altMsg} Use binary_session to check provider availability.`;
}
```

---

## Implementation Priority

### Phase 1: Core Error Improvements (High Impact)

1. `analysisErrorPresentation.ts` - Replace CLI commands with MCP tools
2. `analysisErrorProjection.ts` - Add alternative providers to error details
3. `EvidenceMcpServer.ts` - Unknown tool handler with similar tool suggestions

### Phase 2: Provider-Specific Fixes (Medium Impact)

4. `IdaInput.ts` - Symbol name detection for xrefs
5. `GhidraProvider/GhidraClient` - Symbol name detection for xrefs
6. `HopperClient` - Symbol name detection for xrefs

### Phase 3: Enhanced Metadata (Low Impact)

7. `toolContractTypes.ts` - Add `similarTools` field
8. Update all tool contracts with similarity metadata

---

## Testing Strategy

### Unit Tests

- `analysisErrorPresentation.test.ts` - Verify remediation messages use MCP tools
- `analysisErrorProjection.test.ts` - Verify alternative providers in details
- `IdaInput.test.ts` - Verify symbol name detection suggests `find_xrefs_to_name`
- `EvidenceMcpServer.test.ts` - Verify unknown tool suggestions

### Integration Tests

- MCP tool call with unknown name returns similar tools
- xrefs with symbol name returns helpful error with `find_xrefs_to_name` suggestion
- capability_unavailable error includes alternative provider IDs
- Hopper/Ghidra/IDA errors reference MCP tools not CLI commands

---

## Backward Compatibility

- All changes are additive to error details/remediation
- No breaking changes to error codes or schemas
- Existing CLI commands still work; remediation now prefers MCP tools
- Tool contracts remain compatible

---

## Estimated Effort

| Phase     | Files    | Est. Hours |
| --------- | -------- | ---------- |
| Phase 1   | 3        | 4-6        |
| Phase 2   | 3-5      | 3-5        |
| Phase 3   | 2        | 2-3        |
| Testing   | -        | 3-4        |
| **Total** | **8-10** | **12-18**  |
