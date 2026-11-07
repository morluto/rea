import { describe, expect, it } from "vitest";

import { withoutRecoveryList } from "./seedRecoveryList.js";

const REGISTRY = ".config/libreoffice/4/user/registrymodifications.xcu";
const KEPT =
  '<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>';
const RECOVERY =
  '<node oor:name="recovery_item_1" oor:op="replace"><prop oor:name="Title" oor:op="fuse"><value>talk.odp</value></prop></node>';

/** A registry holding `body` between its root's tags. */
const registry = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry">\n${body}\n</oor:items>\n`;

const shipped = (text: string) =>
  withoutRecoveryList(REGISTRY, Buffer.from(text))?.toString("utf8");

describe("withoutRecoveryList", () => {
  it("removes each recovery list item however its tags are spelled, and only those bytes", () => {
    const items = [
      `<item oor:path="/org.openoffice.Office.Recovery/RecoveryList">${RECOVERY}</item>`,
      `<item oor:path='/org.openoffice.Office.Recovery/RecoveryList'>${RECOVERY}</item>`,
      `<item\n  oor:path = "/org.openoffice.Office.Recovery/RecoveryList" >${RECOVERY}</item >`,
      '<item xmlns:r="http://openoffice.org/2001/registry" r:path="/org.openoffice.Office.Recovery/RecoveryList"/>',
    ];

    expect(shipped(registry([KEPT, ...items, KEPT].join("\n")))).toBe(
      registry([KEPT, ...items.map(() => ""), KEPT].join("\n")),
    );
  });

  it("keeps the same text inside a comment or CDATA, and a registry without a recovery list", () => {
    const quoted = `<item oor:path="/org.openoffice.Office.Recovery/RecoveryList">${RECOVERY}</item>`;

    expect(
      shipped(
        registry(
          `${KEPT}\n<!-- ${quoted} -->\n<item oor:path="/x"><value><![CDATA[${quoted}]]></value></item>`,
        ),
      ),
    ).toBeUndefined();
    expect(shipped(registry(KEPT))).toBeUndefined();
  });

  it("ships a registry that is not well-formed XML unchanged", () => {
    expect(
      shipped(
        `<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Recovery/RecoveryList">x</item><unclosed></oor:items>`,
      ),
    ).toBeUndefined();
  });
});
