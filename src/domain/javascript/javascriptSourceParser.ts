import { posix } from "node:path";
import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";
import { isJavaScriptSourcePath } from "./javascriptArtifactFiles.js";
import { javaScriptDefinitionExpression } from "./javascriptAstValues.js";
import {
  explicitJavaScriptLoaderMode,
  hasCaseVariantJavaScriptLoaderSuffix,
} from "./javascriptModuleResolutionMode.js";
import {
  hasOnlyInlineTypeExportSpecifiers,
  hasOnlyInlineTypeImportSpecifiers,
  isTypeOnlyExportDeclaration,
  isTypeOnlyImportDeclaration,
  isErasedJavaScriptDeclaration,
  semanticImportEqualsSpecifier,
} from "./javascriptModuleDeclaration.js";

/** Babel AST produced by REA's inert JavaScript parser boundary. */
export type ParsedJavaScriptSource = ReturnType<typeof parse>;

// Babel's module classification includes erased TypeScript syntax. Keep the
// runtime proof separate, including explicit filename mode, for every parser entry.
type JavaScriptRuntimeContext = "module" | "commonjs" | "unknown";
/** Package scope observed inside a source inventory; missing scope is unknown. */
export type JavaScriptPackageType =
  | "module"
  | "commonjs"
  | "unspecified"
  | "unknown";

const contextByProgram = new WeakMap<
  t.Program,
  {
    readonly runtime: JavaScriptRuntimeContext;
    readonly loaderCondition?: string;
  }
>();

/** Only parser-owned facts establish module or CommonJS wrapper isolation. */
export const javaScriptRuntimeContext = (
  program: t.Program,
): JavaScriptRuntimeContext =>
  contextByProgram.get(program)?.runtime ?? "unknown";

/** A recovered grammar does not prove which loader applies to the source. */
export const javaScriptSourceLoaderCondition = (
  program: t.Program,
): string | undefined => contextByProgram.get(program)?.loaderCondition;

/** A suffix-only source name has no extension in Node's module-import dispatch. */
const isSuffixOnlySourcePath = (path: string | undefined): boolean =>
  path !== undefined &&
  posix.extname(path) === "" &&
  isJavaScriptSourcePath(path);

/** Runtime strictness follows parser-owned mode, not erased TypeScript syntax. */
export const javaScriptProgramStrictness = (
  program: t.Program,
): "strict" | "sloppy" | "unknown" => {
  if (program.directives.some(({ value }) => value.value === "use strict"))
    return "strict";
  const context = javaScriptRuntimeContext(program);
  return context === "module"
    ? "strict"
    : context === "commonjs"
      ? "sloppy"
      : "unknown";
};

/** Runtime strictness of the code at `node`: classes, directives, then the program. */
export const javaScriptStrictnessAt = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): "strict" | "sloppy" | "unknown" => {
  for (
    let current: t.Node | undefined = node;
    current !== undefined;
    current = parents.get(current)
  ) {
    if (t.isClass(current)) return "strict";
    if (
      t.isFunction(current) &&
      t.isBlockStatement(current.body) &&
      current.body.directives.some(({ value }) => value.value === "use strict")
    )
      return "strict";
    if (t.isProgram(current)) return javaScriptProgramStrictness(current);
  }
  return "unknown";
};

const hasRuntimeModuleDeclaration = (program: t.Program): boolean =>
  program.body.some((node) => {
    if (t.isTSImportEqualsDeclaration(node))
      return semanticImportEqualsSpecifier(node) !== null;
    if (t.isImportDeclaration(node))
      return (
        !isTypeOnlyImportDeclaration(node) &&
        !hasOnlyInlineTypeImportSpecifiers(node)
      );
    if (t.isExportNamedDeclaration(node) || t.isExportAllDeclaration(node))
      return (
        !isTypeOnlyExportDeclaration(node) &&
        (!t.isExportNamedDeclaration(node) ||
          (!hasOnlyInlineTypeExportSpecifiers(node) &&
            (node.declaration == null ||
              !isErasedJavaScriptDeclaration(node.declaration))))
      );
    return (
      t.isExportDefaultDeclaration(node) &&
      !isErasedJavaScriptDeclaration(node.declaration)
    );
  });

const parseWithRuntimeContext = (
  source: string,
  sourcePath: string | undefined,
  options: ParserOptions,
  observedPackageType?: JavaScriptPackageType,
): ParsedJavaScriptSource => {
  const filenameMode = explicitJavaScriptLoaderMode(sourcePath);
  const packageContext = packageContextForPath(sourcePath, observedPackageType);
  const suffixOnlySource = isSuffixOnlySourcePath(sourcePath);
  const ambiguousHashbangPath =
    posix.extname(sourcePath ?? "") === ".js" || suffixOnlySource;
  // Dotfile entrypoints have no extname. Their package can explain signature
  // preprocessing, but must not grant wrapper/module authority to ordinary data.
  const signaturePackageContext = ambiguousHashbangPath
    ? observedPackageType
    : packageContext;
  // ESM and TypeScript file loading remove the UTF-8 signature before a
  // hashbang; JavaScript CommonJS loading does not. Preserve original indexes
  // through Babel's origin options rather than repairing downstream ranges.
  const compilerSource = /\.(?:jsx|ts|tsx|mts|cts)$/iu.test(sourcePath ?? "");
  const signedHashbang = source.startsWith("\uFEFF#!");
  const conditionalCommonJs =
    signedHashbang &&
    !compilerSource &&
    (filenameMode === "commonjs" || signaturePackageContext === "commonjs");
  const compilerCommonJsDotfile =
    compilerSource &&
    suffixOnlySource &&
    signaturePackageContext === "commonjs";
  const observedModuleDotfile =
    suffixOnlySource && signaturePackageContext === "module";
  const ambiguousLoader =
    signedHashbang &&
    ambiguousHashbangPath &&
    (signaturePackageContext === undefined ||
      signaturePackageContext === "unknown" ||
      signaturePackageContext === "unspecified" ||
      observedModuleDotfile ||
      compilerCommonJsDotfile);
  const loaderCondition = conditionalCommonJs
    ? `Source in ${sourcePath ?? "<unknown>"} is recovered as CommonJS when imported through the ES module loader. Direct execution and require can reject this BOM/hashbang.`
    : ambiguousLoader
      ? observedModuleDotfile
        ? `Source in ${sourcePath ?? "<unknown>"} is recovered under an ES module interpretation. Its loader invocation is unknown; direct entrypoint and module import can differ.`
        : compilerCommonJsDotfile
          ? `Source in ${sourcePath ?? "<unknown>"} is recovered with compiler syntax. Its loader invocation is conditional: direct CommonJS loading can reject this BOM/hashbang.`
          : `Source in ${sourcePath ?? "<unknown>"} is recovered under a conditional loader interpretation. Its package loader mode is unknown.`
      : undefined;
  const hashbangSignature =
    signedHashbang &&
    (compilerSource ||
      conditionalCommonJs ||
      ambiguousLoader ||
      filenameMode === "module" ||
      (filenameMode === undefined && signaturePackageContext === "module"));
  const parserOptions = { ...options };
  if (conditionalCommonJs) {
    parserOptions.sourceType = "commonjs";
    delete parserOptions.allowAwaitOutsideFunction;
    delete parserOptions.allowReturnOutsideFunction;
    delete parserOptions.allowNewTargetOutsideFunction;
  }
  const file = parse(
    hashbangSignature ? source.slice(1) : source,
    hashbangSignature
      ? {
          ...parserOptions,
          ...(observedModuleDotfile ? { sourceType: "module" as const } : {}),
          startIndex: (options.startIndex ?? 0) + 1,
          startColumn: (options.startColumn ?? 0) + 1,
        }
      : options,
  );
  const runtime =
    conditionalCommonJs && suffixOnlySource
      ? "commonjs"
      : ambiguousLoader
        ? "unknown"
        : filenameMode === "commonjs"
          ? sourcePath?.toLowerCase().endsWith(".d.cts")
            ? "unknown"
            : "commonjs"
          : filenameMode === "module"
            ? "module"
            : packageContext === "module" || packageContext === "commonjs"
              ? packageContext
              : packageContext === "unspecified" &&
                  posix.extname(sourcePath ?? "") === ".js"
                ? file.program.sourceType === "module"
                  ? "module"
                  : "commonjs"
                : hasCaseVariantJavaScriptLoaderSuffix(sourcePath)
                  ? "unknown"
                  : file.program.body.some((node) =>
                        t.isTSExportAssignment(node),
                      )
                    ? // CommonJS isolation does not establish strict ESM semantics.
                      "commonjs"
                    : file.program.sourceType === "module" &&
                        hasRuntimeModuleDeclaration(file.program)
                      ? "module"
                      : "unknown";
  contextByProgram.set(file.program, {
    runtime,
    ...(loaderCondition === undefined ? {} : { loaderCondition }),
  });
  return file;
};

/**
 * Babel plugins for one source path. Single owner for TypeScript/JSX
 * mode selection (tsc + Babel `typescript` plugin semantics).
 *
 * - `dts:true` only for `.d.ts/.d.mts/.d.cts` ambient declarations;
 *   ordinary `.ts` keeps the missing-initializer diagnostic.
 * - `.js/.jsx/.mjs/.cjs` use JavaScript grammar with JSX. TypeScript reads
 *   some valid JavaScript differently (`c?x=>(a):y=>(b)` as a return type,
 *   `a<b>(c)` as a generic call), so it must not select their meaning.
 * - JSX enabled for `.tsx` and unknown paths; disabled for plain
 *   `.ts/.cts/.mts` (angle-bracket assertions, not JSX) and for all
 *   declaration files. `.mts` (including `.d.mts`) sets
 *   `disallowAmbiguousJSXLike`, matching tsc's `.mts` mode.
 * - `sourcePhaseImports` retains Node-supported WASM source imports as AST data.
 * - `decorators-legacy` always present: without it decorated sources fail
 *   hard instead of reporting recovered syntax, losing every derived fact.
 * - Unknown paths retain the existing JSX- and TypeScript-capable contract
 *   (best-effort parse; failures surface via `errorRecovery`).
 */
export const parserPluginsForPath = (sourcePath?: string): ParserPlugin[] => {
  const path = sourcePath ?? "";
  const syntax: ParserPlugin[] = ["decorators-legacy", "sourcePhaseImports"];
  if (/\.(?:js|jsx|mjs|cjs)$/iu.test(path)) return [...syntax, "jsx"];
  const dts = /\.d\.(?:ts|mts|cts)$/iu.test(path);
  const isTsLike = /\.(?:ts|cts|mts)$/iu.test(path);
  const isTsx = /\.tsx$/iu.test(path);
  const isMts = /\.mts$/iu.test(path);
  const typescript: ParserPlugin = [
    "typescript",
    {
      dts,
      ...(isMts ? { disallowAmbiguousJSXLike: true } : {}),
    },
  ];
  const jsxCapable = !dts && (isTsx || !isTsLike);
  return jsxCapable ? [...syntax, "jsx", typescript] : [...syntax, typescript];
};

const runtimeSourceTypeForPath = (
  path?: string,
): "commonjs" | "module" | "unambiguous" =>
  explicitJavaScriptLoaderMode(path) === "commonjs" && path?.endsWith(".cjs")
    ? "commonjs"
    : explicitJavaScriptLoaderMode(path) === "module"
      ? "module"
      : "unambiguous";

/**
 * Node package facts apply to .js/.ts sources, not explicit suffixes,
 * declaration wrappers, or an unknown JSX compilation pipeline.
 */
const packageContextForPath = (
  sourcePath: string | undefined,
  observedPackageType: JavaScriptPackageType | undefined,
): JavaScriptPackageType | undefined =>
  [".js", ".ts"].includes(posix.extname(sourcePath ?? "")) &&
  !/\.d\.ts$/iu.test(sourcePath ?? "")
    ? observedPackageType
    : undefined;

export interface RecoveredJavaScriptParse {
  readonly file: ParsedJavaScriptSource;
  /** Errors that apply only if a source of unknown mode is an ES module. */
  readonly moduleOnlyErrors: readonly string[];
}

/**
 * Parse a module or script with recovery. Babel tries module mode first and
 * keeps its strict-mode errors after falling back to a script, so a script
 * with errors is parsed again as a script. Strict errors that only the module
 * parse reports stay visible because the source may still be a module.
 */
export const parseRecoveredJavaScript = (
  source: string,
  sourcePath: string | undefined,
  options: Omit<ParserOptions, "sourceType" | "errorRecovery">,
  observedPackageType?: JavaScriptPackageType,
): RecoveredJavaScriptParse => {
  const filenameType = runtimeSourceTypeForPath(sourcePath);
  const packageContext = packageContextForPath(sourcePath, observedPackageType);
  // Retain TypeScript import syntax for later CommonJS compilation.
  const sourceType =
    filenameType !== "unambiguous"
      ? filenameType
      : packageContext === "module"
        ? "module"
        : packageContext === "commonjs" &&
            posix.extname(sourcePath ?? "") === ".js"
          ? "commonjs"
          : "unambiguous";
  if (sourceType !== "unambiguous") {
    const normalizedOptions = { ...options };
    if (sourceType === "commonjs") {
      // Babel owns these wrapper semantics in CommonJS mode and rejects
      // explicit script overrides, including the reference-import options.
      delete normalizedOptions.allowAwaitOutsideFunction;
      delete normalizedOptions.allowReturnOutsideFunction;
      delete normalizedOptions.allowNewTargetOutsideFunction;
    }
    return {
      file: parseWithRuntimeContext(
        source,
        sourcePath,
        {
          ...normalizedOptions,
          sourceType,
          errorRecovery: true,
        },
        observedPackageType,
      ),
      moduleOnlyErrors: [],
    };
  }
  const file = parseWithRuntimeContext(
    source,
    sourcePath,
    {
      ...options,
      sourceType: "unambiguous",
      errorRecovery: true,
    },
    observedPackageType,
  );
  if (file.program.sourceType !== "script" || file.errors.length === 0)
    return { file, moduleOnlyErrors: [] };
  const script = parseWithRuntimeContext(
    source,
    sourcePath,
    {
      ...options,
      sourceType: "script",
      errorRecovery: true,
    },
    observedPackageType,
  );
  const scriptErrors = new Set(script.errors.map((error) => error.message));
  return {
    file: script,
    moduleOnlyErrors:
      javaScriptRuntimeContext(script.program) === "commonjs"
        ? []
        : file.errors
            .map((error) => error.message)
            .filter((message) => !scriptErrors.has(message)),
  };
};

/**
 * Parse inert JavaScript or TypeScript facts without attaching comments to AST
 * nodes. An observed package type selects the runtime context of .js/.ts
 * sources as it does for reference imports; syntax recovery is unchanged.
 */
export const parseJavaScriptSource = (
  source: string,
  sourcePath?: string,
  observedPackageType?: JavaScriptPackageType,
): ParsedJavaScriptSource | null => {
  try {
    const runtimeSourceType = runtimeSourceTypeForPath(sourcePath);
    const commonjs = runtimeSourceType === "commonjs";
    const options = {
      errorRecovery: true,
      attachComment: false,
      plugins: parserPluginsForPath(sourcePath),
    };
    const file = parseWithRuntimeContext(
      source,
      sourcePath,
      {
        ...options,
        // Inert artifact analysis retains module declarations even in .cjs assets.
        // Infer their syntax here; reference imports keep filename-mode diagnostics.
        sourceType: commonjs ? "unambiguous" : runtimeSourceType,
        allowReturnOutsideFunction: commonjs,
        allowNewTargetOutsideFunction: commonjs,
      },
      observedPackageType,
    );
    // Unambiguous mode retains module-only diagnostics after choosing a script.
    // The .cjs extension establishes wrapper mode, so obtain its own diagnostics.
    if (
      !commonjs &&
      file.program.sourceType === "script" &&
      file.errors.length > 0 &&
      javaScriptSourceLoaderCondition(file.program) !== undefined &&
      javaScriptRuntimeContext(file.program) === "unknown"
    )
      return parseWithRuntimeContext(
        source,
        sourcePath,
        { ...options, sourceType: "script" },
        observedPackageType,
      );
    return commonjs &&
      file.program.sourceType === "script" &&
      file.errors.length > 0
      ? parseWithRuntimeContext(
          source,
          sourcePath,
          {
            ...options,
            sourceType: "commonjs",
          },
          observedPackageType,
        )
      : file;
  } catch (cause: unknown) {
    // Unparseable source is represented by the null return.
    void cause;
    return null;
  }
};

/** A script's top-level lexical this may be its ambient global; wrappers and modules isolate it. */
export const javaScriptThisOwner = (
  node: t.ThisExpression,
  program: t.Program,
  parents: WeakMap<t.Node, t.Node>,
): "global" | "caller" | "isolated" => {
  let child: t.Node = node;
  let classDefinitionExpression = false;
  let current: t.Node | undefined = parents.get(node);
  while (current !== undefined && current !== program) {
    const definitionExpression = javaScriptDefinitionExpression(current, child);
    if (definitionExpression && !t.isObjectMethod(current))
      classDefinitionExpression = true;
    if (
      (t.isClassProperty(current) ||
        t.isClassPrivateProperty(current) ||
        t.isClassAccessorProperty(current)) &&
      current.value === child
    )
      return "isolated";
    if (t.isStaticBlock(current)) return "isolated";
    if (
      t.isFunction(current) &&
      !t.isArrowFunctionExpression(current) &&
      !definitionExpression
    )
      return "caller";
    if (
      t.isClass(current) &&
      current.superClass !== child &&
      !classDefinitionExpression
    )
      return "isolated";
    if (t.isClass(current)) classDefinitionExpression = false;
    child = current;
    current = parents.get(current);
  }
  return current === program && javaScriptRuntimeContext(program) === "unknown"
    ? "global"
    : "isolated";
};
