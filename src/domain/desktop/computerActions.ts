import { z } from "zod";

import { fixedTupleSchema } from "../fixedTupleSchema.js";
import type { JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";

/**
 * Actions on a build computer: each but `reset` is forwarded to the driver
 * as its `computer_<action>` tool; `reset` restores the app's data to its
 * seed with `data/reset`.
 */
export const COMPUTER_ACTIONS = [
  "screenshot",
  "click",
  "drag",
  "scroll",
  "type",
  "key",
  "wait",
  "reset",
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

const POINTER = ["frame_id", "space", "norm_scale"] as const;

/** The driver's argument names each action takes, from its `computer_*` tool schemas. */
const ACTION_FIELDS: Readonly<Record<ComputerAction, readonly string[]>> = {
  screenshot: ["region", "format", "quality", ...POINTER],
  click: ["x", "y", "button", "count", "modifiers", "screenshot", ...POINTER],
  drag: [
    "path",
    "button",
    "duration_ms",
    "modifiers",
    "screenshot",
    ...POINTER,
  ],
  scroll: [
    "direction",
    "x",
    "y",
    "amount",
    "modifiers",
    "screenshot",
    ...POINTER,
  ],
  type: ["text", "screenshot"],
  key: ["keys", "repeat", "screenshot"],
  wait: ["ms", "screenshot"],
  reset: ["screenshot"],
};

const coordinate = z
  .number()
  .describe("Frame pixels, or 0..norm_scale with space norm.");

/** The driver's screenshot arguments that size its image. */
const SCREENSHOT_FIELDS = {
  region: fixedTupleSchema([z.number(), z.number(), z.number(), z.number()])
    .optional()
    .describe("screenshot: [x0, y0, x1, y1] to crop to."),
  format: z.enum(["png", "jpeg"]).optional(),
  quality: z.int().min(1).max(100).optional().describe("jpeg quality."),
};

/** How a build computer's first screenshot is taken; smaller images cost fewer tokens. */
export const screenshotOptionsSchema = z.strictObject(SCREENSHOT_FIELDS);
export type ScreenshotOptions = z.output<typeof screenshotOptionsSchema>;

/** One action on a build computer: the driver's own argument names, passed through as given. */
export const computerActionInputSchema = z.strictObject({
  computer_id: z.uuid().describe("The id start_build_computer returned."),
  action: z
    .enum(COMPUTER_ACTIONS)
    .describe(
      "The driver's computer_<action> tool to call, or reset to restore the app's data to its seed.",
    ),
  x: coordinate.optional(),
  y: coordinate.optional(),
  frame_id: z
    .string()
    .min(1)
    .optional()
    .describe("The frame the point is on; the latest by default."),
  space: z
    .enum(["frame", "norm"])
    .optional()
    .describe(
      "frame: the frame's pixels, the default; norm: a 0..norm_scale grid over it.",
    ),
  norm_scale: z.number().positive().optional(),
  button: z
    .string()
    .min(1)
    .optional()
    .describe("left, the default, right or middle."),
  count: z.int().positive().optional().describe("click: 2 double-clicks."),
  modifiers: z
    .array(z.string().min(1))
    .optional()
    .describe("Keys held during a click, drag or scroll."),
  path: z
    .array(fixedTupleSchema([z.number(), z.number()]))
    .min(2)
    .optional()
    .describe("drag: [x, y] points from press to release."),
  duration_ms: z.int().nonnegative().optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.int().positive().optional().describe("scroll: notches."),
  text: z.string().optional().describe("type: \\n presses Enter, \\t Tab."),
  keys: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'key: one chord pressed in order, as ["Control", "s"] or ["ctrl+s"].',
    ),
  repeat: z.int().positive().optional(),
  ms: z.int().nonnegative().optional().describe("wait: milliseconds."),
  ...SCREENSHOT_FIELDS,
  screenshot: z
    .boolean()
    .optional()
    .describe("Return a screenshot taken after the action."),
});
export type ComputerActionInput = z.output<typeof computerActionInputSchema>;

/** Lowercase model and X11 spellings of keys the driver names in W3C terms. */
const KEY_NAMES: ReadonlyMap<string, string> = new Map([
  ["ctrl", "Control"],
  ["control", "Control"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
  ["cmd", "Meta"],
  ["command", "Meta"],
  ["meta", "Meta"],
  ["super", "Meta"],
  ["win", "Meta"],
  ["enter", "Enter"],
  ["return", "Enter"],
  ["esc", "Escape"],
  ["escape", "Escape"],
  ["tab", "Tab"],
  ["space", " "],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["del", "Delete"],
  ["insert", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["page_up", "PageUp"],
  ["pgup", "PageUp"],
  ["pagedown", "PageDown"],
  ["page_down", "PageDown"],
  ["pgdn", "PageDown"],
  ["up", "ArrowUp"],
  ["down", "ArrowDown"],
  ["left", "ArrowLeft"],
  ["right", "ArrowRight"],
]);

const ONE_CHARACTER = /^.$/su;

/** One key's W3C name: a character as given, a known spelling translated, any other name left for the driver to judge. */
const w3cKey = (spelling: string): string => {
  if (ONE_CHARACTER.test(spelling)) return spelling;
  const lower = spelling.toLowerCase();
  return (
    KEY_NAMES.get(lower) ??
    (/^f(?:[1-9]|1\d|2[0-4])$/u.test(lower) ? lower.toUpperCase() : spelling)
  );
};

/** W3C key names from W3C names or model spellings such as `ctrl+s`, which name a chord in order. */
export const w3cKeys = (keys: readonly string[]): string[] =>
  keys.flatMap((key) =>
    ONE_CHARACTER.test(key) ? [key] : key.split(/\+(?!$)/u).map(w3cKey),
  );

/** The tool and arguments for an action, `data/reset` for a reset, or the first field the action does not take. */
export const driverCall = (
  action: ComputerAction,
  fields: Readonly<Record<string, JsonValue | undefined>>,
): Result<
  { readonly tool: string; readonly arguments: Record<string, JsonValue> },
  { readonly field: string; readonly accepted: readonly string[] }
> => {
  const accepted = ACTION_FIELDS[action];
  const given = Object.entries(fields).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value] as const],
  );
  const refused = given.find(([name]) => !accepted.includes(name))?.[0];
  if (refused !== undefined) return err({ field: refused, accepted });
  const translated = Object.fromEntries(
    given.map(([name, value]) => [
      name,
      (name === "keys" || name === "modifiers") && Array.isArray(value)
        ? w3cKeys(value.filter((key) => typeof key === "string"))
        : value,
    ]),
  );
  return ok({
    tool: action === "reset" ? "data/reset" : `computer_${action}`,
    arguments: translated,
  });
};
