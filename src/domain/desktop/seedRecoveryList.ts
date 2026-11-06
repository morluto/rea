/** LibreOffice's profile registry, where it lists the documents it has open while it runs. */
const REGISTRY = "registrymodifications.xcu";
/** One recovery list item: seeded, it starts LibreOffice into document recovery instead of its window. */
const RECOVERY_ITEM =
  /<item oor:path="\/org\.openoffice\.Office\.Recovery\/RecoveryList">[\s\S]*?<\/item>\n?/gu;

/** A seed's bytes without LibreOffice's recovery list items, or undefined when it holds none. */
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
  const kept = text.replace(RECOVERY_ITEM, "");
  return kept === text ? undefined : Buffer.from(kept, "utf8");
};

/** The limitation naming seeds whose recovery list the export left out, as `~/<path>`; none when there are none. */
export const recoveryListLimitation = (
  seeds: readonly string[],
): string | undefined =>
  seeds.length === 0
    ? undefined
    : `Left out of ${seeds.join(", ")}: LibreOffice's list of the documents it had open, written while it ran, which would start it into document recovery instead of its window.`;
