import { writeFile } from "node:fs/promises";

// Publish only the doctor-handoff variables this test inspects, then exit
// before any protocol work so the doctor reports the startup failure under
// test. The rest of the inherited environment is never persisted.
const witness = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(HOPPER_TARGET_|REA_MCP_DOCTOR_)/u.test(key),
  ),
);
if (process.env.REA_MCP_DOCTOR_SEEN_PATH !== undefined)
  await writeFile(
    process.env.REA_MCP_DOCTOR_SEEN_PATH,
    JSON.stringify(witness),
  );
process.exit(0);
