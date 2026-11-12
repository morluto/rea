import type { JsonValue } from "../jsonValue.js";
import { isNameLikeKey } from "./attributeRank.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { elementText, isXmlElement, resolvePointer } from "./viewPointer.js";
import { selectorOf } from "./viewSelector.js";
import { zipEntryAt } from "./zipView.js";

/** A file's views at its two ends. */
interface Ends {
  readonly baseline: JsonValue | null;
  readonly final: JsonValue | null;
}

/** XML identifiers and field mirrors belong to one document, including within an archive. */
const documentAt = (view: JsonValue | null, pointer: string) => {
  const entry = zipEntryAt(view, pointer);
  return typeof entry === "object" ? entry : view;
};

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
      resolvePointer(view, pointer, "xml"),
    );
    const element = pointer.replace(/\/children\/\d+$/u, "");
    return element !== pointer &&
      typeof before === "string" &&
      typeof after === "string"
      ? [
          {
            pointer,
            element,
            before,
            after,
            document: documentAt(ends.final, pointer),
          },
        ]
      : [];
  });
  // The keys of the changed texts' elements, by what each was and became.
  const keys = new Map<
    string,
    { pointer: string; key: string; document: ReturnType<typeof documentAt> }[]
  >();
  for (const { pointer, element, before, after, document } of texts) {
    const key = fieldKeyOf(element);
    const alike = JSON.stringify([before, after]);
    if (key === undefined) continue;
    const group = keys.get(alike) ?? [];
    group.push({ pointer, key, document });
    keys.set(alike, group);
  }
  const mirrored = new Set(
    texts.flatMap((mirror) => {
      const sources = keys
        .get(JSON.stringify([mirror.before, mirror.after]))
        ?.filter(({ document }) => document === mirror.document);
      const record = sources?.some(({ pointer }) => pointer !== mirror.pointer)
        ? resolvePointer(
            ends.final,
            mirror.element.replace(/\/children\/[^/]+$/u, ""),
            "xml",
          )
        : undefined;
      const shown = new Set(
        (isXmlElement(record) ? record.children : []).map((field) =>
          isXmlElement(field) ? elementText(field).trim() : "",
        ),
      );
      return (sources ?? []).some(
        ({ pointer, key }) =>
          pointer !== mirror.pointer &&
          shown.has(key) &&
          sameRecord(mirror.element, pointer),
      )
        ? [mirror.pointer]
        : [];
    }),
  );
  return (pointer: string) => mirrored.has(pointer);
};

/** An attribute that identifies a record, not a `name` two independent lists can share. */
const isRecordId = (key: string) =>
  /^(?:[^:]*:)?(?:id|uid|uuid|guid|xid)$/iu.test(key);

/** The tag a selector step names, as `element` for `[name=element][@uuid={1}]`. */
const stepTag = (token: string) => /\[name=([^\][]+)/u.exec(token)?.[1];

/**
 * Whether two pointers stay in one record. They may diverge into different
 * parts of that record. Two different members of the same list, such as two
 * components, are not one record.
 */
const sameRecord = (left: string, right: string) => {
  const first = left.split("/");
  const second = right.split("/");
  let index = 0;
  while (
    index < first.length &&
    index < second.length &&
    first[index] === second[index]
  )
    index += 1;
  if (index >= first.length || index >= second.length) return true;
  if (first[index - 1] !== "children") return true;
  const leftTag = stepTag(first[index] ?? "");
  const rightTag = stepTag(second[index] ?? "");
  return (
    leftTag === undefined || rightTag === undefined || leftTag !== rightTag
  );
};

/** Whether an element holds nothing but one identifier, as Parley's lesson membership `<entry id="6"/>`. */
export const isIdReference = (element: JsonValue | undefined): boolean => {
  if (!isXmlElement(element)) return false;
  const [key, ...more] = Object.keys(element.attributes);
  return (
    key !== undefined &&
    more.length === 0 &&
    isRecordId(key) &&
    element.children.every(
      (child) => typeof child === "string" && child.trim() === "",
    )
  );
};

/**
 * Elements a change added that hold nothing but an identifier of a record it
 * added elsewhere in the file (`isIdReference`), as Parley lists a new entry
 * in its lesson by `<entry id="6"/>`: a mirror of that record, never a check
 * or a count of its own.
 */
export const idReferencesOf = (
  change: Pick<DesktopStateDifference, "added">,
  ends: Ends,
) => {
  const added = change.added.flatMap((pointer) => {
    const element = resolvePointer(ends.final, pointer, "xml");
    return isXmlElement(element)
      ? [{ pointer, element, document: documentAt(ends.final, pointer) }]
      : [];
  });
  const mirrors = added.flatMap(({ pointer, element, document }) => {
    const [key = ""] = Object.keys(element.attributes);
    return isIdReference(element) &&
      added.some(
        (record) =>
          record.document === document &&
          record.element !== element &&
          !isIdReference(record.element) &&
          record.element.attributes[key] === element.attributes[key],
      )
      ? [pointer]
      : [];
  });
  return (pointer: string) =>
    mirrors.some(
      (mirror) => pointer === mirror || pointer.startsWith(`${mirror}/`),
    );
};
