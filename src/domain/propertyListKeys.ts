import { decodeXmlPropertyList } from "./propertyListXml.js";
import {
  decodeOpenStepPropertyList,
  startsOpenStepPropertyList,
} from "./propertyListOpenStep.js";
import {
  createPlistNumberCollector,
  type PlistNumberLiterals,
} from "./apple/plistNumbers.js";
import { MAX_PLIST_DEPTH } from "./apple/plistValue.js";
import {
  createPlistDuplicateKeyCollector,
  type PlistDuplicateKeys,
} from "./apple/plistDuplicateKeys.js";

/** Values and numeric source facts decoded together; OpenStep numbers remain unknown. */
export interface ParsedPropertyList {
  readonly value: unknown;
  readonly numberLiterals: PlistNumberLiterals;
  /** Keys a dictionary declared more than once; `value` keeps the last. */
  readonly duplicateKeys: PlistDuplicateKeys;
}

/** Decode XML or the existing OpenStep container form, retaining every dictionary key. */
export const parseXmlPropertyList = (
  text: string,
  maximumDepth = MAX_PLIST_DEPTH,
): ParsedPropertyList => {
  if (!startsOpenStepPropertyList(text))
    return decodeXmlPropertyList(text, maximumDepth);
  const duplicates = createPlistDuplicateKeyCollector();
  return {
    value: decodeOpenStepPropertyList(text, maximumDepth, duplicates),
    numberLiterals: createPlistNumberCollector().result(true),
    duplicateKeys: duplicates.result(),
  };
};
