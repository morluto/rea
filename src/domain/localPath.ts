import { isAbsolute, relative, sep } from "node:path";

/** True when the value is an absolute filesystem path on the host platform. */
export const isAbsoluteLocalPath = (value: string): boolean =>
  isAbsolute(value);

/** Test lexical containment on the host platform; callers must resolve symlinks first. */
export const isPathWithinRoot = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
};
