import type { AdbRequest } from "./adbDeviceAnalysis.js";
import { jsonObjectSchema, type JsonValue } from "../jsonValue.js";
import { isRecord } from "../../kernel/isRecord.js";

/** Preserve caller inputs except text explicitly marked sensitive by caller or control. */
export const adbEvidenceParameters = (
  request: AdbRequest,
  result: JsonValue,
) => {
  if (
    request.operation !== "perform_adb_ui_action" ||
    request.input.action.kind !== "set_text"
  )
    return jsonObjectSchema.parse(request.input);
  const selected = isRecord(result) ? result.selected_element : null;
  const password = isRecord(selected) && selected.password === true;
  if (!request.input.action.sensitive && !password)
    return jsonObjectSchema.parse(request.input);
  return jsonObjectSchema.parse({
    ...request.input,
    action: { ...request.input.action, text: "[redacted]" },
  });
};
