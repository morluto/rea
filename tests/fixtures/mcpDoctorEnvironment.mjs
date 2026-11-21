import { writeFile } from "node:fs/promises";

// Publish the environment the doctor handed this child, then exit before any
// protocol work so the doctor reports the startup failure under test.
if (process.env.REA_MCP_DOCTOR_SEEN_PATH !== undefined)
  await writeFile(
    process.env.REA_MCP_DOCTOR_SEEN_PATH,
    JSON.stringify(process.env),
  );
process.exit(0);
