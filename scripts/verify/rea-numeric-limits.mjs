import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript6";

// Recognized numeric REA_ limit reads must be an analysis setting or a
// documented exception with a reason. External behavioral witnesses are
// reported separately and are not verified by this Node-only scan.
// Per-call limits belong to ANALYSIS_SETTINGS.
// A name in REQUIRED_RUNTIME_LIMITS that is absent from source fails closed.
// Each default, floor, and maximum in docs/design/rea-limit-inventory.md must
// equal ANALYSIS_SETTINGS or the owner export the parser enforces.

const root = fileURLToPath(new URL("../../", import.meta.url));
const definitionsPath = join(root, "src/domain/analysisSettingDefinitions.ts");
// Registry text declares an exception. It does not prove a reader exists.
const NUMERIC_LIMIT_DECLARATION = "src/domain/numericLimitRegistry.ts";
const registryPath = join(root, NUMERIC_LIMIT_DECLARATION);

const listFiles = async (dir) => {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      output.push(...(await listFiles(path)));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".fixture.ts")
    )
      output.push(path);
  }
  return output;
};

/**
 * Limits that must join ANALYSIS_SETTINGS.
 * A producer or a registry entry cannot satisfy that requirement.
 * Membership also treats a non-pattern name as numeric.
 * A required name absent from source is stale and fails closed.
 *
 * @type {readonly string[]}
 */
const REQUIRED_RUNTIME_LIMITS = [];

const unwrapExpression = (node) => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
};

const literalText = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;

/** Resolve a symbol only when a source construct needs lexical ownership. */
const lexicalSymbols = (sourceFile) => {
  let checker;
  return (identifier) => {
    if (checker === undefined) {
      const options = { noLib: true, noResolve: true };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (name) =>
        name === sourceFile.fileName ? sourceFile : undefined;
      checker = ts
        .createProgram([sourceFile.fileName], options, host)
        .getTypeChecker();
    }
    return checker.getSymbolAtLocation(identifier);
  };
};

/** Track only potentially relevant aliases; bind each use lexically before trusting it. */
const stringBindings = (sourceFile, symbols, unresolved) => {
  const candidates = new Set();
  const declarations = [];
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    )
      declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const potential = (node, matchesCandidate) => {
    const expression = unwrapExpression(node);
    if (exactLimit(literalText(expression)) !== undefined) return true;
    if (ts.isIdentifier(expression)) return matchesCandidate(expression);
    if (ts.isPropertyAccessExpression(expression))
      return (
        exactLimit(expression.name.text) !== undefined ||
        potential(expression.expression, matchesCandidate)
      );
    if (ts.isElementAccessExpression(expression))
      return (
        expression.argumentExpression !== undefined &&
        potential(expression.argumentExpression, matchesCandidate)
      );
    if (ts.isObjectLiteralExpression(expression))
      return expression.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          potential(property.initializer, matchesCandidate),
      );
    if (ts.isConditionalExpression(expression))
      return (
        potential(expression.whenTrue, matchesCandidate) ||
        potential(expression.whenFalse, matchesCandidate)
      );
    if (ts.isBinaryExpression(expression))
      return (
        potential(expression.left, matchesCandidate) ||
        potential(expression.right, matchesCandidate)
      );
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (
        !candidates.has(declaration.name.text) &&
        potential(declaration.initializer, (identifier) =>
          candidates.has(identifier.text),
        )
      ) {
        candidates.add(declaration.name.text);
        changed = true;
      }
    }
  }
  // Names narrow the search cheaply, but only the lexical declaration can
  // establish that a particular use is an alias of a limit.
  const lexicalCandidates = new Set();
  changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (
        candidates.has(declaration.name.text) &&
        !lexicalCandidates.has(declaration) &&
        potential(declaration.initializer, (identifier) =>
          lexicalCandidates.has(symbols(identifier)?.valueDeclaration),
        )
      ) {
        lexicalCandidates.add(declaration);
        changed = true;
      }
    }
  }
  const unknown = (node, reason) => {
    const path = sourceFile.fileName;
    const offset = node.getStart();
    if (
      !unresolved.some(
        (item) =>
          item.path === path &&
          item.offset === offset &&
          item.reason === reason,
      )
    ) {
      const location = sourceFile.getLineAndCharacterOfPosition(offset);
      unresolved.push({
        path,
        offset,
        line: location.line + 1,
        column: location.character + 1,
        reason,
      });
    }
  };
  const initializer = (identifier) => {
    if (!candidates.has(identifier.text)) return undefined;
    const declaration = symbols(identifier)?.valueDeclaration;
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      declaration.initializer === undefined ||
      !lexicalCandidates.has(declaration)
    )
      return undefined;
    if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) {
      unknown(declaration.name, "mutable setting-key or value alias");
      return undefined;
    }
    if (declaration.pos >= identifier.pos) {
      unknown(identifier, "alias initialization order is not proven");
      return undefined;
    }
    return declaration.initializer;
  };
  const candidateNames = (node) => {
    const names = new Set();
    const seen = new Set();
    const visit = (part) => {
      const literal = literalText(part);
      if (literal !== undefined && exactLimit(literal) !== undefined)
        names.add(literal);
      if (ts.isIdentifier(part)) {
        const declaration = symbols(part)?.valueDeclaration;
        if (
          declaration !== undefined &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          !seen.has(declaration)
        ) {
          seen.add(declaration);
          visit(declaration.initializer);
        }
      }
      ts.forEachChild(part, visit);
    };
    visit(node);
    return names;
  };
  return { initializer, unknown, candidateNames };
};

/** Resolve immutable string keys; object fields are not immutable just because their binding is const. */
const boundLimitName = (node, bindings, seen = new Set()) => {
  if (node === undefined) return undefined;
  const expression = unwrapExpression(node);
  const literal = literalText(expression);
  if (literal !== undefined) return literal;
  if (ts.isIdentifier(expression)) {
    const value = bindings.initializer(expression);
    if (value === undefined || seen.has(value)) return undefined;
    seen.add(value);
    return boundLimitName(value, bindings, seen);
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const value = bindings.initializer(expression.expression);
    if (value === undefined || seen.has(value)) return undefined;
    seen.add(value);
    const object = unwrapExpression(value);
    if (!ts.isObjectLiteralExpression(object)) return undefined;
    const property = object.properties.find(
      (item) =>
        ts.isPropertyAssignment(item) &&
        (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
        item.name.text === expression.name.text,
    );
    if (property !== undefined)
      bindings.unknown(
        expression,
        "object setting-key property may have changed",
      );
  }
  return undefined;
};

const isPropertyAccess = (node) =>
  ts.isPropertyAccessExpression(node) ||
  ts.isPropertyAccessChain?.(node) === true;

const isElementAccess = (node) =>
  ts.isElementAccessExpression(node) ||
  ts.isElementAccessChain?.(node) === true;

/** A plain assignment or delete does not read the old property value. */
const isWriteOnly = (node) => {
  let target = node;
  while (ts.isParenthesizedExpression(target.parent)) target = target.parent;
  const parent = target.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === target &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    ts.isDeleteExpression(parent)
  );
};

/**
 * Number(), parseInt(), and schema parse() read the value they are given.
 * The accessed property or element is that read, through parentheses and
 * other wrappers, so a suffixless name is still classified.
 */
const rememberNumericArgument = (
  discovered,
  path,
  node,
  bindings,
  seen = new Set(),
) => {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const initializer = bindings.initializer(expression);
    if (initializer !== undefined && !seen.has(initializer)) {
      seen.add(initializer);
      rememberNumericArgument(discovered, path, initializer, bindings, seen);
    }
  } else if (isPropertyAccess(expression))
    remember(discovered, path, expression.name.text, expression, true);
  else if (isElementAccess(expression))
    remember(
      discovered,
      path,
      boundLimitName(expression.argumentExpression, bindings),
      expression,
      true,
    );
  // Propagate numeric context only through values, not tests, receivers or
  // arguments to an unrelated function call.
  if (ts.isConditionalExpression(expression)) {
    rememberNumericArgument(
      discovered,
      path,
      expression.whenTrue,
      bindings,
      seen,
    );
    rememberNumericArgument(
      discovered,
      path,
      expression.whenFalse,
      bindings,
      seen,
    );
  } else if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
      ts.SyntaxKind.AsteriskAsteriskToken,
      ts.SyntaxKind.LessThanLessThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ts.SyntaxKind.AmpersandToken,
      ts.SyntaxKind.BarToken,
      ts.SyntaxKind.CaretToken,
    ].includes(expression.operatorToken.kind)
  ) {
    rememberNumericArgument(discovered, path, expression.left, bindings, seen);
    rememberNumericArgument(discovered, path, expression.right, bindings, seen);
  } else if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    rememberNumericArgument(discovered, path, expression.right, bindings, seen);
  } else if (
    ts.isPrefixUnaryExpression(expression) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.TildeToken,
    ].includes(expression.operator)
  ) {
    rememberNumericArgument(
      discovered,
      path,
      expression.operand,
      bindings,
      seen,
    );
  } else if (ts.isTemplateExpression(expression)) {
    for (const span of expression.templateSpans)
      rememberNumericArgument(
        discovered,
        path,
        span.expression,
        bindings,
        seen,
      );
  }
};

const isNumericLimit = (name) =>
  REQUIRED_RUNTIME_LIMITS.includes(name) ||
  /(?:_BYTES|_MS|_MIB|_SECONDS|_POLLS|_JOBS|_ELEMENTS|_COUNT|_SESSIONS|_COMMANDS)$/u.test(
    name,
  ) ||
  /_MAX_/u.test(name) ||
  /_(?:TIMEOUT|DEADLINE|BUDGET)(?:_|$)/u.test(name) ||
  /_HEAP(?:_|$)/u.test(name);

const exactLimit = (text) =>
  text !== undefined && /^REA_[A-Z0-9_]+$/u.test(text) ? text : undefined;

const limitName = (text) => {
  const name = exactLimit(text);
  return name !== undefined && isNumericLimit(name) ? name : undefined;
};

const numericSchemaText = (node) =>
  /z\.(?:number|int|coerce\.number)|(?:Bytes|Timeout|Deadline|Budget|Heap|Count|Integer|MiB)Schema\b/u.test(
    node.getText(),
  );

const isParseAccess = (expression) =>
  isPropertyAccess(expression) &&
  (expression.name.text === "safeParse" || expression.name.text === "parse");

/** Number() and a numeric schema read their argument. Other parsers do not. */
const parsesNumericArgument = (node, globalConverter) => {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  if (
    ts.isIdentifier(expression) &&
    ["Number", "parseInt", "parseFloat"].includes(expression.text) &&
    globalConverter(expression)
  )
    return true;
  if (
    isPropertyAccess(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Number" &&
    globalConverter(expression.expression) &&
    (expression.name.text === "parseInt" ||
      expression.name.text === "parseFloat")
  )
    return true;
  return isParseAccess(expression) && numericSchemaText(expression.expression);
};

const numericParse = (node, globalConverter) => {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  return (
    parsesNumericArgument(node, globalConverter) || isParseAccess(expression)
  );
};

/** Distinguish local bindings from the standard globals used by discovery. */
const globalConverterLookup = (sourceFile, symbols) => {
  let declared;
  return (identifier) => {
    if (declared === undefined) {
      declared = new Set();
      const find = (node) => {
        if (
          ts.isIdentifier(node) &&
          ["Number", "parseInt", "parseFloat", "process"].includes(node.text) &&
          ts.isDeclarationName(node)
        )
          declared.add(node.text);
        ts.forEachChild(node, find);
      };
      find(sourceFile);
    }
    if (!declared.has(identifier.text)) return true;
    return symbols(identifier) === undefined;
  };
};

const globalLookups = new WeakMap();
const globalLookupFor = (source) => {
  let lookup = globalLookups.get(source);
  if (lookup === undefined) {
    lookup = globalConverterLookup(source, lexicalSymbols(source));
    globalLookups.set(source, lookup);
  }
  return lookup;
};

/** Direct, unshadowed process.env reads are stronger than candidate syntax. */
const isDirectEnvironmentRead = (node) => {
  const expression = unwrapExpression(node);
  if (!isPropertyAccess(expression) && !isElementAccess(expression))
    return false;
  const receiver = unwrapExpression(expression.expression);
  if (!isPropertyAccess(receiver) || receiver.name.text !== "env") return false;
  const process = unwrapExpression(receiver.expression);
  return (
    ts.isIdentifier(process) &&
    process.text === "process" &&
    globalLookupFor(process.getSourceFile())(process)
  );
};

const readLifecycle = (node) => {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isConstructorDeclaration(current)) return "construction";
    if (
      ts.isPropertyDeclaration(current) &&
      !current.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      )
    )
      return "construction";
    if (ts.isFunctionLike(current)) {
      let value = current;
      while (
        ts.isParenthesizedExpression(value.parent) ||
        ts.isAsExpression(value.parent) ||
        ts.isNonNullExpression(value.parent)
      )
        value = value.parent;
      if (
        !ts.isCallExpression(value.parent) ||
        value.parent.expression !== value
      )
        return "unknown";
      current = value.parent;
    }
    current = current.parent;
  }
  return "module";
};

const remember = (discovered, path, name, node, force = false) => {
  const limit = force ? exactLimit(name) : limitName(name);
  if (limit === undefined) return;
  const read = readLifecycle(node);
  const site = {
    path,
    read,
    offset: node.getStart(),
    evidence: isDirectEnvironmentRead(node) ? "direct" : "candidate",
  };
  const current = discovered.get(limit);
  if (current === undefined) {
    discovered.set(limit, { path, read, sites: [site] });
    return;
  }
  if (
    !current.sites.some(
      (other) => other.path === path && other.offset === site.offset,
    )
  )
    current.sites.push(site);
  if (current.read !== read) current.read = "unknown";
};

/**
 * Producers are syntax, not text. A read is a property or element access,
 * including a const string used as the element, a string argument to a call,
 * an object-binding key (rename and default included), an `in` check, or an
 * object key that a spread can copy. A numeric parser also reads a property or
 * element access inside its argument. Comments, array literals and template
 * text are not reads; executable substitutions are visited normally.
 */
export const discoverNumericLimitUses = (files) => {
  const discovered = new Map();
  const unresolved = [];
  discovered.unresolved = unresolved;
  for (const file of files) {
    const relativePath = file.path.split(sep).join("/");
    if (relativePath === NUMERIC_LIMIT_DECLARATION) continue;
    const sourceFile = ts.createSourceFile(
      relativePath,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const symbols = lexicalSymbols(sourceFile);
    const bindings = stringBindings(sourceFile, symbols, unresolved);
    const globalConverter = globalConverterLookup(sourceFile, symbols);
    globalLookups.set(sourceFile, globalConverter);
    const visit = (node) => {
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isPropertyAccessChain?.(node)) &&
        !isWriteOnly(node)
      )
        remember(discovered, relativePath, node.name.text, node);
      if (ts.isElementAccessExpression(node) && !isWriteOnly(node)) {
        const name = boundLimitName(node.argumentExpression, bindings);
        remember(discovered, relativePath, name, node);
        if (
          name === undefined &&
          node.argumentExpression !== undefined &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "env"
        ) {
          bindings.unknown(
            node.argumentExpression,
            "dynamic environment key is not statically known",
          );
          for (const candidate of bindings.candidateNames(
            node.argumentExpression,
          ))
            remember(
              discovered,
              relativePath,
              candidate,
              node.argumentExpression,
            );
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const parsesNumber = parsesNumericArgument(node, globalConverter);
        for (const argument of node.arguments ?? []) {
          if (parsesNumber)
            rememberNumericArgument(
              discovered,
              relativePath,
              argument,
              bindings,
            );
          else
            remember(
              discovered,
              relativePath,
              boundLimitName(argument, bindings),
              node,
              numericParse(node, globalConverter),
            );
        }
      }
      if (
        ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusToken ||
          node.operator === ts.SyntaxKind.MinusToken ||
          node.operator === ts.SyntaxKind.TildeToken)
      )
        rememberNumericArgument(
          discovered,
          relativePath,
          node.operand,
          bindings,
        );
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      )
        remember(
          discovered,
          relativePath,
          boundLimitName(node.left, bindings),
          node,
        );
      if (
        ts.isBindingElement(node) &&
        node.dotDotDotToken === undefined &&
        ts.isObjectBindingPattern(node.parent)
      ) {
        const key = node.propertyName ?? node.name;
        if (
          ts.isIdentifier(key) ||
          ts.isStringLiteral(key) ||
          ts.isNumericLiteral(key)
        )
          remember(discovered, relativePath, key.text, node);
      }
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) ||
          ts.isStringLiteral(node.name) ||
          ts.isNumericLiteral(node.name))
      )
        remember(
          discovered,
          relativePath,
          node.name.text,
          node,
          ts.isPropertyAssignment(node) && numericSchemaText(node.initializer),
        );
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return discovered;
};

/**
 * @typedef {{
 *   readonly code:
 *     | "required_runtime_limit_missing"
 *     | "required_runtime_limit_not_analysis_setting",
 *   readonly name: string,
 * }} RequiredRuntimeLimitFailure
 */

/**
 * Classify one required runtime limit.
 * The caller supplies names from REQUIRED_RUNTIME_LIMITS. Absence from
 * source, the exception registry, and ANALYSIS_SETTINGS is its own failure
 * so a stale required name cannot be skipped. The registry cannot classify
 * a required limit as a runtime setting.
 *
 * @param {string} name
 * @param {{
 *   readonly inSource: boolean,
 *   readonly inRuntime: boolean,
 *   readonly inRegistry: boolean,
 * }} presence
 * @returns {RequiredRuntimeLimitFailure | undefined}
 */
export const requiredRuntimeLimitFailure = (
  name,
  { inSource, inRuntime, inRegistry },
) => {
  if (!inSource && !inRuntime && !inRegistry)
    return { code: "required_runtime_limit_missing", name };
  if (inRuntime && !inRegistry) return undefined;
  return { code: "required_runtime_limit_not_analysis_setting", name };
};

/** Parse the registry as TypeScript so provenance is owned by its entry. */
export const parseNumericLimitRegistry = (source) => {
  const file = ts.createSourceFile(
    NUMERIC_LIMIT_DECLARATION,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (entry) =>
        ts.isIdentifier(entry.name) &&
        entry.name.text === "NUMERIC_LIMIT_REGISTRY",
    );
  if (declaration?.initializer === undefined)
    throw new Error("NUMERIC_LIMIT_REGISTRY declaration is missing");
  const array = unwrapExpression(declaration.initializer);
  if (!ts.isArrayLiteralExpression(array))
    throw new Error("NUMERIC_LIMIT_REGISTRY must be an array literal");
  const fields = (node) => {
    if (!ts.isObjectLiteralExpression(node))
      throw new Error("Numeric limit registry entry must be an object literal");
    const result = new Map();
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      )
        throw new Error(
          "Numeric limit registry properties must be named assignments",
        );
      if (result.has(property.name.text))
        throw new Error(`Duplicate registry property ${property.name.text}`);
      result.set(property.name.text, property.initializer);
    }
    return result;
  };
  const text = (values, key, required = true) => {
    const node = values.get(key);
    if (node === undefined && !required) return undefined;
    const value =
      node === undefined ? undefined : literalText(unwrapExpression(node));
    if (value === undefined)
      throw new Error(`Registry ${key} must be a string literal`);
    return value;
  };
  return array.elements.map((element) => {
    const value = fields(element);
    const name = text(value, "name");
    const update_mode = text(value, "update_mode");
    const policy = text(value, "policy");
    const read = text(value, "read");
    const reason = text(value, "reason");
    if (
      exactLimit(name) === undefined ||
      update_mode !== "restart" ||
      !["startup", "per-call", "construction"].includes(read)
    )
      throw new Error(`Invalid numeric limit registry entry ${name}`);
    if (policy !== "restart-only")
      throw new Error(
        `${name} must use a restart-only policy in the registry. Move per-call limits into ANALYSIS_SETTINGS.`,
      );
    const source = value.get("provenance");
    if (source === undefined)
      return { name, update_mode, policy, read, reason };
    const provenance = fields(unwrapExpression(source));
    const kind = text(provenance, "kind");
    const producer = text(provenance, "source");
    const witness = text(provenance, "witness");
    const generator = text(provenance, "generator", false);
    const generatorWitness = text(provenance, "generatorWitness", false);
    if (
      !["external-reader", "generated-control"].includes(kind) ||
      (kind === "generated-control" &&
        (generator === undefined || generatorWitness === undefined)) ||
      (kind === "external-reader" &&
        (generator !== undefined || generatorWitness !== undefined))
    )
      throw new Error(`Invalid external provenance for ${name}`);
    return {
      name,
      update_mode,
      policy,
      read,
      reason,
      provenance: {
        kind,
        source: producer,
        witness,
        ...(generator === undefined ? {} : { generator }),
        ...(generatorWitness === undefined ? {} : { generatorWitness }),
      },
    };
  });
};

/** Extract only environment properties owned by the settings declaration. */
export const parseRuntimeSettingEnvironments = (source) => {
  const file = ts.createSourceFile(
    "analysisSettingDefinitions.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (entry) =>
        ts.isIdentifier(entry.name) && entry.name.text === "ANALYSIS_SETTINGS",
    );
  if (declaration?.initializer === undefined)
    throw new Error("ANALYSIS_SETTINGS declaration is missing");
  const settings = unwrapExpression(declaration.initializer);
  if (!ts.isObjectLiteralExpression(settings))
    throw new Error("ANALYSIS_SETTINGS must be an object literal");
  const names = new Set();
  for (const setting of settings.properties) {
    if (
      !ts.isPropertyAssignment(setting) ||
      !ts.isObjectLiteralExpression(unwrapExpression(setting.initializer))
    )
      throw new Error("Analysis setting must be a static object assignment");
    const definition = unwrapExpression(setting.initializer);
    if (
      definition.properties.some((field) => {
        if (ts.isPropertyAssignment(field))
          return (
            !ts.isIdentifier(field.name) && !ts.isStringLiteral(field.name)
          );
        if (!ts.isSpreadAssignment(field) || !ts.isIdentifier(field.expression))
          return true;
        const name = field.expression.text;
        const binding = file.statements
          .filter(ts.isVariableStatement)
          .flatMap((statement) =>
            (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
              ? [...statement.declarationList.declarations]
              : [],
          )
          .find(
            (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
          );
        if (binding?.initializer === undefined) return true;
        const spread = unwrapExpression(binding.initializer);
        if (!ts.isObjectLiteralExpression(spread)) return true;
        let escaped = false;
        const inspect = (node) => {
          if (
            ts.isIdentifier(node) &&
            node.text === name &&
            node !== binding.name &&
            !(
              ts.isSpreadAssignment(node.parent) &&
              node.parent.expression === node
            )
          )
            escaped = true;
          ts.forEachChild(node, inspect);
        };
        inspect(file);
        if (escaped) return true;
        return spread.properties.some(
          (property) =>
            !ts.isPropertyAssignment(property) ||
            (!ts.isIdentifier(property.name) &&
              !ts.isStringLiteral(property.name)) ||
            ["environment", "updateMode"].includes(property.name.text),
        );
      })
    )
      throw new Error(
        "Analysis setting fields must be static named assignments",
      );
    const modes = definition.properties.filter(
      (field) =>
        ts.isPropertyAssignment(field) &&
        (ts.isIdentifier(field.name) || ts.isStringLiteral(field.name)) &&
        field.name.text === "updateMode",
    );
    if (
      modes.length !== 1 ||
      !["runtime", "restart"].includes(
        literalText(unwrapExpression(modes[0].initializer)),
      )
    )
      throw new Error("Analysis setting must declare a static updateMode");
    const fields = definition.properties.filter(
      (field) =>
        ts.isPropertyAssignment(field) &&
        (ts.isIdentifier(field.name) || ts.isStringLiteral(field.name)) &&
        field.name.text === "environment",
    );
    if (fields.length > 1)
      throw new Error("Duplicate analysis setting environment");
    if (fields.length === 0) continue;
    const name = literalText(unwrapExpression(fields[0].initializer));
    if (name === undefined || !/^REA_[A-Z0-9_]+$/u.test(name))
      throw new Error(
        "Analysis setting environment must be a static REA_ name",
      );
    names.add(name);
  }
  return names;
};

const DOCUMENTED_LIMIT_SECTIONS = [
  "Runtime analysis settings",
  "Per-call limits in the runtime system",
  "Restart-only numeric limits",
];

const tableCells = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

const separatorRow = (cells) =>
  cells.length > 0 && cells.every((cell) => /^:?-+:?$/u.test(cell));

/**
 * Read default, floor, and maximum from the three numeric inventory tables.
 * The limit name is the first cell. Later prose tables are not limits.
 *
 * @param {string} markdown
 */
export const parseDocumentedNumericLimits = (markdown) => {
  const lines = markdown.split(/\r?\n/u);
  const rows = [];
  for (const title of DOCUMENTED_LIMIT_SECTIONS) {
    const heading = lines.findIndex((line) => line.trim() === `## ${title}`);
    if (heading < 0)
      throw new Error(
        `docs/design/rea-limit-inventory.md is missing "## ${title}"`,
      );
    let index = heading + 1;
    while (index < lines.length && !lines[index].startsWith("|")) {
      if (lines[index].startsWith("#"))
        throw new Error(`## ${title} has no limit table`);
      index += 1;
    }
    if (!lines[index]?.startsWith("|"))
      throw new Error(`## ${title} has no limit table`);
    const header = tableCells(lines[index]);
    const column = (name) => {
      const found = header.indexOf(name);
      if (found < 0)
        throw new Error(`## ${title} table is missing the ${name} column`);
      return found;
    };
    const defaultColumn = column("Default");
    const floorColumn = column("Floor");
    const maximumColumn = column("Maximum");
    if (header[0] !== "Setting" && header[0] !== "Environment")
      throw new Error(
        `## ${title} must name each limit in a Setting or Environment column`,
      );
    for (
      index += 1;
      index < lines.length && lines[index].startsWith("|");
      index += 1
    ) {
      const cells = tableCells(lines[index]);
      if (separatorRow(cells)) continue;
      const name = cells[0]?.replaceAll("`", "") ?? "";
      if (name.length === 0)
        throw new Error(`## ${title} has a row without a limit name`);
      rows.push({
        name,
        section: title,
        defaultCell: cells[defaultColumn] ?? "",
        floorCell: cells[floorColumn] ?? "",
        maximumCell: cells[maximumColumn] ?? "",
      });
    }
    if (!rows.some((row) => row.section === title))
      throw new Error(`## ${title} table has no limit rows`);
  }
  return rows;
};

/**
 * A documented cell is one complete integer, optional prose after whitespace,
 * `unset` (null), or one exported constant. A fraction is not that integer.
 *
 * @param {string} cell
 * @param {Readonly<Record<string, number>>} names
 * @returns {{ ok: true, value: number | null } | { ok: false, reason: string }}
 */
export const documentedLimitCell = (cell, names) => {
  const text = cell.trim();
  if (/^unset\b/iu.test(text)) return { ok: true, value: null };
  const named = /^`([^`]+)`$/u.exec(text);
  if (named) {
    if (!Object.hasOwn(names, named[1]))
      return { ok: false, reason: `unknown constant ${named[1]}` };
    return { ok: true, value: names[named[1]] };
  }
  const integer = /^(\d+)(?=\s|$)/u.exec(text);
  if (!integer)
    return { ok: false, reason: `unreadable cell ${JSON.stringify(text)}` };
  return { ok: true, value: Number(integer[1]) };
};

const showLimitValue = (value) => (value === null ? "unset" : String(value));

/**
 * Compare one inventory row with the bound the code exports.
 * Each failure names the limit and both values.
 *
 * @param {readonly {
 *   readonly name: string,
 *   readonly section: string,
 *   readonly defaultCell: string,
 *   readonly floorCell: string,
 *   readonly maximumCell: string,
 * }[]} rows
 * @param {readonly {
 *   readonly name: string,
 *   readonly aliases?: readonly string[],
 *   readonly defaultValue: number | null,
 *   readonly minimum: number,
 *   readonly maximum: number,
 * }[]} bounds
 * @param {Readonly<Record<string, number>>} names
 * @returns {string[]}
 */
export const compareDocumentedNumericLimits = (rows, bounds, names) => {
  const failures = [];
  const byName = new Map();
  for (const bound of bounds) {
    for (const name of [bound.name, ...(bound.aliases ?? [])]) {
      if (byName.has(name))
        failures.push(`${name}: code exports more than one bound`);
      byName.set(name, bound);
    }
  }
  const seen = new Set();
  const seenNames = new Set();
  for (const row of rows) {
    if (seenNames.has(row.name))
      failures.push(`${row.name}: documented more than once`);
    seenNames.add(row.name);
    const bound = byName.get(row.name);
    if (bound === undefined) {
      failures.push(
        `${row.name}: documented ${row.section} default ${JSON.stringify(row.defaultCell)}, floor ${JSON.stringify(row.floorCell)}, maximum ${JSON.stringify(row.maximumCell)}, but code exports no bound`,
      );
      continue;
    }
    seen.add(bound);
    for (const [field, cell, codeValue] of [
      ["default", row.defaultCell, bound.defaultValue],
      ["floor", row.floorCell, bound.minimum],
      ["maximum", row.maximumCell, bound.maximum],
    ]) {
      const documented = documentedLimitCell(cell, names);
      if (!documented.ok) {
        failures.push(
          `${row.name} ${field}: documented ${JSON.stringify(cell)} (${documented.reason}), code ${showLimitValue(codeValue)}`,
        );
        continue;
      }
      if (documented.value !== codeValue)
        failures.push(
          `${row.name} ${field}: documented ${showLimitValue(documented.value)}, code ${showLimitValue(codeValue)}`,
        );
    }
  }
  for (const bound of bounds) {
    if (seen.has(bound)) continue;
    const label =
      bound.aliases !== undefined && bound.aliases.length > 0
        ? `${bound.name} (${bound.aliases.join(", ")})`
        : bound.name;
    failures.push(
      `${label}: code exports default ${showLimitValue(bound.defaultValue)}, floor ${showLimitValue(bound.minimum)}, maximum ${showLimitValue(bound.maximum)}, but docs/design/rea-limit-inventory.md has no row`,
    );
  }
  return failures;
};

const exportedNumber = (module, name) => {
  const value = module[name];
  if (typeof value !== "number")
    throw new Error(`${name} is not an exported number`);
  return value;
};

const bound = (name, defaultValue, minimum, maximum, aliases = []) => ({
  name,
  ...(aliases.length === 0 ? {} : { aliases }),
  defaultValue,
  minimum,
  maximum,
});

/** Analysis-setting registry bounds, including each REA_ environment alias. */
const analysisSettingBounds = (settings) => {
  const bounds = [];
  for (const [id, definition] of Object.entries(settings)) {
    if (
      (typeof definition.defaultValue !== "number" &&
        definition.defaultValue !== null) ||
      typeof definition.minimum !== "number" ||
      typeof definition.maximum !== "number"
    )
      throw new Error(
        `${id} does not export a numeric default, floor, and maximum`,
      );
    bounds.push(
      bound(
        id,
        definition.defaultValue,
        definition.minimum,
        definition.maximum,
        typeof definition.environment === "string"
          ? [definition.environment]
          : [],
      ),
    );
  }
  return bounds;
};

/** One MCP startup phase, using the value resolveMcpStartupBudgets ships. */
const phaseBound = (budget) => {
  if (budget.source !== "default")
    throw new Error(`${budget.setting} unset resolution was not the default`);
  return bound(
    budget.setting,
    budget.defaultMilliseconds,
    budget.floorMilliseconds,
    budget.maximumMilliseconds,
  );
};

/** Restart-only bounds from the constants each owner parser enforces. */
const restartOnlyBounds = (owners) => {
  const phases = owners.mcpBudgets.resolveMcpStartupBudgets({});
  const reconnectSeconds = exportedNumber(
    owners.hopperSession,
    "HOPPER_SHUTDOWN_TIMEOUT_MS",
  );
  if (reconnectSeconds % 1000 !== 0)
    throw new Error(
      "HOPPER_SHUTDOWN_TIMEOUT_MS is not a whole number of seconds",
    );
  const seconds = reconnectSeconds / 1000;
  const restart = [
    bound(
      "REA_DEBUGGER_MAX_PENDING_COMMANDS",
      exportedNumber(owners.limits, "DEFAULT_DEBUGGER_MAX_PENDING_COMMANDS"),
      exportedNumber(owners.limits, "MINIMUM_DEBUGGER_MAX_PENDING_COMMANDS"),
      exportedNumber(owners.limits, "MAXIMUM_DEBUGGER_MAX_PENDING_COMMANDS"),
    ),
    bound(
      "REA_DEBUGGER_MAX_SESSIONS",
      exportedNumber(owners.limits, "DEFAULT_DEBUGGER_MAX_SESSIONS"),
      exportedNumber(owners.limits, "MINIMUM_DEBUGGER_MAX_SESSIONS"),
      exportedNumber(owners.limits, "MAXIMUM_DEBUGGER_MAX_SESSIONS"),
    ),
    bound(
      "REA_HOPPER_DEMO_DIALOG_TIMEOUT_MS",
      exportedNumber(
        owners.hopperStartup,
        "DEFAULT_HOPPER_DEMO_DIALOG_TIMEOUT_MS",
      ),
      exportedNumber(
        owners.hopperStartup,
        "MINIMUM_HOPPER_DEMO_DIALOG_TIMEOUT_MS",
      ),
      exportedNumber(owners.limits, "MAX_NODE_TIMER_DELAY_MS"),
    ),
    bound(
      "REA_JADX_ACTIVE_PROCESSOR_COUNT",
      owners.jadx.JADX_JVM_DEFAULT,
      exportedNumber(owners.jadx, "JADX_JVM_NUMERIC_MINIMUM"),
      exportedNumber(owners.jadx, "JADX_ACTIVE_PROCESSOR_COUNT_MAXIMUM"),
    ),
    bound(
      "REA_JADX_HEAP_MIB",
      owners.jadx.JADX_JVM_DEFAULT,
      exportedNumber(owners.jadx, "JADX_JVM_NUMERIC_MINIMUM"),
      exportedNumber(owners.jadx, "JADX_HEAP_MIB_MAXIMUM"),
    ),
    bound(
      "REA_KUNA_CACHE_MAX_BYTES",
      exportedNumber(owners.kuna, "DEFAULT_KUNA_CACHE_MAX_BYTES"),
      exportedNumber(owners.kuna, "MINIMUM_KUNA_CACHE_MAX_BYTES"),
      exportedNumber(owners.kuna, "MAXIMUM_KUNA_CACHE_MAX_BYTES"),
    ),
    bound(
      "REA_KUNA_JOBS",
      exportedNumber(owners.kuna, "DEFAULT_KUNA_JOBS"),
      exportedNumber(owners.kuna, "MINIMUM_KUNA_JOBS"),
      exportedNumber(owners.kuna, "MAXIMUM_KUNA_JOBS"),
    ),
    phaseBound(phases.doctor),
    phaseBound(phases.firstCatalog),
    phaseBound(phases.initialize),
    bound(
      "REA_MCP_MAX_INPUT_ELEMENTS",
      exportedNumber(owners.mcpInput, "DEFAULT_MCP_MAX_INPUT_ELEMENTS"),
      exportedNumber(owners.mcpInput, "MINIMUM_MCP_MAX_INPUT_ELEMENTS"),
      exportedNumber(owners.mcpInput, "MAXIMUM_MCP_MAX_INPUT_ELEMENTS"),
    ),
    bound(
      "REA_MCP_MAX_RESPONSE_BYTES",
      exportedNumber(owners.sdk, "STDIO_DEFAULT_MAX_BUFFER_SIZE"),
      exportedNumber(owners.mcpResponse, "MINIMUM_RESPONSE_BYTES"),
      exportedNumber(owners.mcpResponse, "MAXIMUM_RESPONSE_BYTES"),
    ),
    phaseBound(phases.toolsList),
    bound("REA_RECONNECT_TIMEOUT_SECONDS", seconds, seconds, seconds),
    bound(
      "REA_SWIFTC_COMPILE_TIMEOUT_MS",
      exportedNumber(
        owners.startupTimeout,
        "DEFAULT_SWIFTC_COMPILE_TIMEOUT_MS",
      ),
      exportedNumber(owners.limits, "TIMER_DURATION_MINIMUM_MS"),
      exportedNumber(owners.limits, "MAX_NODE_TIMER_DELAY_MS"),
    ),
  ];
  if (restart.some((entry) => entry.defaultValue === undefined))
    throw new Error("A restart-only bound is missing its default");
  return restart;
};

/** Registry entries must be the restart-only bounds, and the reverse. */
const restartRegistryFailures = (registry, restart) => {
  const names = new Set(registry.map((entry) => entry.name));
  const failures = [];
  for (const name of names) {
    if (!restart.some((entry) => entry.name === name))
      failures.push(
        `${name}: restart-only registry entry has no exported default, floor, and maximum`,
      );
  }
  for (const entry of restart) {
    if (!names.has(entry.name))
      failures.push(
        `${entry.name}: exported restart-only bound is not in NUMERIC_LIMIT_REGISTRY`,
      );
  }
  return failures;
};

/**
 * Bounds the running code exports.
 * Analysis settings come from ANALYSIS_SETTINGS, which
 * update_analysis_settings and inspect_analysis_settings share.
 * Restart-only bounds are the constants each owner parser enforces.
 * A registry name without those exports fails closed.
 */
export const loadExportedNumericLimitBounds = async () => {
  const { importVerifierSource } =
    await import("../lib/verifier-source-loader.mjs");
  const source = (specifier) =>
    importVerifierSource(specifier, import.meta.url);
  const [
    settings,
    limits,
    registry,
    hopperStartup,
    hopperSession,
    jadx,
    kuna,
    mcpBudgets,
    mcpInput,
    mcpResponse,
    startupTimeout,
    sdk,
  ] = await Promise.all([
    source("../../src/domain/analysisSettingDefinitions.ts"),
    source("../../src/domain/analysisResourceLimits.ts"),
    source("../../src/domain/numericLimitRegistry.ts"),
    source("../../src/hopper/HopperStartupFailure.ts"),
    source("../../src/hopper/HopperSessionValues.ts"),
    source("../../src/android/JadxConfiguration.ts"),
    source("../../src/kuna/KunaConfiguration.ts"),
    source("../../src/config/mcpStartupBudgets.ts"),
    source("../../src/config/mcpInputBudget.ts"),
    source("../../src/config/mcpResponseBudget.ts"),
    source("../../src/config/providerStartupTimeout.ts"),
    import("@modelcontextprotocol/server"),
  ]);
  const owners = {
    limits,
    hopperStartup,
    hopperSession,
    jadx,
    kuna,
    mcpBudgets,
    mcpInput,
    mcpResponse,
    startupTimeout,
    sdk,
  };
  const restart = restartOnlyBounds(owners);
  return {
    bounds: [...analysisSettingBounds(settings.ANALYSIS_SETTINGS), ...restart],
    names: {
      "Number.MAX_SAFE_INTEGER": Number.MAX_SAFE_INTEGER,
      MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: exportedNumber(
        limits,
        "MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS",
      ),
    },
    failures: restartRegistryFailures(registry.NUMERIC_LIMIT_REGISTRY, restart),
  };
};

const direct =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  const failures = [];
  const definitions = await readFile(definitionsPath, "utf8");
  const registry = await readFile(registryPath, "utf8");
  const runtime = parseRuntimeSettingEnvironments(definitions);
  const entries = parseNumericLimitRegistry(registry);
  const listed = new Map();
  for (const entry of entries) {
    const { name, read, reason } = entry;
    if (listed.has(name)) failures.push(`${name} is listed twice`);
    listed.set(name, entry);
    if (reason.trim().length < 40)
      failures.push(`${name} needs a reason that states why`);
    if (runtime.has(name))
      failures.push(
        `${name} is both a runtime setting and on the exception list`,
      );
    if (read !== "startup" && read !== "construction")
      failures.push(`${name} is restart-only but is not read at startup`);
  }

  const discovered = discoverNumericLimitUses(
    await Promise.all(
      (await listFiles(join(root, "src"))).map(async (path) => ({
        path: relative(root, path),
        source: await readFile(path, "utf8"),
      })),
    ),
  );

  for (const issue of discovered.unresolved)
    console.log(
      `${issue.path}:${issue.line}:${issue.column}: numeric limit candidate unresolved (${issue.reason})`,
    );

  for (const [name, file] of [...discovered].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (!runtime.has(name) && !listed.has(name))
      failures.push(
        `${name} in ${file.path} is neither an analysis setting nor docs/design/rea-limit-inventory.md via src/domain/numericLimitRegistry.ts`,
      );
  }
  for (const name of listed.keys()) {
    const site = discovered.get(name);
    const declared = listed.get(name);
    if (declared?.provenance !== undefined) {
      for (const path of [
        declared.provenance.source,
        declared.provenance.witness,
        declared.provenance.generator,
        declared.provenance.generatorWitness,
      ]) {
        if (path === undefined) continue;
        try {
          if (!(await stat(join(root, path))).isFile())
            failures.push(`${name} provenance path is not a file: ${path}`);
        } catch (cause) {
          failures.push(
            `${name} provenance path cannot be read: ${path} (${String(cause)})`,
          );
        }
      }
      console.log(
        `${name}: behavior not verified by Node lint; reader witness: npm run test:focused -- ${declared.provenance.witness}`,
      );
      if (declared.provenance.kind === "generated-control")
        console.log(
          `${name}: generated producer not verified by Node lint; producer witness: npm run test:local -- ${declared.provenance.generatorWitness}`,
        );
    } else if (site === undefined) {
      failures.push(
        `${name} is registered but has no recognized TypeScript candidate; dynamic readers remain unverified`,
      );
    } else if (
      !site.sites.some((observation) => observation.evidence === "direct")
    ) {
      console.log(
        `${name}: candidate syntax only; no direct process.env read was verified by Node lint`,
      );
    }
  }
  for (const name of REQUIRED_RUNTIME_LIMITS) {
    const failure = requiredRuntimeLimitFailure(name, {
      inSource: discovered.has(name),
      inRuntime: runtime.has(name),
      inRegistry: listed.has(name),
    });
    if (failure !== undefined)
      failures.push(`${failure.code}: ${failure.name}`);
  }

  const parameterOwners = [
    "src/resources/ArtifactReaderLimits.ts",
    "src/domain/artifactReaderLimits.ts",
    "src/domain/webNetworkCapture.ts",
  ];
  for (const relativePath of parameterOwners) {
    const source = await readFile(join(root, relativePath), "utf8");
    if (/update_mode:\s*"runtime"/u.test(source))
      failures.push(
        `${relativePath} is a per-call parameter, so update_mode cannot be runtime`,
      );
    if (!/update_mode:\s*"parameter"/u.test(source))
      failures.push(`${relativePath} must report update_mode parameter`);
  }

  // The permission fixture copies this file into a tree with no package.json.
  // A REA checkout always compares the inventory. A missing inventory here fails.
  let checkout = false;
  try {
    checkout =
      JSON.parse(await readFile(join(root, "package.json"), "utf8")).name ===
      "rea-agents";
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
  if (checkout) {
    try {
      const inventory = await readFile(
        join(root, "docs/design/rea-limit-inventory.md"),
        "utf8",
      );
      const exported = await loadExportedNumericLimitBounds();
      failures.push(
        ...exported.failures,
        ...compareDocumentedNumericLimits(
          parseDocumentedNumericLimits(inventory),
          exported.bounds,
          exported.names,
        ),
      );
    } catch (cause) {
      failures.push(
        `documented limit values could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  } else
    console.log(
      "Documented limit values skipped: this copy is not the REA checkout.",
    );

  if (failures.length > 0) {
    console.error(`Numeric REA_ limit check failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `Numeric REA_ limits: ${runtime.size} runtime, ${listed.size} restart-only, ${discovered.size} discovered.`,
  );
  console.log(
    "Read-site kinds describe syntax only; Node lint does not verify reachability, invocation frequency or complete reader coverage.",
  );
}
