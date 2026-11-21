import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  describeEvidenceBundleFailure,
  parseEvidenceBundle,
} from "../../dist/domain/evidenceBundle.js";
import { render, validate } from "./triage.mjs";

const USAGE = `Usage:
  node experiments/findings-triage/cli.mjs validate --triage FILE --bundle FILE [--json]
  node experiments/findings-triage/cli.mjs render --triage FILE --bundle FILE --out DIR`;
const file = { type: "string" };
const COMMANDS = {
  validate: { triage: file, bundle: file, json: { type: "boolean" } },
  render: { triage: file, bundle: file, out: file },
};

class UsageError extends Error {}

const parseCommand = ([command, ...args]) => {
  if (!Object.hasOwn(COMMANDS, command))
    throw new UsageError(`Unknown command: ${command ?? "(none)"}`);
  const options = COMMANDS[command];
  let values;
  try {
    ({ values } = parseArgs({ args, options, strict: true }));
  } catch (cause) {
    throw new UsageError(cause.message);
  }
  for (const [name, { type }] of Object.entries(options))
    if (type === "string" && values[name] === undefined)
      throw new UsageError(`Missing --${name}`);
  return { command, values };
};

const readJson = async (path, label) => {
  const bytes = await readFile(path);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (cause) {
    throw new Error(`${label} ${path} is not valid JSON: ${cause.message}`);
  }
};

const readBundle = async (path) => {
  const { bytes, value } = await readJson(path, "Bundle");
  try {
    return {
      bundle: parseEvidenceBundle(value),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (cause) {
    throw new Error(describeEvidenceBundleFailure(value, cause).message);
  }
};

const formatIssue = ({ code, path, message }) =>
  `${code} at ${path || "(root)"}: ${message}`;

export const writeOutput = async (out, files) => {
  // Non-recursive: an existing directory or missing parent fails, so
  // nothing the caller owns is ever overwritten. Owner-only, because the
  // report and advisories can hold private findings.
  await mkdir(out, { mode: 0o700 });
  try {
    for (const [path, content] of files) {
      const target = join(out, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
  } catch (cause) {
    // This run created the directory, so a partial render is entirely ours.
    await rm(out, { recursive: true, force: true });
    throw cause;
  }
};

const main = async (argv) => {
  const { command, values } = parseCommand(argv);
  const { value: input } = await readJson(values.triage, "Triage");
  const { bundle, sha256 } = await readBundle(values.bundle);
  const { triage, issues } = validate(input, bundle);
  if (command === "validate") {
    if (values.json) console.log(JSON.stringify(issues, null, 2));
    else for (const issue of issues) console.log(formatIssue(issue));
    return issues.length > 0 ? 1 : 0;
  }
  for (const issue of issues) console.error(formatIssue(issue));
  if (issues.length > 0) return 1;
  await writeOutput(values.out, render(triage, bundle, sha256));
  return 0;
};

if (import.meta.main)
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (cause) {
    console.error(
      cause instanceof UsageError
        ? `${cause.message}\n${USAGE}`
        : cause.message,
    );
    process.exitCode = 2;
  }
