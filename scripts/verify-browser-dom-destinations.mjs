#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ArtifactResourceScope } from "../dist/resources/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../dist/resources/AnalysisCleanupLease.js";
import { newPlaywrightCdpSession } from "../dist/browser/PlaywrightCdpSession.js";
import { startBrowserVerifierSite } from "./fixtures/browser-verifier-site.mjs";
import { verifyBrowserDomDestinations } from "./lib/browser-dom-destinations-e2e.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { requireOrdinaryWindowsVerifierCaller } from "./lib/windows-ordinary-user-verifier.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";

const executable = process.env.REA_BROWSER_EXECUTABLE;
if (!executable)
  throw new Error("verify:browser:dom requires REA_BROWSER_EXECUTABLE");
await requireOrdinaryWindowsVerifierCaller();
let profileFixture;
let profile;
let site;
let context;
let report;
const browserResources = new ArtifactResourceScope();
await withVerifierCleanup(async () => {
  profileFixture = await VerifierFixture.open({
    prefix: "rea-browser-dom-",
    private: false,
  });
  profile = profileFixture.path;
  browserResources.retain({
    kind: "lease",
    resource: profile,
    lease: AnalysisCleanupLease.forCloseOwner(
      {
        close: async () => {
          // The browser owns files in this profile until shutdown is confirmed.
          await context?.close();
          context = undefined;
          await profileFixture.release();
        },
      },
      profile,
    ),
  });
  site = await startBrowserVerifierSite();
  context = await chromium.launchPersistentContext(profile, {
    executablePath: executable,
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${site.origin}/app?selected=fixture#section`);
  const native = await page.evaluate(() =>
    [
      ...document.querySelectorAll("form,button[formaction],input[formaction]"),
    ].map((element) =>
      element.tagName === "FORM" ? element.action : element.formAction,
    ),
  );
  assert.deepEqual(native, Array(4).fill(page.url()));
  const session = await newPlaywrightCdpSession(
    context,
    page,
    "inspect_web_page",
  );
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  const [port] = (
    await readFile(join(profile, "DevToolsActivePort"), "utf8")
  ).split("\n");
  const result = await verifyBrowserDomDestinations(
    {
      cdp_endpoint: `http://127.0.0.1:${port}`,
      target_id: targetInfo.targetId,
    },
    process.argv[2],
    page.url(),
  );
  report = {
    ...result,
    browser: context.browser().version(),
    native_oracle: true,
    verified: true,
  };
}, [() => browserResources.close(), () => site?.close()]);
process.stdout.write(`${JSON.stringify(report)}\n`);
