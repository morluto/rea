import type { DecodedComponent } from "../domain/wasm/wasmComponent.js";
import { readWasmPreamble } from "../domain/wasm/wasmPreamble.js";
import {
  isWasmComponentFormatFailure,
  malformedComponent,
  unsupportedComponent,
  WasmComponentReader,
  type DecodeItemBudget,
  type WasmComponentFormatFailure,
} from "./WasmComponentReader.js";
import { decodeCoreExternType } from "./WasmCoreTypes.js";

type CoreModuleInterface =
  DecodedComponent["core_modules"][number]["interface"];
type CoreExportKind = CoreModuleInterface["exports"][number]["kind"];

const IMPORT_SECTION = 2;
const EXPORT_SECTION = 7;
const EXPORT_KINDS: readonly CoreExportKind[] = [
  "func",
  "table",
  "memory",
  "global",
  "tag",
];

/** Core version from the 8-byte header, or null when it is not a core module. */
export const coreModuleVersion = (
  bytes: Uint8Array,
  start: number,
  end: number,
): number | null => {
  const preamble = readWasmPreamble(bytes, start, end);
  return preamble?.layer === 0 ? preamble.version : null;
};

const decodeImports = (
  section: WasmComponentReader,
): CoreModuleInterface["imports"] => {
  const imports: CoreModuleInterface["imports"] = [];
  const count = section.count("core imports");
  for (let index = 0; index < count; index += 1)
    imports.push({
      module: section.name("core import module name"),
      name: section.name("core import name"),
      type: decodeCoreExternType(section),
    });
  section.expectEnd("core import section");
  return imports;
};

const decodeExports = (
  section: WasmComponentReader,
): CoreModuleInterface["exports"] => {
  const exports: CoreModuleInterface["exports"] = [];
  const count = section.count("core exports");
  for (let index = 0; index < count; index += 1) {
    const name = section.name("core export name");
    const at = section.offset;
    const kind = EXPORT_KINDS[section.byte("core export kind")];
    if (kind === undefined)
      throw section.unsupported("Unknown core export kind", at);
    exports.push({ name, kind, index: section.u32("core export index") });
  }
  section.expectEnd("core export section");
  return exports;
};

/** An embedded module's interface, with the failure that left it incomplete. */
export interface CoreModuleInterfaceDecoding {
  readonly interface: CoreModuleInterface;
  readonly failure: WasmComponentFormatFailure | null;
}

/** Why an embedded module's header is not a decodable core 1 header, if it is not. */
const headerFailure = (
  bytes: Uint8Array,
  start: number,
  end: number,
): WasmComponentFormatFailure | null => {
  const preamble = readWasmPreamble(bytes, start, end);
  if (preamble === undefined)
    return malformedComponent(
      start,
      "Embedded module has no WebAssembly header",
    );
  if (preamble.layer !== 0)
    return unsupportedComponent(
      start,
      `Embedded module has layer ${String(preamble.layer)}, not a core module`,
    );
  if (preamble.version !== 1)
    return unsupportedComponent(
      start,
      `Embedded core module version ${String(preamble.version)} is not decoded`,
    );
  return null;
};

const incomplete = (
  failure: WasmComponentFormatFailure,
  imports: CoreModuleInterface["imports"],
  exports: CoreModuleInterface["exports"],
): CoreModuleInterfaceDecoding => ({
  interface: {
    status: "not_decoded",
    reason: failure.message,
    imports,
    exports,
  },
  failure,
});

/**
 * Read an embedded core module's import and export names. Other sections are
 * skipped by length; the module is never validated, instantiated or run.
 * Names read before a failure are kept.
 */
export const decodeCoreModuleInterface = (
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: DecodeItemBudget,
): CoreModuleInterfaceDecoding => {
  const header = headerFailure(bytes, start, end);
  if (header !== null) return incomplete(header, [], []);
  const imports: CoreModuleInterface["imports"] = [];
  const exports: CoreModuleInterface["exports"] = [];
  try {
    const reader = new WasmComponentReader(bytes, start + 8, end, budget);
    while (!reader.atEnd) {
      const id = reader.byte("core section id");
      const section = reader.sub(
        reader.u32("core section size"),
        "core section",
      );
      if (id === IMPORT_SECTION)
        for (const entry of decodeImports(section)) imports.push(entry);
      else if (id === EXPORT_SECTION)
        for (const entry of decodeExports(section)) exports.push(entry);
    }
  } catch (cause: unknown) {
    if (!isWasmComponentFormatFailure(cause)) throw cause;
    return incomplete(cause, imports, exports);
  }
  return {
    interface: { status: "decoded", reason: null, imports, exports },
    failure: null,
  };
};
