import { statSync } from "node:fs";
import * as nodeModule from "node:module";
import { extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoots = [
  fileURLToPath(new URL("../../src/", import.meta.url)),
  fileURLToPath(new URL("./", import.meta.url)),
];
/** @type {nodeModule.ModuleHooks | undefined} */
let hooks;
/**
 * `stripTypeScriptTypes` in transform mode, as Node.js 22.13 through 25 accept
 * it. Owned source uses parameter properties, which strip-only mode refuses.
 * Node.js 26 removed `mode: "transform"` and `sourceMap` (so @types/node 26
 * no longer declares them); the loader refuses such a runtime.
 * @typedef {(
 *   code: string,
 *   options: { mode: "transform"; sourceMap: boolean; sourceUrl: string },
 * ) => string} TransformTypeScript
 */
/** @type {TransformTypeScript | undefined} */
let transformTypeScript;

/**
 * The runtime's TypeScript transform, when a probe with a parameter property
 * succeeds.
 * @returns {TransformTypeScript | undefined}
 */
const supportedTransform = () => {
  if (typeof nodeModule.stripTypeScriptTypes !== "function") return undefined;
  // The declared type lacks transform mode; the probe below establishes it.
  const transform = /** @type {TransformTypeScript} */ (
    /** @type {unknown} */ (nodeModule.stripTypeScriptTypes)
  );
  try {
    transform("class Probe { constructor(readonly value: number) {} }", {
      mode: "transform",
      sourceMap: false,
      sourceUrl: "rea-verifier-source-loader-probe.ts",
    });
  } catch {
    return undefined;
  }
  return transform;
};

/** @param {string} url */
const ownedSourcePath = (url) => {
  if (!url.startsWith("file:")) return undefined;
  const path = fileURLToPath(url);
  return sourceRoots.some((root) => {
    const selected = relative(root, path);
    return (
      selected !== ".." &&
      !selected.startsWith(`..${sep}`) &&
      !isAbsolute(selected)
    );
  })
    ? path
    : undefined;
};

/**
 * @param {unknown} cause
 * @returns {string | undefined}
 */
const errorCode = (cause) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

/**
 * @param {string | null | undefined} format
 * @returns {string | null | undefined}
 */
const javascriptFormat = (format) =>
  format === "module-typescript"
    ? "module"
    : format === "commonjs-typescript"
      ? "commonjs"
      : format;

/** @param {nodeModule.ResolveFnOutput} resolution */
const sourceResolution = (resolution) => {
  const path = ownedSourcePath(resolution.url);
  return path !== undefined && [".ts", ".mts"].includes(extname(path))
    ? { ...resolution, format: javascriptFormat(resolution.format) }
    : resolution;
};

/**
 * TypeScript source a missing `.js` or `.mjs` specifier names, as this loader resolves it.
 * @param {string} path
 */
export const typeScriptSourcePath = (path) => {
  const extension = extname(path);
  if (extension !== ".js" && extension !== ".mjs") return undefined;
  return (
    path.slice(0, -extension.length) + (extension === ".js" ? ".ts" : ".mts")
  );
};

/** @type {nodeModule.ResolveHookSync} */
const resolveSource = (specifier, context, nextResolve) => {
  try {
    return sourceResolution(nextResolve(specifier, context));
  } catch (cause) {
    if (
      errorCode(cause) !== "ERR_MODULE_NOT_FOUND" ||
      context.parentURL === undefined ||
      ownedSourcePath(context.parentURL) === undefined ||
      !(specifier.startsWith("./") || specifier.startsWith("../"))
    )
      throw cause;
    const selected = new URL(specifier, context.parentURL);
    const path = ownedSourcePath(selected.href);
    if (path === undefined) throw cause;
    const source = typeScriptSourcePath(path);
    if (source === undefined) throw cause;
    try {
      if (!statSync(source).isFile()) throw cause;
    } catch (failure) {
      const code = errorCode(failure);
      if (code === "ENOENT" || code === "ENOTDIR") throw cause;
      throw failure;
    }
    const candidate = pathToFileURL(source);
    candidate.search = selected.search;
    candidate.hash = selected.hash;
    return sourceResolution(nextResolve(candidate.href, context));
  }
};

/** @type {nodeModule.LoadHookSync} */
const loadSource = (url, context, nextLoad) => {
  const path = ownedSourcePath(url);
  if (path === undefined || ![".ts", ".mts"].includes(extname(path)))
    return nextLoad(url, context);
  const loaded = nextLoad(url, context);
  const format = javascriptFormat(loaded.format);
  if (format !== "module" && format !== "commonjs") return loaded;
  const transform = transformTypeScript;
  if (transform === undefined)
    throw new TypeError(
      `Verifier TypeScript transform was unavailable: ${url}`,
    );
  let source;
  if (typeof loaded.source === "string") source = loaded.source;
  else if (ArrayBuffer.isView(loaded.source))
    source = Buffer.from(
      loaded.source.buffer,
      loaded.source.byteOffset,
      loaded.source.byteLength,
    ).toString("utf8");
  else if (loaded.source instanceof ArrayBuffer)
    source = Buffer.from(loaded.source).toString("utf8");
  else throw new TypeError(`Verifier module source was unavailable: ${url}`);
  return {
    ...loaded,
    format,
    source: transform(source, {
      mode: "transform",
      sourceMap: true,
      sourceUrl: url,
    }),
  };
};

/**
 * Import this checkout's verifier source without starting a compiler process.
 * One process-lifetime hook and Node's URL-keyed module cache share the source
 * graph across owners. No transformed output is cached across Node versions.
 * @param {string} url
 * @param {string} parent
 * @returns {Promise<Record<string, unknown>>}
 */
export const importVerifierSource = async (url, parent) => {
  transformTypeScript ??= supportedTransform();
  if (
    typeof nodeModule.registerHooks !== "function" ||
    transformTypeScript === undefined
  )
    throw new Error(
      "This REA source loader requires the Node.js version pinned in .nvmrc; run nvm use and invoke source build and verifier scripts with node and npm. Installed REA packages have separate runtime support.",
    );
  hooks ??= nodeModule.registerHooks({
    resolve: resolveSource,
    load: loadSource,
  });
  return import(new URL(url, parent).href);
};
