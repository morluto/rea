import { z } from "zod";

import { jsonRecordSchema } from "../jsonRecord.js";
import { jsonValueSchema, MAX_JSON_DEPTH } from "../jsonValue.js";

const fileViewRules = {
  format: "nullable_string",
  view: "json",
  error: "optional_nullable_string",
} as const;

const fieldSchema = {
  nullable_string: z.string().nullable(),
  json: jsonValueSchema,
  optional_nullable_string: z
    .string()
    .nullish()
    .transform((error) => error ?? null),
};

const fileViewSchema = z.object({
  format: fieldSchema[fileViewRules.format],
  view: fieldSchema[fileViewRules.view],
  error: fieldSchema[fileViewRules.error],
} satisfies {
  [
    Field in keyof typeof fileViewRules
  ]: (typeof fieldSchema)[(typeof fileViewRules)[Field]];
});

/** The host and the offline verifier admit the same data/get file views. */
export const appStatePartSchema = z.looseObject({
  kind: z.literal("data"),
  data: z.looseObject({ state: jsonRecordSchema(fileViewSchema) }),
});

/** Python uses only the standard library and the already decoded protocol reply. */
export const PYTHON_APP_STATE_ADMISSION = String.raw`
APP_STATE_FILE_FIELDS = ${JSON.stringify(fileViewRules)}
APP_STATE_JSON_DEPTH = ${MAX_JSON_DEPTH}


def _state_json(root):
    """Validate the state tree with one iterator per open container."""
    levels = [iter((root,))]
    while levels:
        item = next(levels[-1], MISSING)
        if item is MISSING:
            levels.pop()
            continue
        if len(levels) > APP_STATE_JSON_DEPTH + 1:
            return False
        if item is None or isinstance(item, (str, bool)):
            continue
        if isinstance(item, (int, float)):
            try:
                if math.isfinite(item):
                    continue
            except OverflowError:
                pass
            return False
        if isinstance(item, list):
            levels.append(iter(item))
        elif isinstance(item, dict) and all(isinstance(key, str) for key in item):
            levels.append(iter(item.values()))
        else:
            return False
    return True


def _state_file(entry):
    if not isinstance(entry, dict):
        return False
    for name, rule in APP_STATE_FILE_FIELDS.items():
        value = entry.get(name, MISSING)
        if value is MISSING:
            if rule != "optional_nullable_string":
                return False
        elif rule != "json" and value is not None and not isinstance(value, str):
            return False
    return True


def _first_state(parts):
    """Return the first complete state part. An empty state is valid."""
    for part in parts:
        if getattr(part, "kind", None) != "data":
            continue
        data = getattr(part, "data", None)
        state = data.get("state") if isinstance(data, dict) else None
        if isinstance(state, dict) and all(_state_file(entry) for entry in state.values()) and _state_json(state):
            return state
    return None
`;
