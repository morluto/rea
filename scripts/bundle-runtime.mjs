import { parse } from "@babel/parser";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Entry and lazy-group chunks that must reference a CLI module before it joins
 * the shared chunk. Measured on representative commands: lower values grow the
 * shared chunk every single command loads; higher values restore many small
 * chunks that slow the full command catalog.
 */
const CLI_SHARED_CHUNK_MIN_SHARE_COUNT = 12;

/**
 * Entries the executable imports before it selects a command. Their static
 * closure stays out of the shared chunk so version reports, preflight errors
 * and MCP routing do not load the command runtime or its dependencies.
 */
const CLI_PREFLIGHT_ENTRIES = ["cliOutput.js", "cliBuiltinArguments.js"];

/**
 * Compute the modules statically reachable from a preflight entry once the
 * graph is complete. Chunking runs after `buildEnd`, so every group test sees
 * the finished closure.
 */
const createPreflightClosure = (compiledRoot) => {
  let closure;
  return {
    plugin: {
      name: "record-cli-preflight-closure",
      buildEnd() {
        closure = new Set();
        const pending = CLI_PREFLIGHT_ENTRIES.map((path) =>
          join(compiledRoot, path),
        );
        while (pending.length > 0) {
          const next = pending.pop();
          if (closure.has(next)) continue;
          closure.add(next);
          pending.push(...(this.getModuleInfo(next)?.importedIds ?? []));
        }
      },
    },
    has(id) {
      if (closure === undefined)
        throw new Error("CLI preflight closure was read before buildEnd");
      return closure.has(id);
    },
  };
};

/**
 * CLI command groups load lazily. Modules shared by many groups share one
 * chunk, so a single command avoids hundreds of tiny imports while the full
 * catalog still loads each group's own code once.
 */
const cliCodeSplitting = (preflight) => ({
  groups: [
    // Captured first so the shared group cannot pull preflight modules in as
    // dependencies. Entry-aware subgroups keep each preflight entry's load
    // limited to the modules it reaches.
    {
      name: "cli-preflight",
      priority: 1,
      entriesAware: true,
      test: (id) => preflight.has(id),
    },
    {
      name: "cli-shared",
      minShareCount: CLI_SHARED_CHUNK_MIN_SHARE_COUNT,
      test: (id) => !preflight.has(id),
    },
  ],
});

/**
 * Reduce filesystem resolution during CLI and MCP startup. Keep dependencies
 * external, dynamic imports lazy, and original compiled worker entrypoints.
 */
export const bundleRuntime = async (root) => {
  const compiledRoot = resolve(root, "dist");
  // CLI, MCP, workers and updater fixtures share one release-identity owner.
  const metadataModule = join(compiledRoot, "generatedPackageMetadata.js");
  const isMetadataModule = (id) =>
    isAbsolute(id) && resolve(id) === metadataModule;
  const { rolldown, RUNTIME_MODULE_ID } = await import("rolldown");
  const { imports = {} } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  for (const [directory, entries] of [
    ["mcp", { main: "main.js" }],
    [
      "cli-runtime",
      {
        cli: "cli.js",
        cliOutput: "cliOutput.js",
        cliBuiltinArguments: "cliBuiltinArguments.js",
        cliResultOutput: "cli/cliResultOutput.js",
        mcpDoctor: "mcpDoctor.js",
      },
    ],
  ]) {
    const preflight = createPreflightClosure(compiledRoot);
    const bundle = await rolldown({
      input: Object.fromEntries(
        Object.entries(entries).map(([name, path]) => [
          name,
          join(compiledRoot, path),
        ]),
      ),
      platform: "node",
      treeshake: false,
      external: (source) =>
        isMetadataModule(source) ||
        (!source.startsWith(".") && !isAbsolute(source)),
      plugins: [
        preflight.plugin,
        {
          name: "preserve-compiled-module-locations",
          transform(code, id) {
            if (id === RUNTIME_MODULE_ID) return null;
            if (!code.includes("import.meta")) return null;
            const sourcePath = relative(compiledRoot, id);
            if (
              isAbsolute(sourcePath) ||
              sourcePath === ".." ||
              sourcePath.startsWith(`..${sep}`)
            )
              throw new Error(`Runtime bundle input is outside dist: ${id}`);
            // Each output directory is directly under dist. Preserve the original
            // module URL, including URL escaping, for bridges and createRequire.
            const moduleUrl = `new URL(${JSON.stringify(`../${sourcePath.split(sep).map(encodeURIComponent).join("/")}`)}, import.meta.url).href`;
            const edits = [];
            const visit = (node) => {
              if (node === null || typeof node !== "object") return;
              const isMeta = (value) =>
                value?.type === "MetaProperty" &&
                value.meta.name === "import" &&
                value.property.name === "meta";
              if (
                node.type === "CallExpression" &&
                node.callee.type === "MemberExpression" &&
                !node.callee.computed &&
                isMeta(node.callee.object) &&
                node.callee.property.name === "resolve" &&
                node.arguments.length === 1 &&
                node.arguments[0].type === "StringLiteral" &&
                Object.hasOwn(imports, node.arguments[0].value)
              )
                // Package imports resolve in the same package scope after bundling.
                return;
              if (
                node.type === "MemberExpression" &&
                !node.computed &&
                isMeta(node.object) &&
                node.property.name === "url"
              ) {
                edits.push({ start: node.start, end: node.end });
                return;
              }
              if (isMeta(node))
                throw new Error(
                  `Unsupported import.meta use in runtime bundle: ${id}`,
                );
              for (const value of Object.values(node)) {
                if (Array.isArray(value)) value.forEach(visit);
                else visit(value);
              }
            };
            visit(parse(code, { sourceType: "module" }).program);
            for (const { start, end } of edits.sort(
              (a, b) => b.start - a.start,
            ))
              code = code.slice(0, start) + moduleUrl + code.slice(end);
            return { code, map: null };
          },
        },
      ],
    });
    try {
      await bundle.write({
        dir: join(compiledRoot, directory),
        format: "esm",
        entryFileNames: "[name].js",
        chunkFileNames:
          directory === "mcp"
            ? "[name]-[hash].js"
            : (chunk) => {
                // Entry-aware subgroup names list every entry; the hash suffices.
                if (chunk.name.startsWith("cli-preflight"))
                  return "cli-preflight-[hash].js";
                // Keep lazy facades distinguishable when source basenames repeat.
                if (typeof chunk.facadeModuleId !== "string")
                  return "[name]-[hash].js";
                const path = relative(compiledRoot, chunk.facadeModuleId);
                return `${path.replace(/\.js$/u, "").split(sep).join("__")}-[hash].js`;
              },
        paths: (id) =>
          isMetadataModule(id) ? "../generatedPackageMetadata.js" : id,
        minifyInternalExports: directory === "mcp",
        codeSplitting: directory === "mcp" ? true : cliCodeSplitting(preflight),
        strictExecutionOrder: true,
        minify: false,
        sourcemap: false,
      });
    } finally {
      await bundle.close();
    }
  }
};

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await bundleRuntime(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
