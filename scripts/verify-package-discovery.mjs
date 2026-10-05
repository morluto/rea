import { json, run, runWithStatus } from "./lib/verify-package-core.mjs";

const REQUIRED_HELP_COMMANDS = [
  "setup",
  "update",
  "inspect-artifact",
  "extract-artifact",
  "import-reference-source",
  "list-browser-targets",
  "inspect-web-page",
  "analyze-javascript-application",
  "compare",
];

const REQUIRED_LLM_TOPICS = [
  "decompile",
  "function",
  "search",
  "inspect",
  "xrefs",
  "trace",
  "capabilities",
  "providers",
  "inspect-artifact",
  "list-browser-targets",
  "inspect-web-page",
  "analyze-javascript-application",
];

/** Validate --help, --llms, and doctor output and determine host setup support. */
export async function verifyPackageDiscovery({ cli, environment }) {
  const help = await run(cli, ["--help"], environment);
  const llms = await run(cli, ["--llms"], environment);
  const doctorExecution = await runWithStatus(
    cli,
    ["doctor", "--json"],
    environment,
  );
  const doctor = json(doctorExecution.stdout);
  const supportedSetupHost =
    doctor.checks?.find(({ name }) => name === "host")?.ok === true;
  const hopperSetupSupported =
    supportedSetupHost && process.platform !== "win32";
  const hopperReady = doctor.checks?.find(({ name }) => name === "hopper")?.ok;
  const expectedDoctorHealth = doctor.checks?.every(({ ok }) => ok) === true;
  const missingHelp = REQUIRED_HELP_COMMANDS.filter(
    (command) => !help.includes(command),
  );
  const missingLlms = REQUIRED_LLM_TOPICS.filter(
    (topic) => !llms.includes(topic),
  );
  if (
    missingHelp.length !== 0 ||
    missingLlms.length !== 0 ||
    doctor.healthy !== expectedDoctorHealth ||
    doctorExecution.status !== (expectedDoctorHealth ? 0 : 1) ||
    (hopperSetupSupported && hopperReady !== true)
  )
    throw new Error(
      `packaged CLI discovery or doctor failed: ${JSON.stringify({ helpSetup: help.includes("setup"), llmsDecompile: llms.includes("decompile"), doctor })}`,
    );
  return { supportedSetupHost, hopperSetupSupported };
}
