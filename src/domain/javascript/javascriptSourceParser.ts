import { posix } from "node:path";
import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";
import * as t from "@babel/types";
import { isRecord } from "../../kernel/isRecord.js";
import { isJavaScriptSourcePath } from "./javascriptArtifactFiles.js";
import { ParseFailureError } from "../parseFailure.js";
import { javaScriptDefinitionExpression } from "./javascriptAstValues.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
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

/** Babel AST with diagnostics from both syntax and REA's loader grammar owner. */
export type ParsedJavaScriptSource = t.File & {
  errors: (
    | ReturnType<typeof parse>["errors"][number]
    | JavaScriptLoaderSyntaxError
  )[];
};

/** An early error for Node's implicit wrapper, which Babel does not seed. */
export class JavaScriptLoaderSyntaxError extends ParseFailureError<"malformed"> {
  override readonly name = "JavaScriptLoaderSyntaxError";
  readonly reasonCode = "CommonJsWrapperLexicalDeclaration";
  readonly pos: number;
  readonly loc: {
    readonly line: number;
    readonly column: number;
    readonly index: number;
  };

  constructor(binding: t.Identifier) {
    const start = binding.loc?.start;
    if (start === undefined || binding.start == null)
      throw new TypeError("Parsed wrapper binding has no source location");
    super({
      kind: "malformed",
      format: "javascript-commonjs",
      field: binding.name,
      detail: `Identifier '${binding.name}' redeclares a CommonJS wrapper parameter. (${start.line}:${start.column})`,
    });
    this.pos = binding.start;
    this.loc = { line: start.line, column: start.column, index: binding.start };
  }
}

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

/** A declaration file has no executing wrapper, even when its suffix is .cts. */
const hasCommonJsRuntime = (
  sourcePath: string | undefined,
  packageContext: JavaScriptPackageType | undefined,
): boolean => {
  const filenameMode = explicitJavaScriptLoaderMode(sourcePath);
  return filenameMode === "commonjs"
    ? !/\.d\.cts$/iu.test(sourcePath ?? "")
    : filenameMode === undefined && packageContext === "commonjs";
};

/** TypeScript's own syntax phase does not admit JavaScript wrapper-only syntax. */
const hasCommonJsWrapper = (
  sourcePath: string | undefined,
  packageContext: JavaScriptPackageType | undefined,
): boolean =>
  hasCommonJsRuntime(sourcePath, packageContext) &&
  [".cjs", ".js"].includes(posix.extname(sourcePath ?? ""));

/** Node detects the loader of ordinary .js files in an observed untyped package. */
const detectsJavaScriptLoader = (
  sourcePath: string | undefined,
  packageContext: JavaScriptPackageType | undefined,
): boolean =>
  packageContext === "unspecified" && posix.extname(sourcePath ?? "") === ".js";

const COMMONJS_WRAPPER_PARAMETERS = new Set([
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
]);

/** Token recovery drops syntax. A wrapper redeclaration does not. */
export const recoveredJavaScriptSyntaxErrorCount = (
  errors: readonly ParsedJavaScriptSource["errors"][number][],
): number =>
  errors.filter((error) => !(error instanceof JavaScriptLoaderSyntaxError))
    .length;

/** Top-level lexical names that collide with Node's CommonJS parameters. */
export const commonJsWrapperRedeclarationCount = (
  errors: readonly ParsedJavaScriptSource["errors"][number][],
): number =>
  errors.filter((error) => error instanceof JavaScriptLoaderSyntaxError).length;

/** Only top-level lexical bindings conflict with the wrapper's parameters. */
const lexicalWrapperBindings = (program: t.Program): t.Identifier[] => {
  const bindings = new Map<string, t.Identifier>();
  for (const statement of program.body) {
    if (
      !(t.isVariableDeclaration(statement) && statement.kind !== "var") &&
      !t.isClassDeclaration(statement)
    )
      continue;
    for (const identifier of Object.values(t.getBindingIdentifiers(statement)))
      if (
        COMMONJS_WRAPPER_PARAMETERS.has(identifier.name) &&
        !bindings.has(identifier.name)
      )
        bindings.set(identifier.name, identifier);
  }
  return [...bindings.values()];
};

/** Own filename/package grammar and Babel's mode-specific option restrictions. */
const parserOptionsForLoader = (
  sourcePath: string | undefined,
  options: ParserOptions,
  packageContext?: JavaScriptPackageType,
): ParserOptions => {
  const filenameMode = explicitJavaScriptLoaderMode(sourcePath);
  const module =
    filenameMode === "module" ||
    (filenameMode === undefined && packageContext === "module");
  // Apply observed loader facts before parsing, not just to the resulting
  // semantic context. Recovery options must not admit a wrapper return in ESM.
  const parserOptions: ParserOptions = {
    ...options,
    plugins: options.plugins ?? parserPluginsForPath(sourcePath),
    ...(module
      ? {
          sourceType: "module",
          allowReturnOutsideFunction: false,
          allowNewTargetOutsideFunction: false,
        }
      : options.sourceType === "script" &&
          hasCommonJsWrapper(sourcePath, packageContext)
        ? {
            allowReturnOutsideFunction: true,
            allowNewTargetOutsideFunction: true,
          }
        : detectsJavaScriptLoader(sourcePath, packageContext) ||
            isTypeScriptSourcePath(sourcePath)
          ? {
              allowReturnOutsideFunction: false,
              allowNewTargetOutsideFunction: false,
            }
          : {}),
  };
  if (parserOptions.sourceType === "commonjs") {
    // Babel owns wrapper semantics in this mode and rejects explicit overrides.
    delete parserOptions.allowAwaitOutsideFunction;
    delete parserOptions.allowReturnOutsideFunction;
    delete parserOptions.allowNewTargetOutsideFunction;
  }
  return parserOptions;
};

/** Babel drops omitted arguments from recovered calls but diagnoses their commas. */
const restoreOmittedArguments = (
  program: t.Program,
  errors: readonly { reasonCode: string; details: unknown; pos: number }[],
): void => {
  const commas = errors
    .filter(
      ({ reasonCode, details }) =>
        reasonCode === "UnexpectedToken" &&
        isRecord(details) &&
        details.unexpected === ",",
    )
    .map(({ pos }) => pos - 1)
    .sort((a, b) => a - b);
  if (commas.length === 0) return;

  const countBefore = (offset: number): number => {
    let low = 0;
    let high = commas.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (commas[mid]! < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  // Recovery in Babel 8.1.2 represented each omission with an explicit null.
  const appendOmissions = (slots: (t.Node | null)[], count: number): void => {
    for (let i = 0; i < count; i++) slots.push(null);
  };
  traverseJavaScriptAst(program, {
    enter(node) {
      if (
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node) &&
        !t.isNewExpression(node)
      )
        return;
      const start = node.typeArguments?.end ?? node.callee.end;
      if (start == null || node.end == null) return;
      let cursor = countBefore(start);
      const end = countBefore(node.end);
      if (cursor === end) return;

      // Only gaps between argument spans belong to this list. A diagnostic
      // inside an argument belongs to a nested expression.
      const slots: typeof node.arguments = [];
      for (const argument of node.arguments) {
        if (argument.start == null || argument.end == null) return;
        appendOmissions(slots, countBefore(argument.start) - cursor);
        slots.push(argument);
        cursor = countBefore(argument.end);
      }
      appendOmissions(slots, end - cursor);
      if (slots.length !== node.arguments.length) node.arguments = slots;
    },
  });
};

/** Keep optional Babel metadata omitted in the parser-owned File representation. */
const parseBabelFile = (
  source: string,
  options: ParserOptions,
): ParsedJavaScriptSource => {
  const { comments, tokens, errors, ...file } = parse(source, options);
  if (errors.length > 0) restoreOmittedArguments(file.program, errors);
  return {
    ...file,
    // Babel couples the ambiguous generic-arrow diagnostic with a legacy
    // assertion restriction. Modern TypeScript accepts the recovered assertion.
    errors:
      errors.length === 0
        ? errors
        : errors.filter(
            ({ reasonCode }) => reasonCode !== "ReservedTypeAssertion",
          ),
    ...(comments === undefined ? {} : { comments }),
    ...(tokens === undefined ? {} : { tokens }),
  };
};

const parseWithLoaderGrammar = (
  source: string,
  sourcePath: string | undefined,
  options: ParserOptions,
  packageContext?: JavaScriptPackageType,
): ParsedJavaScriptSource => {
  let file = parseBabelFile(
    source,
    parserOptionsForLoader(sourcePath, options, packageContext),
  );
  const wrapper = hasCommonJsWrapper(sourcePath, packageContext);
  const detecting = detectsJavaScriptLoader(sourcePath, packageContext);
  const wrapperBindings =
    wrapper || detecting ? lexicalWrapperBindings(file.program) : [];
  if (
    detecting &&
    file.program.sourceType === "script" &&
    wrapperBindings.length > 0
  ) {
    // Babel's unambiguous mode detects import/export but not Node's lexical
    // wrapper-parameter criterion. Such a source needs module grammar first.
    file = parseBabelFile(
      source,
      parserOptionsForLoader(
        sourcePath,
        {
          ...options,
          sourceType: "module",
        },
        packageContext,
      ),
    );
  }
  if (wrapper && file.program.sourceType === "script")
    for (const identifier of wrapperBindings) {
      // Babel's CommonJS mode admits wrapper-only syntax but does not seed
      // the wrapper parameters, so retain their early error in the same AST.
      file.errors.push(new JavaScriptLoaderSyntaxError(identifier));
    }
  return file;
};

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
  const compilerSource =
    /\.jsx$/iu.test(sourcePath ?? "") || isTypeScriptSourcePath(sourcePath);
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
  const file = parseWithLoaderGrammar(
    hashbangSignature ? source.slice(1) : source,
    sourcePath,
    hashbangSignature
      ? {
          ...parserOptions,
          ...(observedModuleDotfile ? { sourceType: "module" as const } : {}),
          startIndex: (options.startIndex ?? 0) + 1,
          startColumn: (options.startColumn ?? 0) + 1,
        }
      : options,
    packageContext,
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

const sourceSyntaxPlugins: ParserPlugin[] = [
  "decorators-legacy",
  "sourcePhaseImports",
];
const javaScriptPlugins = (): ParserPlugin[] => [...sourceSyntaxPlugins, "jsx"];
const typeScriptSourceSuffix =
  /\.(?:(?<declaration>d)\.)?(?:(?<module>[cm])ts|ts(?<jsx>x)?)$/iu;

/** Whether the filename supplies TypeScript grammar, independent of loader mode. */
export const isTypeScriptSourcePath = (sourcePath?: string): boolean =>
  typeScriptSourceSuffix.test(sourcePath ?? "");

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
 *   declaration files. `.cts/.mts` and their declaration files report
 *   ambiguous generic arrows using Babel's explicit-module-suffix option.
 * - `sourcePhaseImports` retains Node-supported WASM source imports as AST data.
 * - `decorators-legacy` always present: without it decorated sources fail
 *   hard instead of reporting recovered syntax, losing every derived fact.
 * - Unknown paths retain the existing JSX- and TypeScript-capable contract
 *   (best-effort parse; failures surface via `errorRecovery`).
 */
const parserPluginsForPath = (sourcePath?: string): ParserPlugin[] => {
  const path = sourcePath ?? "";
  if (/\.(?:js|jsx|mjs|cjs)$/iu.test(path)) return javaScriptPlugins();
  const suffix = typeScriptSourceSuffix.exec(path)?.groups;
  const jsx = suffix?.jsx !== undefined;
  const dts = suffix?.declaration !== undefined && !jsx;
  const typescript: ParserPlugin = [
    "typescript",
    {
      dts,
      ...(suffix?.module === undefined
        ? {}
        : { disallowAmbiguousJSXLike: true }),
    },
  ];
  const jsxCapable = suffix === undefined || jsx;
  return jsxCapable
    ? [...sourceSyntaxPlugins, "jsx", typescript]
    : [...sourceSyntaxPlugins, typescript];
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
  options: Omit<ParserOptions, "sourceType" | "errorRecovery" | "plugins">,
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
    return {
      file: parseWithRuntimeContext(
        source,
        sourcePath,
        {
          ...options,
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
      sourceType:
        hasCommonJsWrapper(sourcePath, packageContext) ||
        detectsJavaScriptLoader(sourcePath, packageContext)
          ? "commonjs"
          : "script",
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

const parseStaticJavaScriptSource = (
  source: string,
  sourcePath: string | undefined,
  observedPackageType: JavaScriptPackageType | undefined,
  plugins?: ParserPlugin[],
): ParsedJavaScriptSource | null => {
  try {
    const runtimeSourceType = runtimeSourceTypeForPath(sourcePath);
    const commonjs = runtimeSourceType === "commonjs";
    const packageContext = packageContextForPath(
      sourcePath,
      observedPackageType,
    );
    const options = {
      errorRecovery: true,
      attachComment: false,
      ...(plugins === undefined ? {} : { plugins }),
    };
    const file = parseWithRuntimeContext(
      source,
      sourcePath,
      {
        ...options,
        // Inert artifact analysis retains module declarations even in .cjs assets.
        // Infer their syntax here; reference imports keep filename-mode diagnostics.
        sourceType: commonjs ? "unambiguous" : runtimeSourceType,
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
    return (hasCommonJsRuntime(sourcePath, packageContext) ||
      detectsJavaScriptLoader(sourcePath, packageContext)) &&
      file.program.sourceType === "script" &&
      file.errors.length > 0
      ? parseWithRuntimeContext(
          source,
          sourcePath,
          {
            ...options,
            sourceType:
              hasCommonJsWrapper(sourcePath, packageContext) ||
              detectsJavaScriptLoader(sourcePath, packageContext)
                ? "commonjs"
                : "script",
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

/**
 * Parse inert JavaScript or TypeScript facts without attaching comments to AST
 * nodes. An observed package type selects the runtime context of .js/.ts
 * sources as it does for reference imports, including their wrapper grammar.
 */
export const parseJavaScriptSource = (
  source: string,
  sourcePath?: string,
  observedPackageType?: JavaScriptPackageType,
): ParsedJavaScriptSource | null =>
  parseStaticJavaScriptSource(source, sourcePath, observedPackageType);

/** An observed browser language selects syntax without implying a Node loader. */
export const parseCapturedJavaScriptSource = (
  source: string,
  observedLanguage: string | null,
): ParsedJavaScriptSource | null =>
  parseStaticJavaScriptSource(
    source,
    undefined,
    undefined,
    observedLanguage === "JavaScript" ? javaScriptPlugins() : undefined,
  );

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
