import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Writes a periodic report, then stays alive until a signal arrives. In
// "cooperative" mode SIGTERM produces a final report and a clean exit; in
// "ignoring" mode SIGTERM is swallowed so only SIGKILL ends the process.
const [mode, directory] = process.argv.slice(2);

writeFileSync(
  join(directory, "periodic.json"),
  JSON.stringify({ phase: "periodic" }),
);

process.on("SIGTERM", () => {
  if (mode !== "cooperative") return;
  writeFileSync(
    join(directory, "final.json"),
    JSON.stringify({ phase: "final" }),
  );
  process.exit(0);
});

setInterval(() => undefined, 1_000);
