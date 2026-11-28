import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { YaraMatchesService } from "../../../src/application/yara/YaraMatchesService.js";
import { ok } from "../../../src/domain/result.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import {
  YaraMatchesProvider,
  type YaraLauncher,
} from "../../../src/yara/YaraMatchesProvider.js";

/**
 * A yara stand-in. YARA_STUB_MODE selects the behavior; the last argument is
 * the scanned path and the arguments before it are the options and rules.
 * Rule arguments resolve as yara 4.6.0 resolves them: the whole argument,
 * relative to the working directory, when that file exists, and otherwise
 * the NAMESPACE:FILE split at the first colon.
 */
export const YARA_STUB = String.raw`
const fs = require("node:fs");
const { resolve } = require("node:path");
const args = process.argv.slice(2);
const target = args.at(-1);
const ruleArgs = args.filter((value) => value.endsWith(".yar"));
const ruleFile = (arg) => {
  if (fs.existsSync(resolve(process.cwd(), arg))) return arg;
  const colon = arg.indexOf(":");
  return colon === -1 ? arg : arg.slice(colon + 1);
};
const rules = ruleArgs.map(ruleFile);
if (process.env.YARA_STUB_ARGS) fs.writeFileSync(process.env.YARA_STUB_ARGS, JSON.stringify({ args, cwd: process.cwd() }));
const collectRuleNames = (filePath) => {
  const fullPath = resolve(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    process.stderr.write("error: could not open file: " + filePath + "\n");
    process.exit(1);
  }
  const text = fs.readFileSync(fullPath, "utf8");
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = /^\s*rule\s+(\w+)/.exec(line);
    if (rule) names.push(rule[1]);
  }
  return names;
};
switch (process.env.YARA_STUB_MODE) {
  case "resolve":
    for (const file of rules) {
      for (const name of collectRuleNames(file)) {
        process.stdout.write(name + " [] [] " + target + "\n");
      }
    }
    break;
  case "match":
    process.stderr.write('warning: rule "Slow" in ' + rules[0] + '(2): string "$a" may slow down scanning\n');
    process.stdout.write('Packed [packer,upx] [author="Analyst",score =7] ' + target + "\n");
    process.stdout.write("0x0:4:$mz: MZ\\x90\\x00\n0x10:3:$upx: UPX\n");
    process.stdout.write("Plain [] [] " + target + "\n");
    break;
  case "many":
    process.stdout.write("Many [] [] " + target + "\n");
    for (let index = 0; index < 50; index += 1)
      process.stdout.write("0x" + index.toString(16) + ":1:$a: A\n");
    break;
  case "compile":
    process.stderr.write('error: rule "Bad" in ' + rules[0] + '(3): undefined identifier "nope"\n');
    process.exit(1);
  case "duplicate-string":
    process.stderr.write('error: rule "Dup" in ' + rules[0] + '(4): duplicated string identifier "$a"\n');
    process.exit(1);
  case "scan-error":
    process.stderr.write("error scanning " + target + ": could not map file\n");
    process.exit(1);
  case "garbage":
    process.stdout.write("this is not yara output\n");
    break;
  case "flood":
    process.stdout.write("Flood [] [] " + target + "\n");
    for (let index = 0; index < 4000; index += 1)
      process.stdout.write("0x0:1:$a: A\n");
    break;
  case "mutate":
    fs.appendFileSync(target, "changed during the scan");
    break;
  case "mutate-rule":
    fs.appendFileSync(resolve(process.cwd(), rules.at(-1)), "\n// edited in place\n");
    process.stdout.write("Plain [] [] " + target + "\n");
    break;
  case "hang":
    fs.writeFileSync(process.env.YARA_STUB_ARGS + ".pid", String(process.pid));
    setInterval(() => {}, 1000);
    break;
}
`;

export const YARA_STUB_SAMPLE = Buffer.from(
  "MZ\x90\x00 synthetic UPX sample\n",
  "latin1",
);
export const YARA_STUB_RULE =
  'rule Packed { strings: $mz = "MZ" condition: $mz }\n';

// The stand-in runs under node, so its process-table command is node rather
// than the selected path; disable argv-prefix matching as interpreter-driven
// launch scripts do. Process-group ownership is still verified.
export const interpreterLauncher: YaraLauncher = (spawn) =>
  spawnOwnedProviderProcess({ ...spawn, expectedCommand: null });

/** Write the stand-in as an executable node script named `yara-stub.cjs`. */
export const writeYaraStub = async (root: string): Promise<string> => {
  const command = join(root, "yara-stub.cjs");
  await writeFile(command, `#!${process.execPath}\n${YARA_STUB}`, {
    mode: 0o755,
  });
  return command;
};

/** A service whose provider runs `command` through the interpreter launcher. */
export const yaraStubService = (
  command: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  launcher: YaraLauncher = interpreterLauncher,
) =>
  new YaraMatchesService(
    new YaraMatchesProvider({
      environment,
      selectCommand: () => ok(command),
      launcher,
    }),
    environment,
  );
