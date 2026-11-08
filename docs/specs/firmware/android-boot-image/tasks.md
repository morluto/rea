# Tasks

Requirement numbers refer to [spec.md](spec.md). Verification names the test
that covers the step.

- [x] Record this specification, [plan](plan.md), and task list for the
      Android boot image reader. (Requirements 1-10)
- [x] Decode `ANDROID!` versions 0-4 and `VNDRBOOT` versions 3-4 in the domain
      parser, including safe integer ranges, packed `os_version`, UTF-8
      failure, vendor ramdisk names, and tagged parse errors.
      (Requirements 1-5, 7-8; `src/domain/androidBootImageFormat.test.ts`)
- [x] Map non-empty components to children, record compression from the
      leading magic, stream member bytes, and enforce probe and table caps
      before the table read. (Requirements 6 and 8;
      `src/artifacts/AndroidBootImageArtifactReader.test.ts`)
- [x] Register metadata schemas and the reader on the uImage inventory,
      extraction, and target-resolution path. (Requirement 9;
      `src/artifacts/artifactFormats.test.ts`,
      `src/application/binary/TargetFormatVocabularies.test.ts`)
- [x] Preserve untrusted-string and unknown-role limitations through CLI and
      MCP Evidence. (Requirements 5 and 9;
      `tests/acceptance/androidBootImageCli.test.ts`,
      `tests/boundary/mcp/androidBootImageMcp.test.ts`)
- [x] Cover close retry, cancellation during admission and paused inventory,
      cancel with buffered bytes, source change after prepare, and multi-chunk
      cancel. (Requirement 10;
      `src/artifacts/AndroidBootImageArtifactReader.boundaries.test.ts`)
- [x] Describe current behavior and the capacity bounds in
      `docs/android-boot-image.md`, and link that guide from the documentation
      directory, CLI guide, and firmware guide. (Acceptance)
