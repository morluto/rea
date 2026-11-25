/** Merge explicit layers by platform identity while retaining the winning spelling/value. */
export const mergeEnvironmentOverrides = <T>(
  existing: Readonly<Record<string, T>>,
  overrides: Readonly<Record<string, T>>,
  platform: NodeJS.Platform,
): Readonly<Record<string, T>> => {
  const selected = new Map<string, readonly [string, T]>();
  for (const layer of [existing, overrides])
    for (const [key, value] of Object.entries(layer))
      selected.set(platform === "win32" ? key.toUpperCase() : key, [
        key,
        value,
      ]);
  return Object.freeze(Object.fromEntries(selected.values()));
};

/** Drop settings a downstream client should inherit from its own defaults. */
export const omitEnvironmentSettings = <T>(
  environment: Readonly<Record<string, T>>,
  settings: ReadonlySet<string> | undefined,
): Readonly<Record<string, T>> =>
  settings === undefined || settings.size === 0
    ? environment
    : Object.fromEntries(
        Object.entries(environment).filter(([name]) => !settings.has(name)),
      );

/** Snapshot selected variables while preserving platform and caller precedence. */
export const snapshotEnvironment = <T extends string | undefined>(
  environment: Readonly<Record<string, T>>,
  platform: NodeJS.Platform,
): Readonly<Record<string, T>> => {
  const selected = mergeEnvironmentOverrides({}, environment, platform);
  if (platform !== "win32") return selected;
  // Fold aliases in caller order so an explicit later override wins before
  // this canonical environment crosses a Windows process boundary.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(selected)
        .map(([key, value]) => [key.toUpperCase(), value] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
};
