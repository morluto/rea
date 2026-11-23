import type { PointerFixups } from "../domain/apple/appleMachoFixups.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import type { MachoLayout } from "../domain/apple/appleMachoSelection.js";
import type { MachoImportBinding } from "../domain/native/objcSwiftMetadata.js";
import { errorMessage } from "../kernel/errorMessage.js";

export interface ObjcClassImportBindingScan {
  readonly bindings: readonly MachoImportBinding[];
  readonly coverage: {
    readonly status:
      | "complete"
      | "partial"
      | "unknown"
      | "unsupported"
      | "not_requested";
    readonly reason: string | null;
    readonly examined: number;
    readonly decoded: number;
  };
}

/** Resolve caller-supplied names only at their exact selected-image addresses. */
export const inspectObjcClassImportBindings = (input: {
  readonly bytes: Buffer;
  readonly layout: MachoLayout;
  readonly fixups: PointerFixups;
  readonly addresses: readonly string[] | undefined;
  /** Whether `addresses` covers every class-label row; undefined is unknown. */
  readonly addressesComplete: boolean | undefined;
  readonly maxRecords: number;
}): ObjcClassImportBindingScan => {
  const { bytes, layout, fixups, addresses, addressesComplete, maxRecords } =
    input;
  // A candidate scan that is truncated, or whose completeness was not stated,
  // reports that limitation even when no candidate was retained.
  if (
    addresses === undefined ||
    (addresses.length === 0 && addressesComplete === true)
  )
    return {
      bindings: [],
      coverage: {
        status: "not_requested",
        reason: null,
        examined: 0,
        decoded: 0,
      },
    };
  if (fixups.kind === "none")
    return {
      bindings: [],
      coverage: {
        status: "unsupported",
        reason: "Selected Mach-O contains no supported pointer fixup commands",
        examined: 0,
        decoded: 0,
      },
    };

  const reasons = new Set<string>();
  if (addressesComplete === false)
    reasons.add(
      "Candidate address scan reached the existing max_records limit",
    );
  if (addressesComplete === undefined)
    reasons.add(
      "The caller did not state whether the candidate addresses include every class-label row (objc_class_import_addresses_complete)",
    );
  for (const failure of fixups.failures) reasons.add(failure);

  const bindings: MachoImportBinding[] = [];
  const examinedAddresses = new Set<string>();
  const candidates = addresses.slice(0, maxRecords);
  if (candidates.length < addresses.length)
    reasons.add(
      "Candidate address scan reached the existing max_records limit",
    );

  const reader = new BinaryReader(bytes, true, "macho-chained-fixup-bindings");
  for (const requestedAddress of candidates) {
    if (examinedAddresses.has(requestedAddress)) continue;
    examinedAddresses.add(requestedAddress);
    const parsedAddress = parseAddress(requestedAddress);
    if (parsedAddress === undefined) {
      reasons.add("A provider address is not a 64-bit hexadecimal address");
      continue;
    }

    try {
      const offset = layout.offset(parsedAddress, 8);
      // The loader already resolved this address to an 8-byte slot; the shared reader
      // repeats the range check and names the format if the slice is short.
      const raw = reader.word(offset, 64);
      const decoded = fixups.decode(parsedAddress, raw);
      if (decoded.kind === "unsupported") {
        reasons.add(`${requestedAddress}: ${decoded.reason}`);
        continue;
      }
      if (decoded.kind === "unknown") {
        reasons.add(`${requestedAddress}: ${decoded.reason}`);
        continue;
      }
      if (decoded.kind !== "bind" || !isObjcClassImport(decoded.symbol))
        continue;
      bindings.push({
        requested_address: requestedAddress,
        symbol: decoded.symbol,
        binding_source: decoded.binding_source,
        library_ordinal: decoded.library_ordinal,
        library: decoded.library,
        weak: decoded.weak,
        addend: decoded.addend.toString(10),
      });
    } catch (cause: unknown) {
      reasons.add(`${requestedAddress}: ${errorMessage(cause)}`);
    }
  }

  const reason = [...reasons].join("; ") || null;
  return {
    bindings,
    coverage: {
      // Unstated candidate completeness leaves the whole scan's coverage
      // unknown, even when other gaps are also known.
      status:
        addressesComplete === undefined
          ? "unknown"
          : reason === null
            ? "complete"
            : "partial",
      reason,
      examined: examinedAddresses.size,
      decoded: bindings.length,
    },
  };
};

const parseAddress = (address: string): bigint | undefined => {
  if (!/^0x[0-9a-f]{1,16}$/iu.test(address)) return undefined;
  try {
    return BigInt(address);
  } catch {
    return undefined;
  }
};

const isObjcClassImport = (symbol: string): boolean =>
  /^_?OBJC_CLASS_\$_.+$/u.test(symbol);
