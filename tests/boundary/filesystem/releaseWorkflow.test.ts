import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

// Publishing is irreversible. Keep the release authority invariant as a static
// boundary check; it is not proof that package installation or publishing works.
it("requires package verification before publishing and retains the registry canary", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        publish: z.object({
          steps: z.array(z.object({ run: z.string().optional() })),
        }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/release.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
  const commands = workflow.jobs.publish.steps.map(({ run }) => run ?? "");
  const verify = commands.findIndex((command) =>
    command.includes("npm run verify:package"),
  );
  const publish = commands.findIndex((command) =>
    command.includes("npm publish"),
  );
  expect(verify).toBeGreaterThanOrEqual(0);
  expect(publish).toBeGreaterThan(verify);
  expect(
    commands
      .slice(publish + 1)
      .some((command) => command.includes("verify-published-package.mjs")),
  ).toBe(true);
});
