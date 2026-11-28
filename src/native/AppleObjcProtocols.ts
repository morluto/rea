import { expectedAppleMetadataReadFailure } from "./AppleMetadataReadFailure.js";
import {
  decodeLimit,
  malformedInput,
  unsupportedInput,
  truncatedInput,
} from "../domain/parseFailure.js";
import {
  inspectUndecodedClassPropertyList,
  readObjcPropertyList,
} from "./AppleObjcProperties.js";
import type { PointerResolution } from "../domain/apple/appleMachoFixups.js";
import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { SwiftNominalReaders } from "./AppleSwiftNominalTypes.js";
import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** A failed list still owns the names read before its unreadable suffix. */
export type ObjcProtocolListResult = Result<
  string[],
  {
    readonly _tag: "ProtocolListUnreadable";
    readonly names: string[];
    readonly reason: string;
  }
>;

/**
 * Why a protocol's `_classProperties` list is unaccounted for, or null when
 * the record has none. Older protocol revisions end before offset 88; on
 * 96-byte or larger records, only a raw or rebased zero is a null list.
 */
const protocolClassPropertyReason = (
  read: { resolvePointer(address: bigint): PointerResolution },
  protocolSize: number,
  address: bigint,
): string | null => {
  if (protocolSize < 96) return null;
  const field = address + 88n;
  const list = inspectUndecodedClassPropertyList(read, field);
  if (list.kind === "absent") return null;
  if (list.kind === "unreadable")
    return `protocol class property list at 0x${field.toString(16)}: ${list.reason}`;
  return list.symbol === undefined
    ? "protocol class properties are not decoded"
    : `protocol class properties are bound to ${list.symbol} and are not decoded`;
};

/** Read protocol lists and absolute protocol method declarations with cycle-safe identities. */
export const createObjcProtocolReader = (input: {
  readers: Pick<
    SwiftNominalReaders,
    "u32" | "string" | "location" | "evidence" | "admit"
  > & {
    pointer(address: bigint): bigint;
    /** Pointer fixup outcome so `_classProperties` distinguishes null from bind/unknown. */
    resolvePointer(address: bigint): PointerResolution;
    /** Plain 64-bit data, never a fixup. */
    u64(address: bigint): bigint;
    i32(address: bigint): number;
  };
  result: ObjcSwiftMetadata;
  failures: string[];
}) => {
  const { readers: read, result, failures } = input;
  const visited = new Set<bigint>();
  const name = (address: bigint) => read.string(read.pointer(address + 8n));
  /** Own the list pointer field as well as the list's count and entries. */
  function* protocolEntries(
    field: bigint,
    onTruncated?: () => void,
  ): Generator<bigint, ObjcProtocolListResult, void> {
    const names: string[] = [];
    try {
      const address = read.pointer(field);
      if (address === 0n) return ok(names);
      // `count` is plain uintptr_t data, not a pointer fixup.
      const count = read.u64(address);
      if (count > 20000n)
        throw decodeLimit("macho", "Protocol list exceeds 20000 entries", {
          name: "objc_protocol_list_entries",
          maximum: 20_000,
        });
      for (let index = 0n; index < count; index++) {
        if (!read.admit()) {
          onTruncated?.();
          break;
        }
        const protocol = read.pointer(address + 8n + index * 8n);
        names.push(name(protocol));
        yield protocol;
      }
      return ok(names);
    } catch (cause: unknown) {
      if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
      return err({
        _tag: "ProtocolListUnreadable",
        names,
        reason: errorMessage(cause),
      });
    }
  }
  const methods = (
    address: bigint,
    required: boolean,
    instance: boolean,
    /** Entries skipped for an empty selector, reported by the declaring protocol. */
    emptySelectors: string[],
    onTruncated?: () => void,
  ) => {
    const output: ObjcSwiftMetadata["objc_protocols"][number]["methods"] = [];
    if (address === 0n) return output;
    const flags = read.u32(address),
      count = read.u32(address + 4n);
    const relative = (flags & 0x80000000) !== 0;
    const stride = flags & 0xfffc;
    if (stride !== (relative ? 12 : 24))
      throw unsupportedInput(
        "macho",
        "Unsupported Objective-C protocol method entry size",
      );
    for (let index = 0; index < count; index++) {
      if (!read.admit()) {
        onTruncated?.();
        break;
      }
      const entry = address + 8n + BigInt(index * stride);
      let selector = relative
        ? entry + BigInt(read.i32(entry))
        : read.pointer(entry);
      if (relative && (flags & 0x40000000) === 0)
        selector = read.pointer(selector);
      // One empty selector is reported on its own, so the protocol and its
      // other method declarations keep their decoded records.
      const selectorName = read.string(selector);
      if (selectorName.length === 0) {
        emptySelectors.push(
          `${required ? "required" : "optional"} ${instance ? "instance" : "class"} method ${String(index)} at 0x${entry.toString(16)} has an empty selector`,
        );
        continue;
      }
      output.push({
        selector: selectorName,
        method_type: instance ? "instance" : "class",
        address: null,
        is_required: required,
        is_optional: !required,
      });
    }
    return output;
  };
  function* readProtocol(address: bigint): Generator<bigint, void, void> {
    if (address === 0n || visited.has(address) || !read.admit()) return;
    visited.add(address);
    try {
      const protocolSize = read.u32(address + 64n);
      if (protocolSize < 72)
        throw truncatedInput(
          "macho",
          "Truncated Objective-C protocol declaration",
        );
      const protocolName = name(address);
      // Adopted protocols are independent declarations; decode them before
      // rejecting a parent whose own name is empty.
      let budgetTruncated = false;
      const onTruncated = () => {
        budgetTruncated = true;
      };
      const adopted = yield* protocolEntries(address + 16n, onTruncated);
      if (!adopted.ok)
        failures.push(
          `Protocol 0x${address.toString(16)} adopted protocol list: ${adopted.error.reason}`,
        );
      if (protocolName.length === 0)
        throw malformedInput("macho", "Objective-C protocol has an empty name");
      const skipped: string[] = [];
      const required = [
        ...methods(
          read.pointer(address + 24n),
          true,
          true,
          skipped,
          onTruncated,
        ),
        ...methods(
          read.pointer(address + 32n),
          true,
          false,
          skipped,
          onTruncated,
        ),
      ];
      const optional = [
        ...methods(
          read.pointer(address + 40n),
          false,
          true,
          skipped,
          onTruncated,
        ),
        ...methods(
          read.pointer(address + 48n),
          false,
          false,
          skipped,
          onTruncated,
        ),
      ];
      for (const message of skipped)
        failures.push(
          `Protocol 0x${address.toString(16)}: Objective-C protocol ${protocolName} ${message}`,
        );
      let properties: ObjcSwiftMetadata["objc_protocols"][number]["properties"] =
        [];
      const propertyReasons: string[] = [];
      try {
        const decoded = readObjcPropertyList(
          read,
          read.pointer(address + 56n),
          () => read.admit(),
          onTruncated,
        );
        properties = decoded.properties;
        for (const problem of decoded.issues)
          propertyReasons.push(problem.message);
      } catch (cause) {
        if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
        propertyReasons.push(errorMessage(cause));
      }
      // Older protocol revisions end at size/flags. The later class-property
      // list has no class/instance discriminator in the public property shape.
      const classPropertyReason = protocolClassPropertyReason(
        read,
        protocolSize,
        address,
      );
      if (classPropertyReason !== null)
        propertyReasons.push(classPropertyReason);
      for (const message of propertyReasons)
        failures.push(
          `Protocol 0x${address.toString(16)}: Objective-C protocol ${protocolName} properties: ${message}`,
        );
      const decodeReasons = [
        ...propertyReasons,
        ...(adopted.ok ? [] : ["protocol_list_unreadable"]),
        ...(skipped.length === 0 ? [] : ["protocol_method_selector_empty"]),
        ...(budgetTruncated ? ["max_records_reached"] : []),
      ];
      result.objc_protocols.push({
        name: protocolName,
        methods: required,
        optional_methods: optional,
        properties,
      });
      result.objc_protocol_records.push({
        name: protocolName,
        adopted_protocols: adopted.ok ? adopted.value : adopted.error.names,
        methods: required,
        optional_methods: optional,
        location: read.location(address),
        decode:
          decodeReasons.length === 0
            ? { status: "decoded", reason: null }
            : { status: "partial", reason: decodeReasons.join("; ") },
        evidence: read.evidence(
          address,
          "Objective-C protocol declaration and encoded method lists; IMP fields are not handler targets",
        ),
      });
    } catch (cause) {
      if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
      failures.push(
        `Protocol 0x${address.toString(16)}: ${errorMessage(cause)}`,
      );
    }
  }

  /** Resume each declaration after its adopted declarations finish. */
  const record = (address: bigint): void => {
    const pending = [readProtocol(address)];
    for (
      let current = pending.at(-1);
      current !== undefined;
      current = pending.at(-1)
    ) {
      const next = current.next();
      if (next.done) pending.pop();
      else pending.push(readProtocol(next.value));
    }
  };

  const readList = (
    field: bigint,
    onTruncated?: () => void,
  ): ObjcProtocolListResult => {
    const entries = protocolEntries(field, onTruncated);
    for (;;) {
      const next = entries.next();
      if (next.done) return next.value;
      record(next.value);
    }
  };
  return { readList, record };
};
