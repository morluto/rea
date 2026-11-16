import { malformedInput } from "../domain/parseFailure.js";
import { expectedAppleMetadataReadFailure } from "./AppleMetadataReadFailure.js";
import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { Section } from "../domain/apple/appleMachoSelection.js";
import type { ObjcDispatchReaders } from "./AppleObjcDispatchFacets.js";
import { readObjcPropertiesOf } from "./AppleObjcProperties.js";
import {
  issue,
  type DecodeIssue,
} from "../domain/apple/appleDispatchDecodeFacts.js";
import { BinaryFormatFailure } from "../domain/binaryContainer.js";
import type { ObjcProtocolListResult } from "./AppleObjcProtocols.js";
import { errorMessage } from "../kernel/errorMessage.js";

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
 * Why a category's class reference names no class: it is null, or bound to a
 * symbol other than `_OBJC_CLASS_$_`, such as the `_$s…CN` metadata symbol
 * of a Swift class in another module.
 */
const unnamedClassReference = (
  read: Pick<ObjcDispatchReaders, "bound">,
  field: bigint,
  category: string,
): string => {
  const bound = read.bound(field);
  return bound === undefined
    ? `Category ${category} class reference is null`
    : `Category ${category} class reference is bound to ${bound.symbol}, which is not read as an Objective-C class name`;
};

/** `objc_image_info` flag: this image's `category_t` records end in `_classProperties`. */
const HAS_CATEGORY_CLASS_PROPERTIES = 1 << 6;

/**
 * Why a category's `_classProperties` list is unaccounted for, or null when
 * the record has none. Images built before the field existed end at
 * `instanceProperties`, so the bytes after it are a field only when an image
 * info declares them; same-named image infos are read together. A field that
 * cannot be read is reported at its address so the category keeps the facts
 * already decoded.
 */
const categoryClassPropertyIssue = (
  read: Pick<ObjcDispatchReaders, "u32" | "pointer">,
  imageInfoFlags: readonly bigint[],
  category: bigint,
  name: string,
): DecodeIssue | null => {
  let field = category + 48n;
  try {
    let declared = false;
    for (const flags of imageInfoFlags) {
      field = flags;
      if ((read.u32(flags) & HAS_CATEGORY_CLASS_PROPERTIES) !== 0)
        declared = true;
    }
    if (!declared) return null;
    field = category + 48n;
    return read.pointer(field) === 0n
      ? null
      : issue(
          "objc_properties_categories",
          "category_class_properties_not_decoded",
          `Category ${name} class property list is not decoded`,
          `0x${field.toString(16)}`,
        );
  } catch (cause: unknown) {
    if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
    return issue(
      "objc_properties_categories",
      "category_class_properties_unreadable",
      `Category ${name} class property list: ${errorMessage(cause)}`,
      `0x${field.toString(16)}`,
    );
  }
};

/**
 * Decode `__objc_catlist` `category_t` records:
 * name, cls, instanceMethods, classMethods, protocols, instanceProperties.
 * A declared `_classProperties` list is reported, not decoded: the public
 * property shape has no class/instance discriminator.
 */
export const decodeObjcCategories = (input: {
  readonly sections: readonly Section[];
  readonly read: ObjcDispatchReaders;
  readonly result: ObjcSwiftMetadata;
  readonly issues: DecodeIssue[];
  readonly admit: () => boolean;
  /** Decode a method list into implementations attributed to the category. */
  readonly methods: (
    list: bigint,
    className: string,
    methodType: "instance" | "class",
    category: string,
    onTruncated?: () => void,
  ) => string[];
  /** Read the protocol-list pointer field, retaining known names on failure. */
  readonly protocolList: (
    field: bigint,
    onTruncated?: () => void,
  ) => ObjcProtocolListResult;
  /** Name of a class defined in this image, from its class_ro_t. */
  readonly localClassName: (address: bigint) => string;
}): number => {
  const { read, result } = input;
  let examined = 0;
  const imageInfoFlags = input.sections
    .filter(({ name, size }) => name === "__objc_imageinfo" && size >= 8)
    .map(({ address }) => address + 4n);
  for (const section of input.sections.filter(
    ({ name }) => name === "__objc_catlist",
  )) {
    if (section.size % 8 !== 0)
      throw new BinaryFormatFailure(
        "malformed",
        "Misaligned Objective-C category list",
      );
    for (let index = 0; index < section.size / 8; index++) {
      if (!input.admit()) break;
      examined++;
      const field = section.address + BigInt(index * 8);
      try {
        const category = read.pointer(field);
        const name = read.string(read.pointer(category));
        if (name.length === 0)
          throw malformedInput(
            "macho",
            "Objective-C category has an empty name",
          );
        const external = boundClassName(read, category + 8n);
        const local = read.pointer(category + 8n);
        let className = external ?? null;
        if (external === undefined && local !== 0n)
          try {
            className = input.localClassName(local);
          } catch (cause: unknown) {
            if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
            // The category's own name and methods do not depend on its owner;
            // keep them and report the unreadable class reference.
            input.issues.push(
              issue(
                "objc_properties_categories",
                "category_class_unresolved",
                `Category ${name} class reference 0x${local.toString(16)}: ${errorMessage(cause)}`,
                `0x${(category + 8n).toString(16)}`,
              ),
            );
          }
        else if (external === undefined)
          input.issues.push(
            issue(
              "objc_properties_categories",
              "category_class_unresolved",
              unnamedClassReference(read, category + 8n, name),
              `0x${(category + 8n).toString(16)}`,
            ),
          );
        const owner = className ?? `(${name})`;
        let budgetTruncated = false;
        const onTruncated = () => {
          budgetTruncated = true;
        };
        const instanceMethods = input.methods(
          read.pointer(category + 16n),
          owner,
          "instance",
          name,
          onTruncated,
        );
        const classMethods = input.methods(
          read.pointer(category + 24n),
          owner,
          "class",
          name,
          onTruncated,
        );
        const protocols = input.protocolList(category + 32n, onTruncated);
        if (!protocols.ok)
          input.issues.push(
            issue(
              "objc_properties_categories",
              "protocol_list_unreadable",
              `Category ${name} adopted protocol list: ${protocols.error.reason}`,
              `0x${(category + 32n).toString(16)}`,
            ),
          );
        const properties = readObjcPropertiesOf(read, category + 40n, {
          owner: `category ${name}`,
          admit: input.admit,
          issues: input.issues,
          onTruncated,
        });
        const classProperties = categoryClassPropertyIssue(
          read,
          imageInfoFlags,
          category,
          name,
        );
        if (classProperties !== null) input.issues.push(classProperties);
        const decodeReasons = [
          ...(className === null ? ["category_class_unresolved"] : []),
          ...(protocols.ok ? [] : ["protocol_list_unreadable"]),
          ...(classProperties === null ? [] : [classProperties.code]),
          ...(budgetTruncated ? ["max_records_reached"] : []),
        ];
        result.objc_categories.push({
          name,
          class_name: className,
          class_source:
            external !== undefined
              ? "external"
              : className === null
                ? "unresolved"
                : "local",
          instance_methods: instanceMethods,
          class_methods: classMethods,
          protocols: protocols.ok ? protocols.value : protocols.error.names,
          properties,
          location: read.location(category),
          decode:
            decodeReasons.length === 0
              ? { status: "decoded", reason: null }
              : { status: "partial", reason: decodeReasons.join("; ") },
          evidence: read.evidence(category, "Objective-C category_t record"),
        });
      } catch (cause: unknown) {
        if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
        const message = errorMessage(cause);
        input.issues.push(
          issue(
            "objc_properties_categories",
            "category_decode_failed",
            message,
            `0x${field.toString(16)}`,
          ),
        );
      }
    }
  }
  return examined;
};
