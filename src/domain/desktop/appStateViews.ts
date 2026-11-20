import { z } from "zod";

import { jsonRecordSchema } from "../jsonRecord.js";
import { jsonValueSchema, MAX_JSON_DEPTH } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import type { TaskFileView } from "./appTaskChecks.js";

const fileViewSchema = z.object({
  format: z.string().nullable(),
  view: jsonValueSchema.nullable(),
  error: z
    .string()
    .nullish()
    .transform((error) => error ?? null),
});
const statePartSchema = z.looseObject({
  kind: z.literal("data"),
  data: z.looseObject({ state: jsonRecordSchema(fileViewSchema) }),
});

/** The first valid set of typed file views returned by an exported app's data/get. */
export const appStateViews = (
  parts: readonly unknown[],
): Result<ReadonlyMap<string, TaskFileView>, string> => {
  for (const part of parts) {
    const parsed = statePartSchema.safeParse(part);
    if (parsed.success)
      return ok(new Map(Object.entries(parsed.data.data.state)));
  }
  return err(
    "The app's data/get returned no state views; witness a bundle exported by REA, whose app serves them.",
  );
};

/** Keep the detached verifier's field admission tied to the host reader's input schema. */
export const renderPythonAppStateViews = (): string => {
  const { properties, required } = z.toJSONSchema(fileViewSchema, {
    io: "input",
  });
  if (properties === undefined || required === undefined)
    throw new TypeError(
      "Expected the app state file view to define its fields.",
    );
  const nullableTextFields = Object.entries(properties)
    .filter(([, property]) => {
      const type = typeof property === "object" ? property.type : undefined;
      return Array.isArray(type) && type.includes("string");
    })
    .map(([field]) => field);
  return String.raw`
_STATE_REQUIRED_FIELDS = ${JSON.stringify(required)}
_STATE_TEXT_FIELDS = ${JSON.stringify(nullableTextFields)}


def _valid_state_json(state) -> bool:
    # Stack of iterators avoids copying the decoded reply or relying on Python's
    # recursion limit. The state map is the root of the same bound as in REA.
    frames = [iter((state,))]
    while frames:
        value = next(frames[-1], MISSING)
        if value is MISSING:
            frames.pop()
            continue
        if len(frames) - 1 > ${String(MAX_JSON_DEPTH)}:
            return False
        if isinstance(value, dict):
            if not all(isinstance(key, str) for key in value):
                return False
            frames.append(iter(value.values()))
        elif isinstance(value, list):
            frames.append(iter(value))
        elif isinstance(value, (int, float)):
            try:
                if not math.isfinite(value):
                    return False
            except OverflowError:
                return False
        elif value is not None and not isinstance(value, str):
            return False
    return True


def _app_state_views(parts):
    for part in parts:
        if part.kind != "data":
            continue
        data = getattr(part, "data", None)
        state = data.get("state") if isinstance(data, dict) else None
        if not isinstance(state, dict):
            continue
        if all(isinstance(view, dict)
               and all(field in view for field in _STATE_REQUIRED_FIELDS)
               and all(view.get(field) is None or isinstance(view[field], str) for field in _STATE_TEXT_FIELDS)
               for view in state.values()) and _valid_state_json(state):
            return state
    return None
`;
};
