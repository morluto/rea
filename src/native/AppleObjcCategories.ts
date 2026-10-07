import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { Section } from "./AppleMachoSelection.js";
import type { ObjcDispatchReaders } from "./AppleObjcDispatchFacets.js";
import { readObjcPropertiesOf } from "./AppleObjcProperties.js";

const CLASS_SYMBOL = /^_OBJC_(?:META)?CLASS_\$_(.+)$/u;

/** External class name from a bound `_OBJC_CLASS_$_Name` symbol. */
export const boundClassName = (
  read: Pick<ObjcDispatchReaders, "bound">,
  field: bigint,
): string | undefined => {
  const bound = read.bound(field);
  return bound === undefined ? undefined : CLASS_SYMBOL.exec(bound.symbol)?.[1];
};

/**
 * Decode `__objc_catlist` `category_t` records:
 * name, cls, instanceMethods, classMethods, protocols, instanceProperties.
 */
export const decodeObjcCategories = (input: {
  readonly sections: readonly Section[];
  readonly read: ObjcDispatchReaders;
  readonly result: ObjcSwiftMetadata;
  readonly failures: string[];
  readonly admit: () => boolean;
  /** Decode a method list into implementations attributed to the category. */
  readonly methods: (
    list: bigint,
    className: string,
    methodType: "instance" | "class",
    category: string,
  ) => string[];
  readonly protocols: (list: bigint) => string[];
  /** Name of a class defined in this image, from its class_ro_t. */
  readonly localClassName: (address: bigint) => string;
}): number => {
  const { read, result, failures } = input;
  let examined = 0;
  for (const section of input.sections.filter(
    ({ name }) => name === "__objc_catlist",
  )) {
    if (section.size % 8 !== 0)
      throw new RangeError("Misaligned Objective-C category list");
    for (let index = 0; index < section.size / 8; index++) {
      if (!input.admit()) break;
      examined++;
      const field = section.address + BigInt(index * 8);
      try {
        const category = read.pointer(field);
        const name = read.string(read.pointer(category));
        const external = boundClassName(read, category + 8n);
        const local = read.pointer(category + 8n);
        const className =
          external ?? (local === 0n ? null : input.localClassName(local));
        const owner = className ?? `(${name})`;
        result.objc_categories.push({
          name,
          class_name: className,
          class_source:
            external !== undefined
              ? "external"
              : className === null
                ? "unresolved"
                : "local",
          instance_methods: input.methods(
            read.pointer(category + 16n),
            owner,
            "instance",
            name,
          ),
          class_methods: input.methods(
            read.pointer(category + 24n),
            owner,
            "class",
            name,
          ),
          protocols: input.protocols(read.pointer(category + 32n)),
          properties: readObjcPropertiesOf(read, read.pointer(category + 40n), {
            owner: `category ${name}`,
            admit: input.admit,
            failures,
          }),
          location: read.location(category),
          decode:
            className === null
              ? { status: "partial", reason: "category_class_unresolved" }
              : { status: "decoded", reason: null },
          evidence: read.evidence(category, "Objective-C category_t record"),
        });
      } catch (cause: unknown) {
        failures.push(
          `Category at ${`0x${field.toString(16)}`}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }
  return examined;
};
