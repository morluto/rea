// Explicit experiment entrypoint; never loaded by REA's runtime composition.
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { connectionSchema } from "./probe.mjs";
import { entrypointLifetime } from "./entrypoint-lifetime.mjs";
import { viewObservation } from "./analysis-view.mjs";
import { byteInputSchema } from "./native-bytes.mjs";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import {
  createAnalysisExperiment,
  functionInputSchema,
  typeInputSchema,
  traceInputSchema,
} from "./analysis.mjs";

const lifetime = entrypointLifetime();
const config = z
  .strictObject({
    connection: connectionSchema,
    prelude: z.array(z.string()).optional(),
  })
  .parse(JSON.parse(await readFile(process.argv[2], "utf8")));
const experiment = createAnalysisExperiment(config.connection, {
  prelude: config.prelude,
  signal: lifetime.signal,
});
const server = new McpServer({
  name: "radare2-analysis-experiment",
  version: "0",
});
server.server.onclose = () =>
  lifetime.abort(new Error("MCP connection closed"));
const outputSchema = z.object({ observation: z.unknown() });
const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
function reply(result) {
  if (!result.ok)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(projectAnalysisError(result.error)),
        },
      ],
    };
  const output = { observation: result.value };
  return {
    structuredContent: output,
    content: [{ type: "text", text: JSON.stringify(output) }],
  };
}

server.registerTool(
  "analyze_function",
  {
    description:
      "Experimental r2 function facts: CFG, assembly/ESIL, native signature and selected decompiler. Summary retains complete observation for focused views. Target is bound by launch configuration; commands can change analysis state. No REA Evidence is generated.",
    inputSchema: functionInputSchema.extend({
      detail: z.enum(["summary", "full"]).default("summary"),
    }),
    outputSchema,
    annotations,
  },
  async ({ detail, ...input }, context) => {
    const result = await experiment.analyze(input, {
      signal: context.mcpReq.signal,
    });
    if (result.ok && detail === "summary") {
      const { instructions, high_pcode, esil, ...rest } = result.value.result;
      result.value = {
        ...result.value,
        result: {
          ...rest,
          high_pcode: high_pcode
            ? {
                producer: high_pcode.producer,
                ir: high_pcode.ir,
                summary: high_pcode.summary,
                parameters: high_pcode.parameters,
                truncated: high_pcode.truncated,
                unknowns: high_pcode.unknowns,
                limitations: high_pcode.limitations,
              }
            : null,
          esil: esil
            ? {
                producer: esil.producer,
                ir: esil.ir,
                coverage: esil.coverage,
                limitations: esil.limitations,
              }
            : null,
          instruction_count: instructions.length,
        },
      };
    }
    return reply(result);
  },
);

server.registerTool(
  "inspect_native_data_type",
  {
    description:
      "Experimental inspection of an exact named r2 database struct. Returns stored field offsets and sizes. Header/DWARF/inference origin must be established separately; aggregate alignment and trailing padding remain unknown.",
    inputSchema: typeInputSchema,
    outputSchema,
    annotations,
  },
  async (input, context) =>
    reply(
      await experiment.inspectType(input, { signal: context.mcpReq.signal }),
    ),
);

server.registerTool(
  "read_bytes",
  {
    description:
      "Read a bounded virtual byte range through r2. Complete coverage is true only when native bytes match an independent initialized file-backed range of the unchanged owned target. Padding, overlays, unmapped ranges and external-core identity remain explicit unknowns. Full native responses remain retained.",
    inputSchema: byteInputSchema,
    outputSchema,
    annotations,
  },
  async (input, context) =>
    reply(await experiment.readBytes(input, { signal: context.mcpReq.signal })),
);

server.registerTool(
  "trace_native_values",
  {
    description:
      "Experimental value dependencies. Default r2ghidra high-pcode follows an optional zero-based parameter ordinal. With ir:esil, select address, instruction_count and register for a native straight-line ESIL DFG slice without a decompiler. Neither proves memory aliasing, feasible paths or cross-function bindings. Full producer observations remain retained.",
    inputSchema: traceInputSchema,
    outputSchema,
    annotations,
  },
  async (input, context) =>
    reply(await experiment.trace(input, { signal: context.mcpReq.signal })),
);

server.registerTool(
  "view_radare2_observation",
  {
    description:
      "Read a retained experimental observation without rerunning analysis. Pages use array ordinals; raw JSON pages use UTF-16 code units. Observations are session-local and are not REA Evidence.",
    inputSchema: z.strictObject({
      observation_id: z.string().uuid(),
      facet: z.enum([
        "cfg",
        "instructions",
        "signature",
        "pseudocode",
        "byte_hex",
        "flow_operations",
        "flow_edges",
        "flow_parameters",
        "esil",
        "raw",
      ]),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(8192).default(50),
    }),
    outputSchema,
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
  },
  async (input) => reply(viewObservation(experiment, input)),
);

server.registerTool(
  "release_radare2_observation",
  {
    description:
      "Release a retained experimental observation from this server's bounded memory.",
    inputSchema: z.strictObject({ observation_id: z.string().uuid() }),
    outputSchema,
    annotations,
  },
  async ({ observation_id }) =>
    reply({
      ok: true,
      value: { released: experiment.release(observation_id) },
    }),
);

// Configuration reads may finish after shutdown. Never start a new stdio peer
// then, and close again after a connect that raced cancellation settles.
if (!lifetime.signal.aborted) {
  lifetime.signal.addEventListener("abort", () => void server.close(), {
    once: true,
  });
  try {
    await server.connect(new StdioServerTransport());
  } finally {
    if (lifetime.signal.aborted) await server.close();
  }
}
