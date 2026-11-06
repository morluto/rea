import type { JsonValue } from "../jsonValue.js";
import { isNameLikeKey } from "./attributeRank.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { elementText, isXmlElement, resolvePointer } from "./viewPointer.js";
import { selectorOf } from "./viewSelector.js";

/** A file's views at its two ends. */
interface Ends {
  readonly baseline: JsonValue | null;
  readonly final: JsonValue | null;
}

/** The value of the name-like attribute a pointer's last step names its element by, as `label` for `[name=elementInformation][@name=label]`. */
const fieldKeyOf = (element: string) =>
  selectorOf(
    (element.split("/").at(-1) ?? "")
      .replaceAll("~1", "/")
      .replaceAll("~0", "~"),
  )?.find(({ prefix, key }) => prefix === "@" && isNameLikeKey(key))?.value;

/**
 * Text an app shows of another field it keeps, which changed alike: a text
 * node whose element sits beside a field naming the key of another changed
 * text with the same value at both ends, as QElectroTech's
 * `<dynamic_elmt_text>` shows a component's label in its `<text>` beside
 * `<info_name>label</info_name>` while `elementInformation[@name=label]`
 * holds it.
 */
export const mirrorsOf = (
  change: Pick<DesktopStateDifference, "changed">,
  ends: Ends,
) => {
  const texts = change.changed.flatMap((pointer) => {
    const [before, after] = [ends.baseline, ends.final].map((view) =>
      resolvePointer(view, pointer),
    );
    const element = pointer.replace(/\/children\/\d+$/u, "");
    return element !== pointer &&
      typeof before === "string" &&
      typeof after === "string"
      ? [{ pointer, element, before, after }]
      : [];
  });
  // The keys of the changed texts' elements, by what each was and became.
  const keys = new Map<string, { pointer: string; key: string }[]>();
  for (const { pointer, element, before, after } of texts) {
    const key = fieldKeyOf(element);
    const alike = JSON.stringify([before, after]);
    if (key === undefined) continue;
    const group = keys.get(alike) ?? [];
    group.push({ pointer, key });
    keys.set(alike, group);
  }
  const mirrored = new Set(
    texts.flatMap((mirror) => {
      const sources = keys.get(JSON.stringify([mirror.before, mirror.after]));
      const record = sources?.some(({ pointer }) => pointer !== mirror.pointer)
        ? resolvePointer(
            ends.final,
            mirror.element.replace(/\/children\/[^/]+$/u, ""),
          )
        : undefined;
      const shown = new Set(
        (isXmlElement(record) ? record.children : []).map((field) =>
          isXmlElement(field) ? elementText(field).trim() : "",
        ),
      );
      return (sources ?? []).some(
        ({ pointer, key }) => pointer !== mirror.pointer && shown.has(key),
      )
        ? [mirror.pointer]
        : [];
    }),
  );
  return (pointer: string) => mirrored.has(pointer);
};
