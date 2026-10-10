/** Path-segment conventions. These are inferences, not observations of runtime behavior. */

export type NativeRuntimeConvention = "react-native" | "flutter" | "unity";

const foldSegment = (segment: string): string =>
  segment.toLocaleLowerCase("en-US");

const REACT_NATIVE_SEGMENTS = new Set([
  "react.framework",
  "libhermes.so",
  "hermes.framework",
]);
const FLUTTER_SEGMENTS = new Set(["libflutter.so", "flutter.framework"]);
const UNITY_SEGMENTS = new Set(["libunity.so", "unityframework.framework"]);

/**
 * A runtime family named by one filename or directory segment.
 * `reactnative` may occur inside a segment (`libreactnativejni.so`).
 * The other names match the whole segment.
 */
export const nativeRuntimeConvention = (
  path: string,
): NativeRuntimeConvention | null => {
  for (const segment of path.split("/")) {
    const folded = foldSegment(segment);
    if (folded.includes("reactnative") || REACT_NATIVE_SEGMENTS.has(folded))
      return "react-native";
    if (FLUTTER_SEGMENTS.has(folded)) return "flutter";
    if (UNITY_SEGMENTS.has(folded)) return "unity";
  }
  return null;
};

/** Swift runtime libraries are `libswift*.dylib` segments, not every dynamic library. */
export const isSwiftRuntimeLibrary = (path: string): boolean =>
  path
    .split("/")
    .some((segment) => /^libswift.+\.dylib$/u.test(foldSegment(segment)));
