import { isAbsolute, relative, sep } from "node:path";

export const withinRoot = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
};

export const pathFromRoot = (root: string, path: string): string => {
  const value = relative(root, path);
  return withinRoot(root, path)
    ? value.split(sep).join("/") || "."
    : "<outside-root>";
};

export const compareNames = (left: string, right: string): number => {
  const leftPoints = [...left].map((value) => value.codePointAt(0) ?? 0);
  const rightPoints = [...right].map((value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};
