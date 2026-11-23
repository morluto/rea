import { expect, it } from "vitest";

import { readMachoImage } from "../../domain/apple/machoLoadCommandReader.js";
import {
  buildVersionCommand,
  machoImage,
  readerOf,
} from "../../artifacts/apple/MachoImage.fixture.js";

// LC_BUILD_VERSION platform numbers: 1 is macOS, 6 is macCatalyst.
it("marks a conflicting build platform instead of reporting none was observed", async () => {
  const image = machoImage({
    commands: [buildVersionCommand(1), buildVersionCommand(6)],
  });
  const facts = await readMachoImage(readerOf(image), image.length);
  if (facts.status !== "parsed") throw new Error("Expected a parsed image");
  expect(facts.slices[0]).toMatchObject({
    platform: null,
    platforms: [1, 6],
    platform_conflict: true,
  });
});

it("keeps a single declared platform free of the conflict marker", async () => {
  const image = machoImage({ commands: [buildVersionCommand(1)] });
  const facts = await readMachoImage(readerOf(image), image.length);
  if (facts.status !== "parsed") throw new Error("Expected a parsed image");
  expect(facts.slices[0]).toMatchObject({ platform: 1, platforms: [1] });
  expect(facts.slices[0]?.platform_conflict).not.toBe(true);
});

it("leaves an image without a build-version command conflict-free", async () => {
  const image = machoImage({ commands: [] });
  const facts = await readMachoImage(readerOf(image), image.length);
  if (facts.status !== "parsed") throw new Error("Expected a parsed image");
  expect(facts.slices[0]).toMatchObject({ platform: null, platforms: [] });
  expect(facts.slices[0]?.platform_conflict).not.toBe(true);
});
