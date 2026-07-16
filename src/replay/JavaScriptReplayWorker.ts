import {
  Script,
  SourceTextModule,
  SyntheticModule,
  createContext,
  type Module,
} from "node:vm";
import { types } from "node:util";

interface WorkerModule {
  readonly alias: string;
  readonly format: "esm" | "commonjs-factory";
  readonly dependencies: Readonly<Record<string, string>>;
  readonly source: string;
}

interface WorkerSide {
  readonly modules: readonly WorkerModule[];
  readonly entryAlias: string;
  readonly entryExport: string;
}

interface WorkerRequest {
  readonly schemaVersion: 1;
  readonly left: WorkerSide;
  readonly right?: WorkerSide;
  readonly cases: readonly {
    readonly caseId: string;
    readonly arguments: readonly unknown[];
    readonly inputSha256: string;
  }[];
  readonly determinism: {
    readonly clockIso: string;
    readonly randomSeed: number;
  };
  readonly limits: {
    readonly resultDepth: number;
    readonly resultNodes: number;
    readonly exceptionBytes: number;
  };
}

interface WorkerOutcome {
  readonly case_id: string;
  readonly outcome: "return" | "exception" | "serialization_error" | "denied";
  readonly value?: unknown;
  readonly exception?: {
    readonly name: string;
    readonly message: string;
    readonly stack: string | null;
  };
  readonly input_sha256: string;
  readonly output_sha256: null;
  readonly truncated: false;
}

class ReplayDeniedError extends Error {
  override readonly name = "ReplayDeniedError";
}

const main = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as WorkerRequest;
  if (request.schemaVersion !== 1)
    throw new TypeError("Unsupported replay worker protocol");
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
    const module = { exports: {} as Record<string, unknown> };
    commonJsCache.set(alias, module.exports);
    const requireModule = ((specifier: string): Record<string, unknown> => {
      const dependency = descriptor.dependencies[specifier];
      if (dependency === undefined)
        throw new ReplayDeniedError(`Undeclared require: ${specifier}`);
      return loadCommonJs(dependency);
    }) as ((specifier: string) => Record<string, unknown>) &
      Record<string, unknown>;
    installRspackHelpers(requireModule);
    const source = normalizeFactorySource(descriptor.source);
    const factory = new Script(`(${source})`, {
      filename: `/modules/${alias}.js`,
    }).runInContext(context) as (
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>,
      require_: typeof requireModule,
    ) => void;
    factory(module, module.exports, requireModule);
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
  return (namespace as Record<string, unknown>)[side.entryExport];
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
  const replayMath = Object.create(Math) as Math;
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
  require_: ((specifier: string) => Record<string, unknown>) &
    Record<string, unknown>,
): void => {
  require_.d = (
    exports: Record<string, unknown>,
    definitions: Record<string, () => unknown>,
  ) => {
    for (const [name, getter] of Object.entries(definitions))
      if (!Object.prototype.hasOwnProperty.call(exports, name))
        Object.defineProperty(exports, name, { enumerable: true, get: getter });
  };
  require_.r = (exports: Record<string, unknown>) => {
    Object.defineProperty(exports, "__esModule", { value: true });
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  };
  require_.n = (module: Record<string, unknown>) => {
    const getter = () => (module.__esModule === true ? module.default : module);
    Object.defineProperty(getter, "a", { get: getter });
    return getter;
  };
  require_.nmd = (module: Record<string, unknown>) => module;
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

const projectValue = (
  value: unknown,
  maximumDepth: number,
  maximumNodes: number,
): unknown => {
  let nodes = 0;
  const visit = (
    candidate: unknown,
    depth: number,
    ancestors: Set<object>,
  ): unknown => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth)
      throw new RangeError("Replay result projection limit exceeded");
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
    if (typeof candidate !== "object")
      throw new TypeError(
        `Unsupported replay result type: ${typeof candidate}`,
      );
    if (types.isProxy(candidate))
      throw new TypeError("Proxy replay results are unavailable");
    if (ancestors.has(candidate)) throw new TypeError("Cyclic replay result");
    ancestors.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const output: unknown[] | Record<string, unknown> = Array.isArray(
        candidate,
      )
        ? []
        : {};
      if (!Array.isArray(candidate)) {
        const prototype = Object.getPrototypeOf(candidate) as object | null;
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
          throw new TypeError("Unsupported replay result prototype");
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length" && Array.isArray(candidate)) continue;
        if (!("value" in descriptor))
          throw new TypeError("Replay result accessors are unavailable");
        if (Array.isArray(output)) {
          if (!/^\d+$/u.test(key))
            throw new TypeError(
              "Replay arrays may only contain indexed values",
            );
          output[Number(key)] = visit(descriptor.value, depth + 1, ancestors);
        } else output[key] = visit(descriptor.value, depth + 1, ancestors);
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value, 0, new Set());
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
  const prototype = Object.getPrototypeOf(error) as object | null;
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
