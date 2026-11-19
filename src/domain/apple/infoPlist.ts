import { malformedInput } from "../parseFailure.js";
import { parseXmlPropertyList } from "../propertyListKeys.js";
import { decodeXmlPlistText } from "../propertyListXmlText.js";
import { hasBinaryPlistSignature } from "./appleArchiveFormat.js";
import { INFO_PLIST_DECODE_MIB } from "./appleBundleTypes.js";
import { decodeBinaryPropertyList } from "./binaryPlistMaterializer.js";
import { MAX_PLIST_DEPTH } from "./plistValue.js";
import { estimateBinaryPlistExpansion } from "./propertyListDecodeBudget.js";

const INFO_PLIST_DECODE_BYTES = INFO_PLIST_DECODE_MIB * 1024 * 1024;

/**
 * Decode one Info.plist's top-level value in-process, whether binary, XML, or
 * OpenStep. An unrelated `__proto__` entry must not make the bundle unreadable.
 *
 * `keys` are the entries the caller reads. A plist that may declare one of
 * them more than once is refused: the decoder keeps the last declaration and
 * the system's bundle readers are not shown to agree. A repeat is attributed
 * to a key by name only, so a repeat inside a nested dictionary, or one whose
 * name was not retained, also refuses.
 */
export const decodeInfoPlistValue = (
  plist: Buffer,
  keys: readonly string[],
): unknown => {
  const decoded = hasBinaryPlistSignature(plist)
    ? decodeBinaryPropertyList(
        plist,
        estimateBinaryPlistExpansion(plist, INFO_PLIST_DECODE_BYTES),
      )
    : parseXmlPropertyList(
        decodeXmlPlistText(plist),
        MAX_PLIST_DEPTH,
        INFO_PLIST_DECODE_BYTES,
      );
  const { names, namesOmitted } = decoded.duplicateKeys;
  const repeated = keys.filter((key) => namesOmitted || names.includes(key));
  if (repeated.length > 0)
    throw malformedInput(
      "plist",
      `Info.plist may declare ${repeated.join(", ")} more than once; which declaration applies is ambiguous`,
    );
  return decoded.value;
};
