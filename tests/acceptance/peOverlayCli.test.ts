import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { sha256Hex } from "../../src/kernel/sha256Hex.js";
import { peCertificateFixture } from "../../src/native/pe/PeCertificates.fixture.js";
import {
  peOverlayImage,
  ZIP_LOCAL_HEADER,
} from "../../src/native/pe/PeOverlay.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const overlayContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_pe_overlay",
);

cliTest("reports PE overlay ranges through the CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-overlay-cli-");
  const absentPath = join(root, "absent.exe");
  const absentBytes = peOverlayImage();
  await writeFile(absentPath, absentBytes);
  const absent = await cli.run({
    arguments: ["inspect-pe-overlay", absentPath, "--json"],
  });
  expect(absent.exitCode, absent.stderr).toBe(0);
  const absentReport = overlayContract.outputSchema.parse(
    absent.json,
  ).normalized_result;
  expect(absentReport.present).toBe(false);
  expect(absentReport.image_end).toBe(absentBytes.length);
  expect(absentReport.file_size).toBe(absentBytes.length);
  expect(absentReport.ranges).toEqual([]);

  const zipPath = join(root, "zip.exe");
  await writeFile(zipPath, peOverlayImage({ trailing: ZIP_LOCAL_HEADER }));
  const zip = await cli.run({
    arguments: ["inspect-pe-overlay", "zip.exe", "--json"],
    cwd: root,
  });
  expect(zip.exitCode, zip.stderr).toBe(0);
  const zipReport = overlayContract.outputSchema.parse(
    zip.json,
  ).normalized_result;
  expect(zipReport.ranges).toEqual([
    expect.objectContaining({
      role: "other",
      offset: 0x400,
      size: ZIP_LOCAL_HEADER.length,
      sha256: sha256Hex(ZIP_LOCAL_HEADER),
      leading_format: "zip",
    }),
  ]);

  const signed = peCertificateFixture();
  const signedPath = join(root, "signed.exe");
  await writeFile(signedPath, Buffer.concat([signed, ZIP_LOCAL_HEADER]));
  const signedResult = await cli.run({
    arguments: ["inspect-pe-overlay", signedPath, "--json"],
  });
  expect(signedResult.exitCode, signedResult.stderr).toBe(0);
  const signedReport = overlayContract.outputSchema.parse(
    signedResult.json,
  ).normalized_result;
  expect(
    signedReport.ranges.map(({ role, offset, size }) => ({
      role,
      offset,
      size,
    })),
  ).toEqual([
    {
      role: "certificate_table",
      offset: 0x200,
      size: signed.length - 0x200,
    },
    { role: "other", offset: signed.length, size: ZIP_LOCAL_HEADER.length },
  ]);

  const roundedPath = join(root, "rounded.exe");
  await writeFile(
    roundedPath,
    peOverlayImage({
      sections: [{ name: ".text", rawOffset: 0x300, rawSize: 0x100 }],
      trailing: Buffer.alloc(0x20, 0x41),
    }),
  );
  const rounded = await cli.run({
    arguments: ["inspect-pe-overlay", roundedPath, "--json"],
  });
  expect(rounded.exitCode, rounded.stderr).toBe(0);
  const roundedReport = overlayContract.outputSchema.parse(
    rounded.json,
  ).normalized_result;
  expect(roundedReport.sections[0]).toMatchObject({
    pointer_to_raw_data: 0x300,
    rounded_pointer_to_raw_data: 0x200,
    raw_pointer_rounded: true,
  });
  expect(roundedReport.image_end).toBe(0x400);
  expect(roundedReport.ranges).toEqual([
    expect.objectContaining({ role: "other", offset: 0x400, size: 0x20 }),
  ]);

  const pastPath = join(root, "past.exe");
  await writeFile(
    pastPath,
    peOverlayImage({
      fileSize: 0x300,
      sections: [
        { name: ".text", rawOffset: 0x200, rawSize: 0x100 },
        { name: ".data", rawOffset: 0x400, rawSize: 0x100 },
      ],
    }),
  );
  const past = await cli.run({
    arguments: ["inspect-pe-overlay", pastPath, "--json"],
  });
  expect(past.exitCode).toBe(1);
  expect(past.json).toMatchObject({
    code: "unsupported_target",
    details: { operation: "inspect_pe_overlay" },
  });
  expect(JSON.stringify(past.json)).toContain("section index 1");
});

cliTest.for([1, 9])(
  "keeps the full overlay when the security directory declares %i bytes",
  async (size, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-overlay-size-");
    const path = join(root, "archive.exe");
    await writeFile(
      path,
      peOverlayImage({
        trailing: ZIP_LOCAL_HEADER,
        security: { offset: 0x400, size },
      }),
    );

    const overlay = await cli.run({
      arguments: ["inspect-pe-overlay", path, "--json"],
    });
    expect(overlay.exitCode, overlay.stderr).toBe(0);
    const { normalized_result: report } = overlayContract.outputSchema.parse(
      overlay.json,
    );
    expect(report.security_directory).toEqual({
      status: "malformed",
      defect: "invalid-size",
      offset: 0x400,
      size,
    });
    expect(report.ranges).toEqual([
      expect.objectContaining({
        role: "other",
        offset: 0x400,
        size: ZIP_LOCAL_HEADER.length,
        sha256: sha256Hex(ZIP_LOCAL_HEADER),
        leading_format: "zip",
      }),
    ]);
    expect(report.limitations).toContainEqual(
      expect.stringContaining("be a multiple of eight bytes"),
    );

    const certificates = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(certificates.exitCode).toBe(1);
    // The certificate walk names the defect it reaches in the short table.
    expect(certificates.json).toMatchObject({
      code: "unsupported_target",
      details: {
        format: "pe-certificate-table",
        ...(size < 8
          ? {
              failure_kind: "truncated",
              reason: "WIN_CERTIFICATE header is truncated.",
            }
          : {
              failure_kind: "malformed",
              reason: "WIN_CERTIFICATE dwLength exceeds the certificate table.",
            }),
      },
    });
  },
);

cliTest("recognizes a leading XML plist in the overlay", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-overlay-plist-");
  const path = join(root, "preferences.exe");
  const trailing = Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict/></plist>',
    ].join("\n"),
  );
  await writeFile(path, peOverlayImage({ trailing }));
  const overlay = await cli.run({
    arguments: ["inspect-pe-overlay", path, "--json"],
  });
  expect(overlay.exitCode, overlay.stderr).toBe(0);
  const { normalized_result: report } = overlayContract.outputSchema.parse(
    overlay.json,
  );
  expect(report.ranges).toEqual([
    expect.objectContaining({
      role: "other",
      offset: 0x400,
      size: trailing.length,
      leading_format: "plist",
    }),
  ]);
});
