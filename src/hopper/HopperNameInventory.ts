import type { JsonValue } from "../domain/jsonValue.js";
import type { HopperReply } from "./HopperReplyContracts.js";

const LEGACY_OBJC_CLASS_LABEL_PREFIX = "__objc_class_";
const LEGACY_OBJC_CLASS_LABEL_SUFFIX = "_class";

const isLegacyObjcClassObjectLabel = (value: string): boolean =>
  value.startsWith(LEGACY_OBJC_CLASS_LABEL_PREFIX) &&
  value.endsWith(LEGACY_OBJC_CLASS_LABEL_SUFFIX) &&
  value.length >
    LEGACY_OBJC_CLASS_LABEL_PREFIX.length +
      LEGACY_OBJC_CLASS_LABEL_SUFFIX.length;

/**
 * Tag Hopper's stripped class-object labels while retaining their exact text.
 * The rows are a `list_names` reply already validated by its reply contract.
 */
export const projectHopperNameInventory = (
  rows: HopperReply<"list_names">,
): { readonly result: JsonValue; readonly changed: boolean } => {
  let changed = false;
  const result = rows.map((entry) => {
    const { objc_class_label: untrustedLabel, ...sourceFields } = entry;
    if (isLegacyObjcClassObjectLabel(entry.value)) {
      changed = true;
      return {
        ...sourceFields,
        objc_class_label: "hopper_legacy_class_object" as const,
      };
    }
    if (untrustedLabel !== undefined) {
      changed = true;
      return sourceFields;
    }
    return entry;
  });
  return changed ? { result, changed } : { result: rows, changed: false };
};
