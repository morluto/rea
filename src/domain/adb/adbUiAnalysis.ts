import { z } from "zod";
import {
  adbClientIdentitySchema,
  adbPackageNameSchema,
  adbSerialSchema,
} from "./adbIdentity.js";

const coordinate = z.number().int().min(-2147483648).max(2147483647);
// A single string cannot fit a 16 KiB JSON request if its UTF-16 length already
// exceeds that budget. The adapter checks aggregate encoded bytes before base64.
const requestText = z.string().max(16 * 1024);
const identifier = requestText.min(1);
const textMatch = z.strictObject({
  value: requestText,
  match: z.enum(["exact", "contains"]).default("exact"),
});

/** Conjunctive predicates over observed accessibility facts, with no executable expressions. */
export const adbUiSelectorSchema = z.strictObject({
  text: textMatch.optional(),
  content_description: textMatch.optional(),
  resource_id: identifier.optional(),
  class_name: identifier.optional(),
  ancestor_resource_id: identifier.optional(),
  clickable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  editable: z.boolean().optional(),
  scrollable: z.boolean().optional(),
  focused: z.boolean().optional(),
  selected: z.boolean().optional(),
  checked: z.boolean().optional(),
  visible: z.boolean().optional(),
});

const scope = {
  serial: adbSerialSchema,
  package: adbPackageNameSchema.describe(
    "Package whose accessible UI is selected",
  ),
  display_id: z.number().int().nonnegative().max(2147483647).default(0),
  window_id: z.number().int().nonnegative().max(2147483647).optional(),
  max_nodes: z
    .number()
    .int()
    .min(1)
    .max(2147483647)
    .default(500)
    .describe(
      "Runner capture budget; transport capacity can produce partial coverage sooner",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(30000)
    .default(10000)
    .describe(
      "Runner operation deadline; host setup and cleanup have separate budgets",
    ),
};
const page = {
  offset: z.number().int().nonnegative().max(2147483647).default(0),
  limit: z.number().int().min(1).max(2147483647).default(50),
};
const direction = z.enum(["up", "down", "left", "right"]);
const percent = z.number().positive().max(1).default(0.75);

/** One explicit primitive; lifecycle and screenshots reuse the existing ADB tools. */
export const adbUiActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tap") }),
  z.strictObject({ kind: z.literal("double_tap") }),
  z.strictObject({ kind: z.literal("long_press") }),
  z.strictObject({
    kind: z.literal("set_text"),
    text: requestText,
    sensitive: z
      .boolean()
      .default(false)
      .describe(
        "Exclude caller-marked sensitive text from recorded Evidence parameters",
      ),
  }),
  z.strictObject({ kind: z.literal("scroll"), direction, percent }),
  z.strictObject({ kind: z.literal("swipe"), direction, percent }),
  z.strictObject({ kind: z.literal("drag"), destination_id: identifier }),
  z.strictObject({
    kind: z.literal("key_event"),
    key_code: z.number().int().nonnegative().max(2147483647),
    meta_state: z.number().int().nonnegative().max(2147483647).default(0),
  }),
]);

export const adbUiInputSchemas = {
  inspect_adb_ui: z.strictObject(scope),
  find_adb_ui_elements: z
    .strictObject({
      ...scope,
      selector: adbUiSelectorSchema,
      snapshot_id: z.string().uuid().optional(),
      ...page,
    })
    .superRefine((input, context) => {
      if (input.offset > 0 && input.snapshot_id === undefined)
        context.addIssue({
          code: "custom",
          path: ["snapshot_id"],
          message: "Page subsequent matches from an explicit retained snapshot",
        });
    }),
  wait_for_adb_ui: z.strictObject({
    ...scope,
    selector: adbUiSelectorSchema,
    condition: z.enum(["present", "absent"]).default("present"),
    limit: page.limit,
  }),
  perform_adb_ui_action: z
    .strictObject({
      ...scope,
      snapshot_id: z.string().uuid(),
      element_id: identifier.optional(),
      action: adbUiActionSchema,
    })
    .superRefine((input, context) => {
      if (input.action.kind !== "key_event" && input.element_id === undefined)
        context.addIssue({
          code: "custom",
          path: ["element_id"],
          message: "Select one element from the snapshot before acting",
        });
      if (input.action.kind === "key_event" && input.element_id !== undefined)
        context.addIssue({
          code: "custom",
          path: ["element_id"],
          message: "Key events target the foreground package, not an element",
        });
    }),
} as const;

export type AdbUiOperation = keyof typeof adbUiInputSchemas;
export type AdbUiRequest = {
  [Name in AdbUiOperation]: {
    operation: Name;
    input: z.infer<(typeof adbUiInputSchemas)[Name]>;
  };
}[AdbUiOperation];

const bounds = z.strictObject({
  left: coordinate,
  top: coordinate,
  right: coordinate,
  bottom: coordinate,
});
export const adbUiRunnerIdentitySchema = z.strictObject({
  package_name: adbPackageNameSchema,
  instance_id: z.string().uuid(),
  version: identifier,
  ui_automator_version: identifier,
  sdk_int: z.number().int().positive(),
});

export const adbUiNodeSchema = z.strictObject({
  id: identifier,
  parent_id: identifier.nullable(),
  window_id: z.number().int().nonnegative(),
  package_name: z.string().nullable(),
  class_name: z.string().nullable(),
  resource_id: z.string().nullable(),
  text: z.string().nullable(),
  content_description: z.string().nullable(),
  bounds,
  visible_bounds: bounds.describe(
    "UI Automator's bounds clipped to the visible viewport",
  ),
  enabled: z.boolean(),
  clickable: z.boolean(),
  long_clickable: z.boolean(),
  editable: z.boolean(),
  scrollable: z.boolean(),
  focused: z.boolean(),
  selected: z.boolean(),
  checked: z.boolean(),
  checkable: z.boolean(),
  password: z.boolean(),
  text_redacted: z.boolean(),
  content_description_redacted: z.boolean(),
  visible: z.boolean(),
  click_target_id: identifier.nullable(),
});

export const adbUiSnapshotHeaderSchema = z.strictObject({
  id: z.string().uuid(),
  captured_at_ms: z.number().int().nonnegative().safe(),
  package_name: adbPackageNameSchema,
  display_id: z.number().int().nonnegative(),
  window_id_filter: z.number().int().nonnegative().nullable(),
  foreground_package: z.string().nullable(),
  windows: z.array(
    z.strictObject({
      id: z.number().int().nonnegative(),
      display_id: z.number().int().nonnegative(),
      active: z.boolean(),
      focused: z.boolean(),
      bounds,
    }),
  ),
  examined_nodes: z.number().int().nonnegative(),
  retained_nodes: z.number().int().nonnegative(),
  coverage: z.enum(["complete", "partial"]),
  limitations: z.array(z.string()),
});
export const adbUiSnapshotSchema = adbUiSnapshotHeaderSchema.extend({
  nodes: z.array(adbUiNodeSchema),
});
const common = { runner: adbUiRunnerIdentitySchema };
const found = {
  ...common,
  snapshot: adbUiSnapshotHeaderSchema,
  matches: z.array(adbUiNodeSchema),
  related_nodes: z.array(adbUiNodeSchema),
  total_matches: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
  coverage: z
    .enum(["complete", "partial"])
    .describe(
      "Query coverage also becomes partial when predicates depend on redacted text",
    ),
  freshness: z.enum(["captured", "retained_snapshot"]),
};

/** Runner facts are parsed once by the adapter, before host client provenance is added. */
export const adbUiObservationSchemas = {
  inspect_adb_ui: z.strictObject({ ...common, snapshot: adbUiSnapshotSchema }),
  find_adb_ui_elements: z.strictObject(found),
  wait_for_adb_ui: z.strictObject({
    ...found,
    satisfied: z.boolean(),
    timed_out: z.boolean(),
    cancelled: z.boolean(),
  }),
  perform_adb_ui_action: z.strictObject({
    ...common,
    before: adbUiSnapshotHeaderSchema,
    selected_element: adbUiNodeSchema.nullable(),
    dispatch_attempted: z.boolean(),
    action_completed: z.boolean(),
    action_error: z
      .strictObject({ kind: z.string(), reason: z.string() })
      .nullable(),
    text_verified: z.boolean().nullable(),
    can_scroll_more: z.boolean().nullable(),
    after: adbUiSnapshotSchema.nullable(),
    observation_failure: z.string().nullable(),
  }),
} as const;

export const adbUiResultSchemas = {
  inspect_adb_ui: adbUiObservationSchemas.inspect_adb_ui.extend({
    client: adbClientIdentitySchema,
    serial: adbSerialSchema,
  }),
  find_adb_ui_elements: adbUiObservationSchemas.find_adb_ui_elements.extend({
    client: adbClientIdentitySchema,
    serial: adbSerialSchema,
  }),
  wait_for_adb_ui: adbUiObservationSchemas.wait_for_adb_ui.extend({
    client: adbClientIdentitySchema,
    serial: adbSerialSchema,
  }),
  perform_adb_ui_action: adbUiObservationSchemas.perform_adb_ui_action.extend({
    client: adbClientIdentitySchema,
    serial: adbSerialSchema,
  }),
} as const;
