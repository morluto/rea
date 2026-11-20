import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createAnalysisExecution } from "../ports/AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import {
  findAppBundleResourceRoot,
  resolveAppBundleResourceRoot,
} from "./AppBundleExecutable.js";
import { bindExecutionTarget } from "./binary/BinarySessionExecution.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

const provider = { id: "test", name: "test", version: null } as const;
const target = {
  path: "/Fixture.app/Contents/Info.plist",
  sha256: "a".repeat(64),
  kind: "artifact",
  format: "plist",
} satisfies BinaryTarget;

it("resolves resource roots without requiring or hashing CFBundleExecutable", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rea-app-resource-root-"));
  try {
    const bundle = join(temp, "Fixture.app");
    const contents = join(bundle, "Contents");
    const alias = join(temp, "Selected.app");
    await mkdir(contents, { recursive: true });
    await writeFile(join(contents, "Info.plist"), "<plist><dict/></plist>");
    await symlink(bundle, alias);

    const resolved = await resolveAppBundleResourceRoot(alias);

    expect(resolved).toEqual({
      ok: true,
      value: {
        callerPath: alias,
        canonicalPath: bundle,
        infoPlistPath: join(bundle, "Contents", "Info.plist"),
        layout: "contents",
        executableSha256: null,
      },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "preserves valid symlink-parent traversal when selecting resource roots",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "rea-resource-parent-"));
    try {
      await mkdir(join(temp, "physical", "child"), { recursive: true });
      await mkdir(join(temp, "physical", "Fixture.app"));
      await writeFile(
        join(temp, "physical", "Fixture.app", "Info.plist"),
        "<plist><dict/></plist>",
      );
      await symlink(join(temp, "physical", "child"), join(temp, "alias"));
      const selected = `${temp}/alias/../Fixture.app`;
      const resolved = await resolveAppBundleResourceRoot(selected);
      if (!resolved.ok) throw resolved.error;
      expect(resolved.value.callerPath).toBe(selected);
      expect(resolved.value.canonicalPath).toBe(
        await realpath(join(temp, "physical", "Fixture.app")),
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

it("resolves a flat bundle resource root without inferring executable identity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rea-ios-resource-root-"));
  try {
    const bundle = join(temp, "Fixture.app");
    await mkdir(bundle);
    await writeFile(join(bundle, "Info.plist"), "<plist><dict/></plist>");

    const resolved = await resolveAppBundleResourceRoot(bundle);

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        callerPath: bundle,
        canonicalPath: bundle,
        infoPlistPath: join(bundle, "Info.plist"),
        layout: "root",
        executableSha256: null,
      },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "preserves the actual denied plist classification through resource-only root discovery",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "rea-resource-read-denied-"));
    const bundle = join(temp, "Fixture.app");
    const contents = join(bundle, "Contents");
    await mkdir(contents, { recursive: true });
    const plist = join(contents, "Info.plist");
    await writeFile(plist, "<plist><dict/></plist>");
    try {
      await chmod(contents, 0o600);
      const result = await resolveAppBundleResourceRoot(bundle);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "access_denied",
          details: {
            path: plist,
            system_code: "EACCES",
            boundary: "filesystem-read",
          },
        });
      await chmod(contents, 0o700);
      expect((await resolveAppBundleResourceRoot(bundle)).ok).toBe(true);
      const ordinary = join(temp, "web.app");
      await mkdir(ordinary);
      expect(await findAppBundleResourceRoot(ordinary)).toEqual({
        ok: true,
        value: undefined,
      });
    } finally {
      await chmod(contents, 0o700);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

it("binds the target's selection to a provider subject naming its bytes", () => {
  const flash: BinaryTarget = {
    path: "/fixture/flash.bin",
    sha256: "e".repeat(64),
    kind: "archive",
    format: "esp-flash-image",
    espFlash: {
      selected: true,
      flashOffset: 0x1000,
      partitionTableOffset: 0x8000,
    },
  };
  const selection = {
    kind: "esp-flash",
    flash_offset: 0x1000,
    partition_table_offset: 0x8000,
  };
  const subject = {
    path: flash.path,
    sha256: flash.sha256,
    format: "esp-flash-image" as const,
  };
  const bind = (provided: {
    readonly path: string;
    readonly sha256: string;
    readonly format: "esp-flash-image" | "file";
  }) =>
    bindExecutionTarget(
      {
        ok: true,
        value: createAnalysisExecution({ ok: true }, provider, {
          subject: provided,
        }),
      },
      "inventory_artifact",
      flash,
    );
  const bound = bind(subject);
  expect(bound.ok && bound.value.subject).toEqual({ ...subject, selection });
  // A different root (a member of the image) is not the target itself.
  const member = bind({ ...subject, format: "file" });
  expect(member.ok && member.value.subject).not.toHaveProperty("selection");
});

it("distinguishes default target binding from an explicitly unbound observation", () => {
  const defaultSubject = createAnalysisExecution({ ok: true }, provider);
  const unbound = createAnalysisExecution({ ok: true }, provider, {
    subject: null,
  });

  const bound = bindExecutionTarget(
    { ok: true, value: defaultSubject },
    "inspect_plist",
    target,
  );
  const preserved = bindExecutionTarget(
    { ok: true, value: unbound },
    "inspect_plist",
    target,
  );

  expect(bound.ok && bound.value.subject).toEqual({
    path: target.path,
    sha256: target.sha256,
    format: "plist",
  });
  expect(preserved.ok && preserved.value.subject).toBeNull();
  expect(
    createAnalysisExecutionEvidence("inspect_plist", {}, unbound, "observed")
      .subject.identity.kind,
  ).toBe("unknown");
});
