import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createVerifierHttpServer } from "../../../scripts/lib/verifier-http-server.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { executeWorkflowFixture } from "../../support/workflowGit.js";

const upstream =
  "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz";
const digest =
  "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5";

async function fixture(
  outcome: "recover" | "reset" | "not-found" | "bad-digest",
) {
  const directory = await createTestTempDirectory("rea-native-download-");
  const archivePath = join(directory, "fixture.tar.gz");
  await writeFile(join(directory, "mitmdump"), "fixture native profile\n");
  await executeWorkflowFixture("tar", [
    "-czf",
    archivePath,
    "-C",
    directory,
    "mitmdump",
  ]);
  const archive = await readFile(archivePath);
  let requests = 0;
  const { server, close } = createVerifierHttpServer(
    async (request, response) => {
      requests++;
      if (outcome === "not-found") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Length": archive.length });
      if (outcome === "reset" || (outcome === "recover" && requests === 1)) {
        response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        // Deliver a partial body, then a real TCP reset (curl 56), not an HTTP error.
        await delay(25);
        request.socket.resetAndDestroy();
        return;
      }
      response.end(archive);
    },
  );
  onTestFinished(close);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP fixture listener");

  const workflow = z
    .object({
      jobs: z.object({
        "real-web-network-captures": z.object({
          steps: z.array(
            z.object({
              name: z.string().optional(),
              run: z.string().optional(),
            }),
          ),
        }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL(
            "../../../.github/workflows/real-web-network-captures.yml",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  const acquisition = workflow.jobs["real-web-network-captures"].steps.filter(
    (step) =>
      step.name ===
      "Acquire fixed upstream native profile in runner temporary storage",
  );
  expect(acquisition).toHaveLength(1);
  const source = z.string().parse(acquisition[0]?.run);
  expect(source).toContain(upstream);
  expect(source).toContain(digest);
  // Execute the actual step with only its immutable input replaced by a tiny local archive.
  const script = source
    .replace(upstream, `http://127.0.0.1:${address.port}/profile.tar.gz`)
    .replace(
      digest,
      outcome === "bad-digest"
        ? "0".repeat(64)
        : createHash("sha256").update(archive).digest("hex"),
    );
  const environment = join(directory, "github-env");
  await writeFile(environment, "");
  return {
    get requests() {
      return requests;
    },
    environment,
    profile: join(directory, "rea-mitmproxy-12.2.3/mitmdump"),
    run: () =>
      executeWorkflowFixture(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../../scripts/run-exclusive.mjs", import.meta.url),
          ),
          "--unlocked",
          "bash",
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          script,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            RUNNER_TEMP: directory,
            GITHUB_ENV: environment,
            CURL_HOME: directory,
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
          },
          timeout: 25_000,
        },
      ),
  };
}

// This workflow runs on Ubuntu and requires these native tools; other hosts do not claim coverage.
describe.runIf(process.platform === "linux")(
  "native profile acquisition",
  () => {
    it("restarts a reset partial transfer, verifies the full archive and exports the extracted profile", async () => {
      const download = await fixture("recover");
      const result = await download.run();
      expect(result.stderr).toContain("curl: (56)");
      expect(download.requests).toBe(2);
      expect(await readFile(download.profile, "utf8")).toBe(
        "fixture native profile\n",
      );
      expect(await readFile(download.environment, "utf8")).toBe(
        `REA_MITMDUMP_COMMAND=${download.profile}\n`,
      );
    });

    it.each([
      ["reset", 56, 4],
      ["not-found", 22, 4],
      ["bad-digest", 1, 1],
    ] as const)(
      "fails closed after %s without exporting a profile",
      async (outcome, code, attempts) => {
        const download = await fixture(outcome);
        await expect(download.run()).rejects.toMatchObject({ code });
        expect(download.requests).toBe(attempts);
        await expect(readFile(download.profile)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(download.environment, "utf8")).toBe("");
      },
    );
  },
);
