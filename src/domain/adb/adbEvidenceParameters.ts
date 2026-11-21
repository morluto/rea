import type { AdbRequest } from "./adbDeviceAnalysis.js";
import { jsonObjectSchema, type JsonValue } from "../jsonValue.js";
import { isRecord } from "../../kernel/isRecord.js";

/** Preserve caller inputs except text explicitly marked sensitive by caller or control. */
export const adbEvidenceParameters = (
  request: AdbRequest,
  result: JsonValue,
) => {
  const parameters =
    ("callerInput" in request ? request.callerInput : undefined) ??
    jsonObjectSchema.parse(request.input);
  if (
    request.operation !== "perform_adb_ui_action" ||
    request.input.action.kind !== "set_text"
  )
    return parameters;
  const selected = isRecord(result) ? result.selected_element : null;
  const password = isRecord(selected) && selected.password === true;
  if (!request.input.action.sensitive && !password) return parameters;
  return jsonObjectSchema.parse({
    ...parameters,
    action: {
      ...(isRecord(parameters.action) ? parameters.action : {}),
      text: "[redacted]",
    },
  });
};
