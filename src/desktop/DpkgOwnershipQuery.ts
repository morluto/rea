import { parseDpkgOwners } from "../domain/desktop/linuxPackages.js";
import type { QueryRunner } from "./HostQuery.js";

/** dpkg may return owner rows and exit 1 when only some requested paths match. */
export const queryDpkgOwnership = async (
  runQuery: QueryRunner,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<
  | {
      readonly kind: "read";
      readonly owners: ReadonlyMap<string, readonly string[]>;
      readonly complete: boolean;
    }
  | { readonly kind: "missing" | "failed" | "unavailable" }
> => {
  const outcome = await runQuery("dpkg-query", ["-S", ...paths], signal, {
    preserveStdoutBytes: true,
    locale: "C.UTF-8",
  });
  if (typeof outcome === "string") return { kind: outcome };
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1)
    return { kind: "unavailable" };
  return {
    kind: "read",
    ...parseDpkgOwners(outcome.stdoutBuffer ?? outcome.stdout, paths),
  };
};
