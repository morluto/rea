const MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;

/** Version and layer of an 8-byte WebAssembly preamble. */
export interface WasmPreamble {
  readonly version: number;
  /** 0 for core modules, 1 for components. */
  readonly layer: number;
}

/** Read the preamble at `start`, or undefined without `\0asm` and 8 bytes. */
export const readWasmPreamble = (
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): WasmPreamble | undefined => {
  if (end - start < 8) return undefined;
  for (const [offset, value] of MAGIC.entries())
    if (bytes[start + offset] !== value) return undefined;
  return {
    version: (bytes[start + 4] ?? 0) | ((bytes[start + 5] ?? 0) << 8),
    layer: (bytes[start + 6] ?? 0) | ((bytes[start + 7] ?? 0) << 8),
  };
};

/** Core WebAssembly 1.0 module header. */
export const isCoreWasmModule = (preamble: WasmPreamble | undefined): boolean =>
  preamble?.layer === 0 && preamble.version === 1;

/** Any component-layer header, whatever its pre-standard version. */
export const isWasmComponent = (preamble: WasmPreamble | undefined): boolean =>
  preamble?.layer === 1;
