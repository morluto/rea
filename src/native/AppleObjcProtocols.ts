import type { ObjcSwiftMetadata } from "../domain/objcSwiftMetadata.js";
import type { SwiftMetadataReaders } from "./AppleSwiftVtables.js";

/** Read protocol lists and absolute protocol method declarations with cycle-safe identities. */
export const createObjcProtocolReader = (input: {
  readers: Pick<
    SwiftMetadataReaders,
    "u32" | "string" | "location" | "evidence" | "admit"
  > & { pointer(address: bigint): bigint; i32(address: bigint): number };
  result: ObjcSwiftMetadata;
  failures: string[];
}) => {
  const { readers: read, result, failures } = input;
  const visited = new Set<bigint>();
  const name = (address: bigint) => read.string(read.pointer(address + 8n));
  const list = (address: bigint): string[] => {
    if (address === 0n) return [];
    const count = read.pointer(address);
    if (count > 20000n)
      throw new RangeError("Protocol list exceeds 20000 entries");
    const names: string[] = [];
    for (let index = 0n; index < count; index++) {
      if (!read.admit()) break;
      const protocol = read.pointer(address + 8n + index * 8n);
      names.push(name(protocol));
      record(protocol);
    }
    return names;
  };
  const methods = (address: bigint, required: boolean, instance: boolean) => {
    const output: ObjcSwiftMetadata["objc_protocols"][number]["methods"] = [];
    if (address === 0n) return output;
    const flags = read.u32(address),
      count = read.u32(address + 4n);
    const relative = (flags & 0x80000000) !== 0;
    const stride = flags & 0xfffc;
    if (stride !== (relative ? 12 : 24))
      throw new TypeError("Unsupported Objective-C protocol method entry size");
    for (let index = 0; index < count; index++) {
      if (!read.admit()) break;
      const entry = address + 8n + BigInt(index * stride);
      let selector = relative
        ? entry + BigInt(read.i32(entry))
        : read.pointer(entry);
      if (relative && (flags & 0x40000000) === 0)
        selector = read.pointer(selector);
      output.push({
        selector: read.string(selector),
        method_type: instance ? "instance" : "class",
        address: null,
        is_required: required,
        is_optional: !required,
      });
    }
    return output;
  };
  const record = (address: bigint) => {
    if (address === 0n || visited.has(address) || !read.admit()) return;
    visited.add(address);
    try {
      if (read.u32(address + 64n) < 72)
        throw new RangeError("Truncated Objective-C protocol declaration");
      const protocolName = name(address);
      const adopted = list(read.pointer(address + 16n));
      const required = [
        ...methods(read.pointer(address + 24n), true, true),
        ...methods(read.pointer(address + 32n), true, false),
      ];
      const optional = [
        ...methods(read.pointer(address + 40n), false, true),
        ...methods(read.pointer(address + 48n), false, false),
      ];
      result.objc_protocols.push({
        name: protocolName,
        methods: required,
        optional_methods: optional,
        properties: [],
      });
      result.objc_protocol_records.push({
        name: protocolName,
        adopted_protocols: adopted,
        methods: required,
        optional_methods: optional,
        location: read.location(address),
        decode: { status: "decoded", reason: null },
        evidence: read.evidence(
          address,
          "Objective-C protocol declaration and encoded method lists; IMP fields are not handler targets",
        ),
      });
    } catch (cause) {
      failures.push(
        `Protocol 0x${address.toString(16)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };
  return { list, record };
};
