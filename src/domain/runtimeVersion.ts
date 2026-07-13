/** Return whether a Node.js version satisfies REA's tested runtime families. */
export const supportsNodeVersion = (version: string): boolean => {
  const [majorText = "", minorText = ""] = version.split(".");
  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);
  return (
    (major === 22 && minor >= 19) ||
    (major >= 24 && (major !== 24 || minor >= 11))
  );
};
