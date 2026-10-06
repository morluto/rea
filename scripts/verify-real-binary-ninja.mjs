import { parseConfig } from "../dist/config.js";
import { createBinarySession } from "../dist/application/runtime.js";
import { EnhancedTools } from "../dist/application/EnhancedTools.js";

const target = process.argv[2];
if (target === undefined || process.argv.length !== 3)
  throw new Error(
    "Usage: npm run verify:binary-ninja -- /absolute/path/to/native-executable",
  );
const parsed = parseConfig(process.env);
if (!parsed.ok) throw parsed.error;
if (parsed.value.binaryNinjaMcp === undefined)
  throw new Error(
    "Binary Ninja verification requires REA_BINARY_NINJA_MCP_URL or REA_BINARY_NINJA_MCP_COMMAND and a running/licensed built-in server.",
  );
const session = createBinarySession(parsed.value);
const requireSuccess = (result) => {
  if (!result.ok) throw result.error;
  return result.value;
};
try {
  const opened = requireSuccess(
    await session.open(target, { providerId: "binary-ninja" }),
  );
  const inventory = requireSuccess(
    await session.execute("list_procedures", {}),
  );
  if (!Array.isArray(inventory.result) || inventory.result.length === 0)
    throw new Error(
      "The real target produced no functions; choose a native executable with analyzable code.",
    );
  const first = inventory.result[0];
  if (
    first === null ||
    typeof first !== "object" ||
    Array.isArray(first) ||
    typeof first.address !== "string"
  )
    throw new Error("Invalid real-provider function inventory");
  const decompiled = requireSuccess(
    await session.execute("procedure_pseudo_code", {
      procedure: first.address,
    }),
  );
  const dossier = requireSuccess(
    await new EnhancedTools(session).execute("analyze_function", {
      procedure: first.address,
    }),
  );
  const overview = requireSuccess(
    await new EnhancedTools(session).execute("binary_overview", {}),
  );
  process.stdout.write(
    `${JSON.stringify({ target: opened, provider: inventory.provider, functions: inventory.result.length, decompilation_available: typeof decompiled.result === "string", dossier, overview }, null, 2)}\n`,
  );
} finally {
  requireSuccess(await session.close());
}
