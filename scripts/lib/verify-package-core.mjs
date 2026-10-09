import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";

/** Promisified child_process execution helper. */
export const exec = promisify(execFile);

/** Run a command and return its stdout. */
export const run = async (command, args, env) =>
  (await exec(command, args, { env })).stdout;

/** Run a command and treat exit code 1 as a non-throwing status result. */
export const runWithStatus = async (command, args, env) => {
  try {
    return { stdout: await run(command, args, env), status: 0 };
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      cause.code === 1 &&
      typeof cause.stdout === "string"
    )
      return { stdout: cause.stdout, status: 1 };
    throw cause;
  }
};

/** Parse JSON from a command output string. */
export const json = (text) => JSON.parse(text);

/** Verify schema validity and that the MCP catalog matches session metadata. */
export const verifyCompleteToolCatalog = async (client, options) => {
  const listed = await client.listTools(undefined, options);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const tool of listed.tools) {
    for (const kind of ["inputSchema", "outputSchema"]) {
      const schema = tool[kind];
      if (schema !== undefined && !ajv.validateSchema(schema))
        throw new Error(
          `packaged MCP has invalid ${tool.name}.${kind}: ${ajv.errorsText(ajv.errors)}`,
        );
    }
  }
  const status = await client.callTool(
    { name: "binary_session", arguments: {} },
    options,
  );
  const availability = status.structuredContent?.result?.tool_availability;
  if (!Array.isArray(availability))
    throw new Error("packaged MCP omitted tool availability");
  const expected = availability.map(({ name }) => name).sort();
  const observed = listed.tools.map(({ name }) => name).sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    throw new Error(
      "packaged MCP tool inventory diverged from session metadata",
    );
  return observed;
};

/** Check whether a path exists on disk. */
export const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
};
