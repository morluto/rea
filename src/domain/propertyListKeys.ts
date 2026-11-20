import { decodeXmlPropertyList } from "./propertyListXml.js";
import { preflightXmlPropertyListDecode } from "./apple/propertyListDecodeBudget.js";
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

/** Decode XML or the existing OpenStep container form, retaining every dictionary key.
 * The optional XML byte budget applies after format selection. In OpenStep,
 * quoted markup is string data and does not introduce XML expansion.
 */
export const parseXmlPropertyList = (
  text: string,
  maximumDepth = MAX_PLIST_DEPTH,
  maximumXmlDecodeBytes?: number,
): ParsedPropertyList => {
  if (!startsOpenStepPropertyList(text)) {
    if (maximumXmlDecodeBytes !== undefined)
      preflightXmlPropertyListDecode(text, maximumXmlDecodeBytes);
    return decodeXmlPropertyList(text, maximumDepth);
  }
  const duplicates = createPlistDuplicateKeyCollector();
  return {
    value: decodeOpenStepPropertyList(text, maximumDepth, duplicates),
    numberLiterals: createPlistNumberCollector().result(true),
    duplicateKeys: duplicates.result(),
  };
};
