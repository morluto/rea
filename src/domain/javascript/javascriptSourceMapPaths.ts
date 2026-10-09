import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface SourceMapPath {
  readonly value: string;
  readonly scope: "artifact-relative" | "suffix";
}

/** Resolve a source-map URL reference without changing its recorded identity. */
export const resolveJavaScriptSourceMapPath = (
  source: string,
  mapPath?: string,
): SourceMapPath | null => {
  const portable = source.replaceAll("\\", "/");
  const windowsPath = /^[a-z]:\//iu.test(portable);
  // Preserve parent traversal rather than letting URL resolution clamp at '/'.
  const anchor = `/${"source/".repeat(portable.split("/").length + 1)}`;
  const directory = posix.join(
    anchor,
    posix.dirname(mapPath?.replaceAll("\\", "/") ?? "."),
  );
  const base = pathToFileURL(`${directory}/`, { windows: false });
  const absolute = windowsPath
    ? pathToFileURL(source, { windows: true })
    : URL.parse(source);
  const resolved = windowsPath ? absolute : URL.parse(source, base);
  if (
    resolved === null ||
    !resolved.pathname.startsWith("/") ||
    resolved.pathname.endsWith("/")
  )
    return null;
  const relative =
    absolute === null
      ? !portable.startsWith("/")
      : absolute.href !== resolved.href;
  const path = decodedUrlPath(resolved);
  if (path === null) return null;
  const value = relative
    ? posix.relative(anchor, path)
    : path.replace(/^\/+/, "");
  if (value === "" || value === ".." || value.startsWith("../")) return null;
  return {
    value,
    scope: relative && mapPath !== undefined ? "artifact-relative" : "suffix",
  };
};

const decodedUrlPath = (url: URL): string | null => {
  // Encoded separators must not manufacture a different filesystem hierarchy.
  if (/%(?:2f|5c)/iu.test(url.pathname)) return null;
  try {
    if (url.protocol === "file:")
      return fileURLToPath(url, {
        windows: url.hostname !== "" && url.hostname !== "localhost",
      }).replaceAll("\\", "/");
    return `${url.host}${decodeURIComponent(url.pathname)}`;
  } catch (cause: unknown) {
    if (cause instanceof URIError || cause instanceof TypeError) return null;
    throw cause;
  }
};
