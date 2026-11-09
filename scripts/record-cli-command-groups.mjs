import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Record which command group registers each top-level CLI command, after
// compilation and before bundling, so the executable imports one group.
const compiled = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const { recordCliCommandGroups } = await import(
  pathToFileURL(join(compiled, "cli.js")).href
);
// Registration is independent of the host account and user configuration.
const home = await mkdtemp(join(tmpdir(), "rea-cli-command-groups-"));
let groups;
try {
  groups = await recordCliCommandGroups({
    REA_LOG_LEVEL: "silent",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  });
} finally {
  await rm(home, { recursive: true, force: true });
}
const sorted = Object.fromEntries(
  Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)),
);
await writeFile(
  join(compiled, "recordedCliCommandGroups.js"),
  `/** Recorded from the compiled runtime; do not edit. */\nexport const RECORDED_CLI_COMMAND_GROUPS = Object.freeze(${JSON.stringify(sorted)});\n`,
);
