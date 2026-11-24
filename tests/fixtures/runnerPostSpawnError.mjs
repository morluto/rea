import spawn from "cross-spawn";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

const supervisor = new URL(
  "../../scripts/run-exclusive-command.mjs",
  import.meta.url,
).href;

// Replace only the supervisor's dependency, leaving its actual source and the
// public wrapper intact. Other imports still use the real implementation.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cross-spawn" && context.parentURL === supervisor)
      return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

export default function spawnWithPostSpawnError(command, args, options) {
  const child = spawn(command, args, options);
  if (args.at(-1) !== "rea-runner-post-spawn-error") return child;
  let timer;
  child.once("close", () => clearInterval(timer));
  child.once("spawn", () => {
    timer = setInterval(() => {
      if (!existsSync(process.env.REA_TEST_RUNNER_READY_PATH)) return;
      clearInterval(timer);
      process.stdout.write("controlled-post-spawn-error\n");
      child.emit("error", new Error("controlled post-spawn child error"));
      child.emit("error", new Error("controlled secondary child error"));
    }, 5);
  });
  return child;
}
