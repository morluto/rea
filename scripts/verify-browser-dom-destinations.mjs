#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startBrowserVerifierSite } from "./fixtures/browser-verifier-site.mjs";
import { verifyBrowserDomDestinations } from "./lib/browser-dom-destinations-e2e.mjs";

const executable = process.env.REA_BROWSER_EXECUTABLE;
if (!executable)
  throw new Error("verify:browser:dom requires REA_BROWSER_EXECUTABLE");
const profile = await mkdtemp(join(tmpdir(), "rea-browser-dom-"));
const site = await startBrowserVerifierSite();
let context;
let report;
try {
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
  const session = await context.newCDPSession(page);
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
} finally {
  await context?.close();
  await site.close();
  await rm(profile, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
