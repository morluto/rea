import { expect, it } from "vitest";

import { parseDistributionXml, parsePackageInfoXml } from "./InstallerXml.js";

const distribution = (installKBytes: string): Buffer =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
  <pkg-ref id="com.rea.fixture" version="1.0.0" installKBytes="${installKBytes}">#A.pkg</pkg-ref>
</installer-gui-script>`,
    "utf8",
  );

const installKBytesOf = (installKBytes: string): number | null => {
  const parsed = parseDistributionXml(distribution(installKBytes));
  if (!parsed.ok) throw new Error("Distribution fixture did not parse");
  return parsed.value.pkgRefs[0]?.installKBytes ?? null;
};

it("keeps installKBytes up to the uint32 maximum", () => {
  expect(installKBytesOf("0")).toBe(0);
  expect(installKBytesOf("4294967295")).toBe(4_294_967_295);
});

it("reports installKBytes past uint32 as unknown", () => {
  expect(installKBytesOf("4294967296")).toBeNull();
  expect(installKBytesOf("9007199254740993")).toBeNull();
  expect(installKBytesOf("-1")).toBeNull();
});

it("counts check script length in UTF-8 bytes", () => {
  const parsed = parseDistributionXml(
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
  <installation-check script="check()"><script>"é✓"</script></installation-check>
  <volume-check>"日本"</volume-check>
</installer-gui-script>`,
      "utf8",
    ),
  );
  if (!parsed.ok) throw new Error("Distribution fixture did not parse");
  expect(parsed.value.installationCheckScriptBytes).toBe(7);
  expect(parsed.value.volumeCheckScriptBytes).toBe(8);
});

it("refuses installer XML with an unrelated root element", () => {
  const junk = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<junk/>`,
    "utf8",
  );
  const distribution = parseDistributionXml(junk);
  expect(distribution.ok).toBe(false);
  if (!distribution.ok)
    expect(distribution.error.failure.detail).toContain("installer-gui-script");
  const packageInfo = parsePackageInfoXml(junk);
  expect(packageInfo.ok).toBe(false);
  if (!packageInfo.ok)
    expect(packageInfo.error.failure.detail).toContain("pkg-info");
});
