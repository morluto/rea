import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Writes a periodic report, then behaves by mode:
// - "cooperative": stays alive; SIGTERM prints a line, writes a final report
//   and exits cleanly.
// - "ignoring": stays alive and swallows SIGTERM and SIGINT, so only SIGKILL
//   ends the process.
// - "exits": exits on its own at once.
const [mode, directory] = process.argv.slice(2);

writeFileSync(
  join(directory, "periodic.json"),
  JSON.stringify({ phase: "periodic" }),
);

if (mode === "exits") process.exit(0);

if (mode === "ignoring") {
  process.on("SIGTERM", () => undefined);
  process.on("SIGINT", () => undefined);
} else {
  process.on("SIGTERM", () => {
    process.stdout.write("finalized\n");
    writeFileSync(
      join(directory, "final.json"),
      JSON.stringify({ phase: "final" }),
    );
    process.exit(0);
  });
}

setInterval(() => undefined, 1_000);
