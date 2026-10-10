import { expect, it } from "vitest";

import { adbInputSchemas } from "./adbDeviceAnalysis.js";

it("preserves ADB key, action and component admission when making advertised patterns portable", () => {
  const serial = "emulator-5554";
  const variants = [
    {
      previous: /^[A-Za-z0-9._-]+$/u,
      max: 256,
      accepts: (key: string) =>
        adbInputSchemas.read_adb_setting.safeParse({
          serial,
          namespace: "global",
          key,
        }).success,
    },
    {
      previous: /^[A-Za-z0-9._-]+$/u,
      max: 256,
      accepts: (key: string) =>
        adbInputSchemas.start_adb_activity.safeParse({
          serial,
          action: "android.intent.action.VIEW",
          extras: [{ key, type: "string", value: "payload" }],
        }).success,
    },
    {
      previous: /^[A-Za-z][A-Za-z0-9._-]*$/u,
      max: 256,
      accepts: (action: string) =>
        adbInputSchemas.start_adb_activity.safeParse({ serial, action })
          .success,
    },
    {
      previous: /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]*)?$/u,
      max: 512,
      accepts: (component: string) =>
        adbInputSchemas.start_adb_activity.safeParse({
          serial,
          action: "android.intent.action.VIEW",
          component,
        }).success,
    },
  ];
  const samples = [
    "",
    "screen_brightness",
    "0",
    "_",
    ".",
    "-",
    "android.intent.action.VIEW",
    "com.example/.MainActivity",
    "com.example/",
    "com.example/a/b",
    "a\n",
    "a\r\n",
    "é",
    "aé",
    "a b",
    "a\\b",
    "a".repeat(256),
    "a".repeat(257),
    "a".repeat(512),
    "a".repeat(513),
  ];
  for (let code = 0; code < 128; code += 1) {
    const character = String.fromCharCode(code);
    samples.push(character, `a${character}`, `a${character}b`);
  }
  for (const variant of variants)
    for (const sample of samples)
      expect(
        variant.accepts(sample),
        JSON.stringify({ pattern: variant.previous.source, sample }),
      ).toBe(
        sample.length > 0 &&
          sample.length <= variant.max &&
          variant.previous.test(sample),
      );
});
