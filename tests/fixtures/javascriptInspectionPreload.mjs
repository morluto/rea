import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Deny only post-analysis inspection. Startup and the real inert worker run normally.
let completed = false;
let interrupted = false;
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const text = String(chunk);
  if (
    text.includes('"phase":"analyze_javascript_application"') &&
    text.includes('"terminal":true')
  )
    completed = true;
  return write(chunk, ...args);
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, ...args) => {
  if (completed && command === "ps") {
    if (process.env.REA_INSPECTION_MODE === "cancel" && !interrupted) {
      interrupted = true;
      process.emit("SIGINT");
    }
    if (process.env.REA_INSPECTION_MODE !== "deny")
      return spawn(command, ...args);
    appendFileSync(process.env.REA_INSPECTION_TRACE, '{"kind":"denied"}\n');
    throw Object.assign(new Error("spawn EPERM"), {
      code: "EPERM",
      syscall: "spawn ps",
      path: "ps",
    });
  }
  const child = spawn(command, ...args);
  const options = args.at(-1);
  if (
    options?.cwd?.includes("rea-javascript-analysis-") &&
    options?.env?.REA_PROCESS_RUN_ID?.startsWith("rea-javascript-analysis-")
  )
    appendFileSync(
      process.env.REA_INSPECTION_TRACE,
      JSON.stringify({
        kind: "worker",
        root: options.cwd,
        leaderPid: child.pid,
        processGroupId: child.pid,
        runId: options.env.REA_PROCESS_RUN_ID,
      }) + "\n",
    );
  return child;
};
syncBuiltinESMExports();
