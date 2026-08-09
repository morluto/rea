import {
  Script,
  SourceTextModule,
  SyntheticModule,
  createContext,
  type Module,
} from "node:vm";
import { types } from "node:util";

import type {
  WorkerModule,
  WorkerOutcome,
  WorkerRequest,
  WorkerSide,
} from "./JavaScriptReplayWorkerTypes.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError(`Invalid replay worker ${label}`);
  return value;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`Invalid replay worker ${label}`);
  return value;
};

const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new TypeError(`Invalid replay worker ${label}`);
  return Number(value);
};

const parseWorkerModule = (value: unknown): WorkerModule => {
  const module = record(value, "module");
  const format = module.format;
  if (format !== "esm" && format !== "commonjs-factory")
    throw new TypeError("Invalid replay worker module format");
  const dependencies = record(module.dependencies, "module dependencies");
  if (
    Object.values(dependencies).some(
      (dependency) => typeof dependency !== "string",
    )
  )
    throw new TypeError("Invalid replay worker module dependency");
  return {
    alias: string(module.alias, "module alias"),
    format,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).map(([key, dependency]) => [
        key,
        string(dependency, "module dependency"),
      ]),
    ),
    source: string(module.source, "module source"),
  };
};

const parseWorkerSide = (value: unknown): WorkerSide => {
  const side = record(value, "side");
  if (!Array.isArray(side.modules))
    throw new TypeError("Invalid replay worker modules");
  return {
    modules: side.modules.map(parseWorkerModule),
    entryAlias: string(side.entryAlias, "entry alias"),
    entryExport: string(side.entryExport, "entry export"),
  };
};

const parseWorkerRequest = (value: unknown): WorkerRequest => {
  const request = record(value, "request");
  if (request.schemaVersion !== 1 || !Array.isArray(request.cases))
    throw new TypeError("Unsupported replay worker protocol");
  const determinism = record(request.determinism, "determinism");
  const limits = record(request.limits, "limits");
  return {
    schemaVersion: 1,
    left: parseWorkerSide(request.left),
    ...(request.right === undefined
      ? {}
      : { right: parseWorkerSide(request.right) }),
    cases: request.cases.map((value) => {
      const replayCase = record(value, "case");
      if (!Array.isArray(replayCase.arguments))
        throw new TypeError("Invalid replay worker case arguments");
      return {
        caseId: string(replayCase.caseId, "case ID"),
        arguments: replayCase.arguments,
        inputSha256: string(replayCase.inputSha256, "case digest"),
      };
    }),
    determinism: {
      clockIso: string(determinism.clockIso, "clock"),
      randomSeed: integer(determinism.randomSeed, "random seed"),
    },
    limits: {
      resultDepth: integer(limits.resultDepth, "result depth"),
      resultNodes: integer(limits.resultNodes, "result nodes"),
      exceptionBytes: integer(limits.exceptionBytes, "exception bytes"),
    },
  };
};

class ReplayDeniedError extends Error {
  override readonly name = "ReplayDeniedError";
}

const main = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const rawRequest: unknown = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  );
  const request = parseWorkerRequest(rawRequest);
  const left: WorkerOutcome[] = [];
  const right: WorkerOutcome[] = [];
  for (let index = 0; index < request.cases.length; index += 1) {
    const replayCase = request.cases[index];
    if (replayCase === undefined) continue;
    left.push(await runCase(request.left, replayCase, request, index));
    if (request.right !== undefined)
      right.push(await runCase(request.right, replayCase, request, index));
  }
  process.stdout.write(
    JSON.stringify({
      schema_version: 1,
      left,
      ...(request.right === undefined ? {} : { right }),
    }),
  );
};

const runCase = async (
  side: WorkerSide,
  replayCase: WorkerRequest["cases"][number],
  request: WorkerRequest,
  index: number,
): Promise<WorkerOutcome> => {
  try {
    const loaded = await loadEntry(side, request, index);
    if (typeof loaded !== "function")
      throw new TypeError(`Replay export is not callable: ${side.entryExport}`);
    const returned = await Reflect.apply(loaded, undefined, [
      ...replayCase.arguments,
    ]);
    try {
      return {
        case_id: replayCase.caseId,
        outcome: "return",
        value: projectValue(
          returned,
          request.limits.resultDepth,
          request.limits.resultNodes,
        ),
        input_sha256: replayCase.inputSha256,
        output_sha256: null,
        truncated: false,
      };
    } catch (error: unknown) {
      return exceptionOutcome(
        replayCase,
        "serialization_error",
        error,
        request.limits.exceptionBytes,
      );
    }
  } catch (error: unknown) {
    return exceptionOutcome(
      replayCase,
      error instanceof ReplayDeniedError ? "denied" : "exception",
      error,
      request.limits.exceptionBytes,
    );
  }
};

const loadEntry = async (
  side: WorkerSide,
  request: WorkerRequest,
  caseIndex: number,
): Promise<unknown> => {
  const modules = new Map(side.modules.map((module) => [module.alias, module]));
  const context = deterministicContext(request, caseIndex);
  const esmCache = new Map<string, Module>();
  const commonJsCache = new Map<string, Record<string, unknown>>();

  const loadCommonJs = (alias: string): Record<string, unknown> => {
    const cached = commonJsCache.get(alias);
    if (cached !== undefined) return cached;
    const descriptor = requiredModule(modules, alias);
    if (descriptor.format !== "commonjs-factory")
      throw new TypeError(
        `Synchronous require cannot load ESM module: ${alias}`,
      );
    const module: { exports: Record<string, unknown> } = { exports: {} };
    commonJsCache.set(alias, module.exports);
    const requireModule = (specifier: string): Record<string, unknown> => {
      const dependency = descriptor.dependencies[specifier];
      if (dependency === undefined)
        throw new ReplayDeniedError(`Undeclared require: ${specifier}`);
      return loadCommonJs(dependency);
    };
    installRspackHelpers(requireModule);
    const source = normalizeFactorySource(descriptor.source);
    const factory: unknown = new Script(`(${source})`, {
      filename: `/modules/${alias}.js`,
    }).runInContext(context);
    if (typeof factory !== "function")
      throw new TypeError(`CommonJS factory is not callable: ${alias}`);
    Reflect.apply(factory, undefined, [module, module.exports, requireModule]);
    commonJsCache.set(alias, module.exports);
    return module.exports;
  };

  const loadEsm = async (alias: string): Promise<Module> => {
    const cached = esmCache.get(alias);
    if (cached !== undefined) return cached;
    const descriptor = requiredModule(modules, alias);
    let module: Module;
    if (descriptor.format === "commonjs-factory") {
      const exports = loadCommonJs(alias);
      const names = [...new Set(["default", ...Object.keys(exports)])];
      module = new SyntheticModule(
        names,
        function () {
          this.setExport("default", exports);
          for (const name of Object.keys(exports))
            this.setExport(name, exports[name]);
        },
        { context, identifier: `rea:${alias}` },
      );
    } else {
      module = new SourceTextModule(descriptor.source, {
        context,
        identifier: `rea:${alias}`,
        initializeImportMeta: (meta) => {
          meta.url = `rea:${alias}`;
        },
        importModuleDynamically: () => {
          throw new ReplayDeniedError(
            "Dynamic import is unavailable in controlled replay",
          );
        },
      });
    }
    esmCache.set(alias, module);
    await module.link(async (specifier) => {
      const dependency = descriptor.dependencies[specifier];
      if (dependency === undefined)
        throw new ReplayDeniedError(`Undeclared import: ${specifier}`);
      return loadEsm(dependency);
    });
    await module.evaluate();
    return module;
  };

  const entry = requiredModule(modules, side.entryAlias);
  if (entry.format === "commonjs-factory") {
    const exported = loadCommonJs(side.entryAlias);
    return side.entryExport === "default"
      ? (exported.default ?? exported)
      : exported[side.entryExport];
  }
  const namespace = (await loadEsm(side.entryAlias)).namespace;
  return Reflect.get(namespace, side.entryExport);
};

const deterministicContext = (request: WorkerRequest, caseIndex: number) => {
  let state = (request.determinism.randomSeed + caseIndex) >>> 0;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const epoch = Date.parse(request.determinism.clockIso);
  class ReplayDate extends Date {
    constructor(...arguments_: [] | [string | number]) {
      super(arguments_.length === 0 ? epoch : arguments_[0]);
    }
    static override now(): number {
      return epoch;
    }
  }
  const replayMath: Math = Object.create(Math);
  Object.defineProperty(replayMath, "random", { value: random });
  return createContext(
    { Date: ReplayDate, Math: replayMath },
    {
      name: "rea-controlled-replay",
      codeGeneration: { strings: false, wasm: false },
    },
  );
};

const installRspackHelpers = (
  require_: (specifier: string) => Record<string, unknown>,
): void => {
  const defineExports = (
    exports: Record<string, unknown>,
    definitions: Record<string, () => unknown>,
  ) => {
    for (const [name, getter] of Object.entries(definitions))
      if (!Object.prototype.hasOwnProperty.call(exports, name))
        Object.defineProperty(exports, name, { enumerable: true, get: getter });
  };
  const markModule = (exports: Record<string, unknown>) => {
    Object.defineProperty(exports, "__esModule", { value: true });
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  };
  const normalizeModule = (module: Record<string, unknown>) => {
    const getter = () => (module.__esModule === true ? module.default : module);
    Object.defineProperty(getter, "a", { get: getter });
    return getter;
  };
  const passModule = (module: Record<string, unknown>) => module;
  Object.defineProperties(require_, {
    d: { value: defineExports },
    r: { value: markModule },
    n: { value: normalizeModule },
    nmd: { value: passModule },
  });
};

const requiredModule = (
  modules: ReadonlyMap<string, WorkerModule>,
  alias: string,
): WorkerModule => {
  const module = modules.get(alias);
  if (module === undefined)
    throw new TypeError(`Undeclared module alias: ${alias}`);
  return module;
};

const normalizeFactorySource = (source: string): string =>
  /^\s*\d+\s*\(/u.test(source)
    ? source.replace(/^\s*\d+\s*\(/u, "function(")
    : source;

interface ProjectionContext {
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  nodes: number;
}

const projectValue = (
  value: unknown,
  maximumDepth: number,
  maximumNodes: number,
): unknown =>
  projectValueRecursive(value, 0, new Set(), {
    maximumDepth,
    maximumNodes,
    nodes: 0,
  });

const projectValueRecursive = (
  candidate: unknown,
  depth: number,
  ancestors: Set<object>,
  context: ProjectionContext,
): unknown => {
  context.nodes += 1;
  if (context.nodes > context.maximumNodes || depth > context.maximumDepth)
    throw new RangeError("Replay result projection limit exceeded");
  const leaf = projectLeaf(candidate);
  if (leaf !== undefined) return leaf;
  if (typeof candidate !== "object" || candidate === null)
    throw new TypeError(`Unsupported replay result type: ${typeof candidate}`);
  if (types.isProxy(candidate))
    throw new TypeError("Proxy replay results are unavailable");
  if (ancestors.has(candidate)) throw new TypeError("Cyclic replay result");
  ancestors.add(candidate);
  try {
    assertSupportedPrototype(candidate);
    return projectComplexValue(candidate, depth, ancestors, context);
  } finally {
    ancestors.delete(candidate);
  }
};

const projectLeaf = (candidate: unknown): unknown => {
  if (
    candidate === null ||
    typeof candidate === "string" ||
    typeof candidate === "boolean"
  )
    return candidate;
  if (typeof candidate === "number") {
    if (!Number.isFinite(candidate))
      throw new TypeError("Non-finite replay result number");
    return candidate;
  }
  return undefined;
};

const assertSupportedPrototype = (candidate: object): void => {
  if (Array.isArray(candidate)) return;
  const prototype: object | null = Object.getPrototypeOf(candidate);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
    throw new TypeError("Unsupported replay result prototype");
};

const projectComplexValue = (
  candidate: object,
  depth: number,
  ancestors: Set<object>,
  context: ProjectionContext,
): unknown[] | Record<string, unknown> => {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const output: unknown[] | Record<string, unknown> = Array.isArray(candidate)
    ? []
    : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" && Array.isArray(candidate)) continue;
    if (!("value" in descriptor))
      throw new TypeError("Replay result accessors are unavailable");
    if (Array.isArray(output)) {
      if (!/^\d+$/u.test(key))
        throw new TypeError("Replay arrays may only contain indexed values");
      output[Number(key)] = projectValueRecursive(
        descriptor.value,
        depth + 1,
        ancestors,
        context,
      );
    } else {
      output[key] = projectValueRecursive(
        descriptor.value,
        depth + 1,
        ancestors,
        context,
      );
    }
  }
  return output;
};

const exceptionOutcome = (
  replayCase: WorkerRequest["cases"][number],
  outcome: "exception" | "serialization_error" | "denied",
  error: unknown,
  maximumBytes: number,
): WorkerOutcome => {
  const details = exceptionDetails(error);
  const name = bounded(details.name, maximumBytes);
  const message = bounded(details.message, maximumBytes);
  const stack =
    details.stack === null ? null : bounded(details.stack, maximumBytes);
  return {
    case_id: replayCase.caseId,
    outcome,
    exception: { name, message, stack },
    input_sha256: replayCase.inputSha256,
    output_sha256: null,
    truncated: false,
  };
};

const exceptionDetails = (
  error: unknown,
): {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
} => {
  if (typeof error !== "object" || error === null)
    return { name: "Error", message: "Unknown replay exception", stack: null };
  if (types.isProxy(error))
    return { name: "Error", message: "Proxy replay exception", stack: null };
  const own = Object.getOwnPropertyDescriptors(error);
  const prototype: object | null = Object.getPrototypeOf(error);
  const inherited =
    prototype === null ? {} : Object.getOwnPropertyDescriptors(prototype);
  const stringValue = (
    descriptor: PropertyDescriptor | undefined,
  ): string | null =>
    descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  return {
    name: stringValue(own.name) ?? stringValue(inherited.name) ?? "Error",
    message: stringValue(own.message) ?? "Unknown replay exception",
    stack: stringValue(own.stack),
  };
};

const bounded = (value: string, maximumBytes: number): string => {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      /* try the preceding UTF-8 boundary */
    }
  }
  return "";
};

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Replay worker failed";
  process.stderr.write(message.slice(0, 4096));
  process.exitCode = 70;
});
