import { afterEach } from "vitest";

import type { FakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

const browsers: FakeCdpBrowser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

export const trackBrowser = (browser: FakeCdpBrowser): void => {
  browsers.push(browser);
};
