import { malformedInput } from "../domain/parseFailure.js";
import { expectedAppleMetadataReadFailure } from "./AppleMetadataReadFailure.js";
import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { PointerResolution } from "../domain/apple/appleMachoFixups.js";
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

/** Size of `objc_image_info`: a version word, then the flags word. */
const IMAGE_INFO_SIZE = 8;

/**
 * Whether this image's `category_t` records end in `_classProperties`. Images
 * built before the field existed end at `instanceProperties`, so the bytes
 * after it are a field only when an image info declares them.
 */
type ClassPropertyDeclaration =
  | { readonly kind: "absent" | "declared" }
  | {
      readonly kind: "unknown";
      readonly location: bigint;
      readonly reason: string;
    };

/**
 * Read the image's declaration once for every category. Same-named image
 * infos are read together and one that declares the field decides. An image
 * info that cannot be read, or is too short to hold its flags, leaves the
 * field's presence unknown rather than absent.
 */
const readClassPropertyDeclaration = (
  read: Pick<ObjcDispatchReaders, "u32">,
  imageInfos: readonly Section[],
): ClassPropertyDeclaration => {
  let unknown: ClassPropertyDeclaration | undefined;
  for (const imageInfo of imageInfos) {
    if (imageInfo.size < IMAGE_INFO_SIZE) {
      unknown ??= {
        kind: "unknown",
        location: imageInfo.address,
        reason: `image info holds ${imageInfo.size} of the ${IMAGE_INFO_SIZE} bytes that carry its flags`,
      };
    } else {
      const flags = imageInfo.address + 4n;
      try {
        if ((read.u32(flags) & HAS_CATEGORY_CLASS_PROPERTIES) !== 0)
          return { kind: "declared" };
      } catch (cause: unknown) {
        if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
        unknown ??= {
          kind: "unknown",
          location: flags,
          reason: errorMessage(cause),
        };
      }
    }
  }
  return unknown ?? { kind: "absent" };
};

/**
 * Why a category's `_classProperties` list is unaccounted for, or null when
 * the record has none. Only a raw or rebased zero is a null list: a bound
 * field names a list in another image, and a zero whose fixups are unknown
 * may be either. A field that cannot be resolved is reported at its address
 * so the category keeps the facts already decoded.
 */
const categoryClassPropertyIssue = (
  read: Pick<ObjcDispatchReaders, "resolvePointer">,
  declaration: ClassPropertyDeclaration,
  category: bigint,
  name: string,
): DecodeIssue | null => {
  if (declaration.kind === "absent") return null;
  const field = category + 48n;
  const unreadable = (location: bigint, reason: string) =>
    issue(
      "objc_properties_categories",
      "category_class_properties_unreadable",
      `Category ${name} class property list: ${reason}`,
      `0x${location.toString(16)}`,
    );
  if (declaration.kind === "unknown")
    return unreadable(declaration.location, declaration.reason);
  let list: PointerResolution;
  try {
    list = read.resolvePointer(field);
  } catch (cause: unknown) {
    if (expectedAppleMetadataReadFailure(cause) === null) throw cause;
    return unreadable(field, errorMessage(cause));
  }
  if (list.kind === "unsupported") return unreadable(field, list.reason);
  if (list.kind === "unknown" && list.raw === 0n)
    return unreadable(field, list.reason);
  if ((list.kind === "raw" || list.kind === "rebase") && list.target === 0n)
    return null;
  return issue(
    "objc_properties_categories",
    "category_class_properties_not_decoded",
    list.kind === "bind"
      ? `Category ${name} class property list is bound to ${list.symbol} and is not decoded`
      : `Category ${name} class property list is not decoded`,
    `0x${field.toString(16)}`,
  );
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
  const classPropertyDeclaration = readClassPropertyDeclaration(
    read,
    input.sections.filter(({ name }) => name === "__objc_imageinfo"),
  );
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
          classPropertyDeclaration,
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
