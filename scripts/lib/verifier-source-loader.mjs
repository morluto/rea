import { statSync } from "node:fs";
import * as nodeModule from "node:module";
import { extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoots = [
  fileURLToPath(new URL("../../src/", import.meta.url)),
  fileURLToPath(new URL("./", import.meta.url)),
];
let hooks;

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

const errorCode = (cause) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;

/**
 * Transform one owned TypeScript module for import.
 *
 * Node 22-25 transform TypeScript in-process. Node 26 keeps only
 * `mode: "strip"`, which rejects syntax this checkout relies on (parameter
 * properties, enums), so fall back to the pinned compiler the build already
 * installs: `compile:termux` and these scripts then share one TypeScript
 * version instead of depending on a Node flag that no longer exists.
 */
const nodeTypeScriptTransform = (() => {
  try {
    nodeModule.stripTypeScriptTypes("const probe: number = 1;", {
      mode: "transform",
    });
    return (source, url) =>
      nodeModule.stripTypeScriptTypes(source, {
        mode: "transform",
        sourceMap: true,
        sourceUrl: url,
      });
  } catch {
    return undefined;
  }
})();

let pinnedCompiler;
const loadPinnedCompiler = () => {
  if (pinnedCompiler !== undefined) return pinnedCompiler;
  const require = nodeModule.createRequire(import.meta.url);
  for (const name of ["typescript-termux", "typescript6", "typescript"]) {
    try {
      const candidate = require(name);
      if (typeof candidate?.transpileModule === "function")
        return (pinnedCompiler = candidate);
    } catch {
      // Try the next installed alias; the loop owns the final error.
    }
  }
  throw new Error(
    "This REA source loader needs Node's TypeScript transform or the pinned TypeScript compiler; run npm ci.",
  );
};

const transformTypeScript = (source, url, format) => {
  if (nodeTypeScriptTransform !== undefined)
    return nodeTypeScriptTransform(source, url);
  const compiler = loadPinnedCompiler();
  const { outputText } = compiler.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      target: compiler.ScriptTarget.ESNext,
      module:
        format === "commonjs"
          ? compiler.ModuleKind.CommonJS
          : compiler.ModuleKind.ESNext,
      inlineSourceMap: true,
      inlineSources: true,
      verbatimModuleSyntax: false,
    },
  });
  return outputText;
};

const javascriptFormat = (format) =>
  format === "module-typescript"
    ? "module"
    : format === "commonjs-typescript"
      ? "commonjs"
      : format;

const sourceResolution = (resolution) => {
  const path = ownedSourcePath(resolution.url);
  return path !== undefined && [".ts", ".mts"].includes(extname(path))
    ? { ...resolution, format: javascriptFormat(resolution.format) }
    : resolution;
};

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
    const extension = extname(path);
    if (extension !== ".js" && extension !== ".mjs") throw cause;
    const source =
      path.slice(0, -extension.length) + (extension === ".js" ? ".ts" : ".mts");
    try {
      if (!statSync(source).isFile()) throw cause;
    } catch (failure) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(failure))) throw cause;
      throw failure;
    }
    const candidate = pathToFileURL(source);
    candidate.search = selected.search;
    candidate.hash = selected.hash;
    return sourceResolution(nextResolve(candidate.href, context));
  }
};

const loadSource = (url, context, nextLoad) => {
  const path = ownedSourcePath(url);
  if (path === undefined || ![".ts", ".mts"].includes(extname(path)))
    return nextLoad(url, context);
  const loaded = nextLoad(url, context);
  const format = javascriptFormat(loaded.format);
  if (format !== "module" && format !== "commonjs") return loaded;
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
    source: transformTypeScript(source, url, format),
  };
};

/**
 * Import this checkout's verifier source without starting a compiler process.
 * One process-lifetime hook and Node's URL-keyed module cache share the source
 * graph across owners. No transformed output is cached across Node versions.
 */
export const importVerifierSource = async (url, parent) => {
  if (
    typeof nodeModule.registerHooks !== "function" ||
    typeof nodeModule.stripTypeScriptTypes !== "function"
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
