import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Isolate every registration writer before the official Node entrypoint imports it. */
export const registrationEnvironment = async (
  home: string,
  additional: NodeJS.ProcessEnv = {},
): Promise<NodeJS.ProcessEnv> => {
  await mkdir(home, { recursive: true });
  const guard = join(home, "registration-environment.mjs");
  await writeFile(
    guard,
    `import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
const home = process.env.HOME;
if (!home || await realpath(home) !== await realpath(homedir()))
  throw Error('Registration fixture HOME was not selected before imports.');
for (const key of ['USERPROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','APPDATA','LOCALAPPDATA']) {
  const path = relative(home, process.env[key] ?? '');
  if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
    throw Error('Registration fixture location escapes HOME: ' + key);
}
`,
    { mode: 0o600 },
  );
  const bin = join(home, "registration-bin");
  const witness = join(bin, "unexpected-acquisition.cjs");
  const log = join(home, "unexpected-acquisition.log");
  await mkdir(bin, { recursive: true });
  await writeFile(log, "");
  await writeFile(
    witness,
    `require('node:fs').appendFileSync(process.env.REA_TEST_REGISTRATION_ACQUISITION_LOG, 'unexpected acquisition\\n'); process.exit(79);\n`,
  );
  for (const name of ["npx", "pnpx", "bunx"]) {
    await writeFile(
      join(bin, process.platform === "win32" ? `${name}.cmd` : name),
      process.platform === "win32"
        ? `@"${process.execPath}" "${witness}"\r\n`
        : `#!${process.execPath}\nrequire(${JSON.stringify(witness)});\n`,
      { mode: 0o700 },
    );
  }
  return {
    ...additional,
    PATH: additional.PATH ?? [bin, process.env.PATH ?? ""].join(delimiter),
    REA_TEST_REGISTRATION_ACQUISITION_LOG: log,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    // A file URL encodes spaces; Node reads this one --import option directly.
    NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
  };
};
