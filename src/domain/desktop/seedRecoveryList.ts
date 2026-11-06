import { xmlElementRanges } from "../xmlDocument.js";

/** LibreOffice's profile registry, where it lists the documents it has open while it runs. */
const REGISTRY = "registrymodifications.xcu";
/** The namespace of the registry's `oor:` attributes. */
const REGISTRY_NAMESPACE = "http://openoffice.org/2001/registry";
/** The path of a recovery list item: seeded, it starts LibreOffice into document recovery instead of its window. */
const RECOVERY_LIST = "/org.openoffice.Office.Recovery/RecoveryList";

/**
 * A seed's bytes without LibreOffice's recovery list items, each `item`
 * element whose `oor:path` is the recovery list, found by the XML parser and
 * cut from the source with every other byte kept; undefined when it holds
 * none, or when it is not well-formed XML, which ships as captured.
 */
export const withoutRecoveryList = (
  home: string,
  bytes: Buffer,
): Buffer | undefined => {
  if (home.split("/").at(-1) !== REGISTRY) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
  const items = xmlElementRanges(
    text,
    (element) =>
      element.uri === "" &&
      element.local === "item" &&
      element.attribute(REGISTRY_NAMESPACE, "path") === RECOVERY_LIST,
    { doctype: "reject" },
  );
  if (!items.ok || items.value.length === 0) return undefined;
  let kept = "";
  let from = 0;
  for (const { start, end } of items.value) {
    kept += text.slice(from, start);
    from = end;
  }
  return Buffer.from(kept + text.slice(from), "utf8");
};

/** The limitation naming seeds whose recovery list the export left out, as `~/<path>`; none when there are none. */
export const recoveryListLimitation = (
  seeds: readonly string[],
): string | undefined =>
  seeds.length === 0
    ? undefined
    : `Left out of ${seeds.join(", ")}: LibreOffice's list of the documents it had open, written while it ran, which would start it into document recovery instead of its window.`;
