/** Components of a complete dotted numeric macOS version, such as `12.4.1`. */
const macosVersionComponents = (
  version: string | undefined,
): readonly number[] | undefined => {
  if (version === undefined || !/^\d+(?:\.\d+)*$/u.test(version))
    return undefined;
  const components = version.split(".").map(Number);
  return components.every((component) => Number.isSafeInteger(component))
    ? components
    : undefined;
};

/** Parse the major release only when the complete macOS probe is a dotted numeric version. */
export const macosMajorVersion = (
  version: string | undefined,
): number | undefined => macosVersionComponents(version)?.[0];

/**
 * Whether a host version meets a declared minimum, comparing every component
 * numerically with absent trailing components as zero (`12` equals `12.0`).
 * Unknown when either value is not a complete dotted numeric version.
 */
export const macosVersionMeetsMinimum = (
  hostVersion: string | undefined,
  minimumVersion: string,
): boolean | undefined => {
  const host = macosVersionComponents(hostVersion);
  const minimum = macosVersionComponents(minimumVersion);
  if (host === undefined || minimum === undefined) return undefined;
  for (let index = 0; index < Math.max(host.length, minimum.length); index++) {
    const difference = (host[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};
