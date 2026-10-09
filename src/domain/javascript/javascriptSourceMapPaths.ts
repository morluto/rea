import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

/** Map-scoped source declaration and its path interpretation for matching. */
export const javascriptSourceMapReferenceSchema = z.strictObject({
  source_name: z.string(),
  source_root: z.string().nullable(),
  map_path: z.string().min(1),
  resolution: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.enum(["artifact-relative", "suffix"]),
      path: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("unresolved"),
      reason: z.string().min(1),
    }),
  ]),
});

/** Typed source-map context retained through graph serialization. */
export type JavaScriptSourceMapReference = z.infer<
  typeof javascriptSourceMapReferenceSchema
>;

/** Interpret a declaration once at the source-map ingestion boundary. */
export const resolveJavaScriptSourceMapReference = (
  sourceName: string,
  sourceRoot: string | null,
  mapPath: string,
): JavaScriptSourceMapReference => {
  // TraceMap's producer prefixes sourceRoot before resolving the URL reference.
  const reference = `${sourceRoot ? `${sourceRoot}/` : ""}${sourceName}`;
  return {
    source_name: sourceName,
    source_root: sourceRoot,
    map_path: mapPath,
    resolution: resolveJavaScriptSourceMapPath(reference, mapPath),
  };
};

/** Resolve a source-map URL reference without changing its recorded identity. */
const resolveJavaScriptSourceMapPath = (
  source: string,
  mapPath: string,
): JavaScriptSourceMapReference["resolution"] => {
  const portable = source.replaceAll("\\", "/");
  const windowsPath = /^[a-z]:\//iu.test(portable) || source.startsWith("\\\\");
  // Preserve parent traversal rather than letting URL resolution clamp at '/'.
  const anchor = `/${"source/".repeat(portable.split("/").length + 1)}`;
  const directory = posix.join(
    anchor,
    posix.dirname(mapPath.replaceAll("\\", "/")),
  );
  const base = pathToFileURL(`${directory}/`, { windows: false });
  const absolute = windowsPath ? windowsFileUrl(source) : URL.parse(source);
  const resolved = windowsPath ? absolute : URL.parse(source, base);
  if (resolved === null)
    return {
      kind: "unresolved",
      reason: "Source reference is not a valid URL or filesystem path.",
    };
  if (!resolved.pathname.startsWith("/"))
    return {
      kind: "unresolved",
      reason:
        "Source reference uses a non-hierarchical URL without a file pathname.",
    };
  if (resolved.pathname.endsWith("/"))
    return {
      kind: "unresolved",
      reason: "Source reference names a directory rather than a file.",
    };
  // Encoded separators must not manufacture a different filesystem hierarchy.
  if (/%(?:2f|5c)/iu.test(resolved.pathname))
    return {
      kind: "unresolved",
      reason: "Source reference contains an encoded path separator.",
    };
  const relative =
    absolute === null
      ? !portable.startsWith("/")
      : absolute.href !== resolved.href;
  const path = decodedUrlPath(resolved);
  if (path === null)
    return {
      kind: "unresolved",
      reason:
        "Source reference has malformed URL encoding or an invalid file URL.",
    };
  const value = relative
    ? posix.relative(anchor, path)
    : path.replace(/^\/+/, "");
  if (value === "" || value === ".." || value.startsWith("../"))
    return {
      kind: "unresolved",
      reason: "Source reference resolves outside the inventoried artifact.",
    };
  return { path: value, kind: relative ? "artifact-relative" : "suffix" };
};

// Code points and escapes a file URL host cannot carry.
const unusableHost = /[\0\t\n\r #/:<>?@[\\\]^|%]/u;

const carriesUsableHost = (host: string): boolean =>
  host !== "" && !unusableHost.test(host);

const windowsFileUrl = (path: string): URL | null => {
  // A malformed UNC host aborts pathToFileURL() on the Node builds this
  // package admits, so decline the reference before handing the path over
  // rather than trusting a TypeError that never arrives.
  if (
    path.startsWith("\\\\") &&
    !carriesUsableHost(path.slice(2).split("\\")[0] ?? "")
  )
    return null;
  try {
    return pathToFileURL(path, { windows: true });
  } catch (cause: unknown) {
    if (cause instanceof TypeError) return null;
    throw cause;
  }
};

const decodedUrlPath = (url: URL): string | null => {
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
