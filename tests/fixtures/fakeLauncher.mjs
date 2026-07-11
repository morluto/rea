import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bootstrapIndex = process.argv.indexOf("--python") + 1;
const actionIndex = Math.max(
  process.argv.indexOf("--executable"),
  process.argv.indexOf("--database"),
);
if (
  bootstrapIndex === 0 ||
  actionIndex === -1 ||
  bootstrapIndex > actionIndex
) {
  process.stderr.write("Python bootstrap must precede the Hopper action\n");
  process.exit(2);
}
const source = readFileSync(process.argv[bootstrapIndex], "utf8");
const [socketLine, tokenLine] = source.split("\n");
const socketPath = JSON.parse(socketLine.slice(socketLine.indexOf("=") + 1));
const token = JSON.parse(tokenLine.slice(tokenLine.indexOf("=") + 1));
const bridge = fileURLToPath(new URL("./fakeHopper.mjs", import.meta.url));
const child = spawn(process.execPath, [bridge, socketPath, token], {
  stdio: "ignore",
});
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => child.kill("SIGTERM"));
