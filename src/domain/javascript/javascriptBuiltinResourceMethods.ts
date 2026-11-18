/** Supported native resource receivers, shared by acquisition and validity owners. */
export const BUILTIN_RESOURCE_METHODS = {
  fs: ["open", "openSync", "createReadStream", "createWriteStream"],
  "fs/promises": ["open"],
  net: ["connect", "createConnection"],
  tls: ["connect"],
} as const;

/**
 * Release methods the resource handle from each acquisition actually has.
 *
 * `fs/promises.open` returns a Promise; the resource owner admits FileHandle
 * methods when receiver writes can supply its fulfilled value, retaining
 * ambiguity and the existing qualifier for conditional built-in identity.
 *
 * `fs.openSync` returns a numeric descriptor and `fs.open` in its callback form
 * returns `undefined`, so neither has a release method at all; the descriptor is
 * released through `fs.closeSync`/`fs.close`, which is not a member call. A
 * `fs.ReadStream` exposes `end` as its byte-offset field, not a method. A
 * `FileHandle` and a `net.Socket`/`TLSSocket` each expose only their own subset,
 * so a family-blind release list claims a teardown that throws instead.
 */
type ReleaseMethod = "close" | "destroy" | "end";
type ReleaseDependencies = Readonly<
  Partial<Record<ReleaseMethod, readonly ReleaseMethod[]>>
>;

// Each entry lists the release methods looked up inside the native call.
const releases: Readonly<Record<string, ReleaseDependencies>> = {
  "fs:createReadStream": { close: ["destroy"], destroy: [] },
  "fs:createWriteStream": { close: ["end", "destroy"], destroy: [], end: [] },
  "fs/promises:open": { close: [] },
  "net:connect": { destroy: [], end: [] },
  "net:createConnection": { destroy: [], end: [] },
  "tls:connect": { destroy: [], end: [] },
};

export const builtinResourceReleases = (specifier: string, method: string) =>
  releases[`${specifier}:${method}`];

export const BUILTIN_RESOURCE_SPECIFIERS = Object.keys(
  BUILTIN_RESOURCE_METHODS,
);
