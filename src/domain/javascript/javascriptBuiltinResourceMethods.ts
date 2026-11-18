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
interface ReleaseMember {
  readonly owner: "instance" | "prototype";
  readonly delegates?: readonly ReleaseMethod[];
}
const inherited = { owner: "prototype" } as const;

// Each entry lists the release methods looked up inside the native call.
const releases: Readonly<
  Record<string, Partial<Record<ReleaseMethod, ReleaseMember>>>
> = {
  "fs:createReadStream": {
    close: { owner: "prototype", delegates: ["destroy"] },
    destroy: inherited,
  },
  "fs:createWriteStream": {
    close: { owner: "prototype", delegates: ["end", "destroy"] },
    destroy: inherited,
    end: inherited,
  },
  "fs/promises:open": { close: { owner: "instance" } },
  "net:connect": { destroy: inherited, end: inherited },
  "net:createConnection": { destroy: inherited, end: inherited },
  "tls:connect": { destroy: inherited, end: inherited },
};

export const builtinResourceReleases = (specifier: string, method: string) =>
  releases[`${specifier}:${method}`];

export const BUILTIN_RESOURCE_SPECIFIERS = Object.keys(
  BUILTIN_RESOURCE_METHODS,
);
