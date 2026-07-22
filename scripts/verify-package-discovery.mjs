import { json, run, runWithStatus } from "./lib/verify-package-core.mjs";

const REQUIRED_HELP_COMMANDS = [
  "setup",
  "upgrade",
  "inventory-artifact",
  "extract-artifact",
  "investigate-versions",
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
  "inventory-artifact",
  "list-browser-targets",
  "inspect-web-page",
  "analyze-javascript-application",
];

/** Validate --help, --llms, and doctor output and determine host setup support. */
export async function verifyPackageDiscovery({ cli, environment }) {
  const help = await run(cli, ["--help"], environment);
  const llms = await run(cli, ["--llms"], environment);
  const summaryExecution = await runWithStatus(
    cli,
    ["doctor", "--json"],
    environment,
  );
  const doctorExecution = await runWithStatus(
    cli,
    ["doctor", "--detail", "full", "--json"],
    environment,
  );
  const summary = json(summaryExecution.stdout);
  const doctor = json(doctorExecution.stdout);
  const supportedSetupHost =
    doctor.checks?.find(({ name }) => name === "host")?.ok === true;
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
    summary.healthy !== doctor.healthy ||
    summaryExecution.status !== doctorExecution.status ||
    summary.checks !== undefined ||
    !Array.isArray(summary.failed_scope_checks) ||
    doctor.checks?.find(({ name }) => name === "hopper")?.ok !== true
  )
    throw new Error(
      `packaged CLI discovery or doctor failed: ${JSON.stringify({ helpSetup: help.includes("setup"), llmsDecompile: llms.includes("decompile"), summary, doctor })}`,
    );
  return { supportedSetupHost };
}
