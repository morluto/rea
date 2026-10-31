import { UNITY_ADDRESSABLES_BINARY_MAGIC } from "../domain/unity/unityAddressables.js";
import { readBinaryCatalogSteps } from "./UnityAddressablesBinaryCatalog.js";
import { UnityAddressablesFormatFailure } from "./UnityAddressablesFormat.js";
import { readJsonCatalogSteps } from "./UnityAddressablesJsonCatalog.js";
import type {
  UnityAddressablesReadOptions,
  UnityAddressablesSteps,
} from "./UnityAddressablesShared.js";

const isJsonStart = (bytes: Buffer): boolean => {
  let index =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (
    index < bytes.length &&
    [0x20, 0x09, 0x0a, 0x0d].includes(bytes[index]!)
  )
    index++;
  return bytes[index] === 0x7b;
};

/** Select the JSON or binary decoder from content, never from the file name. */
export function* readUnityAddressablesCatalogSteps(
  bytes: Buffer,
  options: UnityAddressablesReadOptions = {},
): UnityAddressablesSteps {
  if (isJsonStart(bytes)) return yield* readJsonCatalogSteps(bytes, options);
  if (
    bytes.length >= 4 &&
    bytes.readInt32LE(0) === UNITY_ADDRESSABLES_BINARY_MAGIC
  )
    return yield* readBinaryCatalogSteps(bytes, options);
  throw new UnityAddressablesFormatFailure(
    "unrecognized-format",
    "the file is neither a JSON content catalog nor a binary catalog with the ContentCatalogData magic",
  );
}
