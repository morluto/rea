import { execFileSync } from "node:child_process";

// Real-provider Rizin gates skip when no Rizin is on PATH. A lane that installs
// Rizin sets REA_REQUIRE_RIZIN to the version it installed, such as 0.9.1.
// Then a missing Rizin, or another version first on PATH, fails the gate
// instead of letting it pass as a skip.
export function assertRequiredRizin(
  gate: string,
  binary: string | undefined,
): void {
  const required = process.env.REA_REQUIRE_RIZIN;
  if (required === undefined || required === "") return;
  if (!/^\d+\.\d+\.\d+$/u.test(required))
    throw new Error(
      `REA_REQUIRE_RIZIN must be a Rizin version such as 0.9.1, not ${JSON.stringify(required)}`,
    );
  if (binary === undefined)
    throw new Error(
      `${gate} requires Rizin ${required} (REA_REQUIRE_RIZIN), but no rizin is on PATH`,
    );
  let banner: string;
  try {
    banner =
      execFileSync(binary, ["-v"], { encoding: "utf8" }).split("\n")[0] ?? "";
  } catch (error) {
    throw new Error(
      `${gate} requires Rizin ${required} (REA_REQUIRE_RIZIN), but ${binary} -v failed`,
      { cause: error },
    );
  }
  const version = /^rizin (\d+\.\d+\.\d+)\b/u.exec(banner.trim())?.[1];
  if (version !== required)
    throw new Error(
      `${gate} requires Rizin ${required} (REA_REQUIRE_RIZIN), but ${binary} reports ${JSON.stringify(banner.trim())}`,
    );
}
