// Boundary/oracle tests. These simulated native replies do not establish r2 behavior.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { RegularFileCleanupFailure } from "../../dist/filesystem/OwnedRegularFile.js";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { observationError } from "./observation-error.mjs";
import {
  byteInputSchema,
  digestTarget,
  MAX_NATIVE_READ_BYTES,
  readNativeBytes,
  retryNativeByteCleanup,
} from "./native-bytes.mjs";

const folder = await mkdtemp(join(tmpdir(), "rea-native-byte-oracle-"));
const path = join(folder, "selected bytes.bin");
const fixture = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
await writeFile(path, fixture);
const sha256 = createHash("sha256").update(fixture).digest("hex");
const input = { address: "0x20000000000001", length: 4 };
const section = {
  name: "data",
  vaddr: "0x20000000000000",
  paddr: "1",
  size: "6",
  vsize: "16",
};
const target = {
  path,
  sha256_before: sha256,
  sha256_after: sha256,
  core_binding: "owned-process-opened-selected-path",
};
const native = (
  sections = [section],
  bytes = ["48", "64", "80", "96"],
  identity = target,
) => ({
  ok: true,
  value: {
    target: identity,
    raw: {
      sections,
      bytes,
      original_output: "retained producer representation",
    },
    replies: [sections, bytes].map((res) => ({
      command_outcome: "no_error_reported",
      res,
    })),
  },
});
const requireValue = (result) => {
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  return result.value;
};

after(async () => {
  assert.equal(await retryNativeByteCleanup(), 0);
  await rm(folder, { recursive: true, force: true });
});

void test("wide virtual coordinates and quoted bytes verify against a real file handle", async () => {
  const source = native();
  const observed = requireValue(
    await readNativeBytes(
      input,
      async (commands) => {
        assert.deepEqual(commands, [
          { cmd: "iSj", json: true },
          { cmd: "p8j 4 @ 0x20000000000001", json: true },
        ]);
        return source;
      },
      path,
    ),
  );
  assert.equal(observed.result.bytes_hex, "30405060");
  assert.equal(observed.result.complete, true);
  assert.equal(observed.result.coverage.initialized_mapping.file_offset, "0x2");
  assert.equal(observed.result.coverage.file_verification.sha256, sha256);
  assert.equal(observed.raw, source.value.raw);
});

void test("full padded counts, virtual tails and ambiguous mappings never prove completeness", async () => {
  for (const sections of [
    [],
    [{ ...section, size: 1 }],
    [section, { ...section, vaddr: input.address, size: 1 }],
    [section, { ...section, paddr: "18446744073709551615" }],
    [section, { ...section, vaddr: 9_007_199_254_740_992 }],
  ]) {
    const value = requireValue(
      await readNativeBytes(input, async () => native(sections), path),
    );
    assert.equal(value.result.returned_bytes, 4);
    assert.equal(value.result.complete, null);
    assert.ok(value.result.unknowns.length);
  }
  const external = requireValue(
    await readNativeBytes(
      input,
      async () =>
        native([section], undefined, {
          ...target,
          core_binding: "unverified-external-core",
        }),
      path,
    ),
  );
  assert.equal(external.result.complete, null);
});

void test("overlay differences and stale reader digests preserve both native and file observations", async () => {
  const overlay = requireValue(
    await readNativeBytes(
      input,
      async () => native([section], [0, 0, 0, 0]),
      path,
    ),
  );
  assert.equal(overlay.result.bytes_hex, "00000000");
  assert.equal(overlay.result.complete, null);
  assert.equal(overlay.result.coverage.file_verification.bytes_hex, "30405060");
  assert.equal(
    overlay.result.coverage.file_verification.native_bytes_match,
    false,
  );
  const stale = requireValue(
    await readNativeBytes(
      input,
      async () =>
        native([section], undefined, {
          ...target,
          sha256_before: "0".repeat(64),
          sha256_after: "0".repeat(64),
        }),
      path,
    ),
  );
  assert.equal(stale.result.complete, null);
  assert.equal(
    stale.result.coverage.file_verification.reader_digest_matches,
    false,
  );
});

void test("malformed byte arrays fail with the observed payload intact", async () => {
  const hole = [48, 64, 80, 96];
  delete hole[2];
  for (const bytes of [[256], ["1.5"], [null], hole, [1, 2, 3, 4, 5]]) {
    const source = native([section], bytes);
    const result = await readNativeBytes(input, async () => source, path);
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisOutputError");
    assert.equal(result.error.partialObservation.raw, source.value.raw);
  }
});

void test("cancellation is a Result and preserves bytes observed before independent verification", async () => {
  const early = new AbortController();
  early.abort();
  let calls = 0;
  const cancelled = await readNativeBytes(
    input,
    async () => {
      calls++;
      return native();
    },
    path,
    { signal: early.signal },
  );
  assert.equal(cancelled.error._tag, "AnalysisCancelledError");
  assert.equal(calls, 0);
  const during = new AbortController();
  const partial = await readNativeBytes(
    input,
    async () => {
      during.abort();
      return native();
    },
    path,
    { signal: during.signal },
  );
  assert.equal(partial.error._tag, "AnalysisCancelledError");
  assert.equal(partial.error.partialObservation.result.bytes_hex, "30405060");
});

void test("cancellation during final file close preserves observed bytes and the caller reason", async (context) => {
  const controller = new AbortController();
  const reason = new Error("Caller cancelled during final file close");
  const originalOpen = fs.open;
  let closed = false;
  const intercepted = context.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      closed = true;
      controller.abort(reason);
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const source = native();
    const result = await readNativeBytes(input, async () => source, path, {
      signal: controller.signal,
    });
    assert.equal(closed, true);
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisCancelledError");
    assert.equal(result.error.cause, reason);
    assert.equal(result.error.partialObservation.raw, source.value.raw);
    assert.equal(result.error.partialObservation.result.bytes_hex, "30405060");
    assert.equal(result.error.partialObservation.result.complete, null);
    assert.equal(
      result.error.partialObservation.producer_observation.completed.status,
      "matched",
    );
    assert.equal(await retryNativeByteCleanup(), 0);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
});

void test("failed file cleanup preserves completed verification or primary failure, blocks admission and retries", async (context) => {
  for (const failRead of [false, true]) {
    const originalOpen = fs.open;
    const primary = new Error("Independent read failed before close");
    let denied = true;
    let admissions = 0;
    let originalError;
    let blockedError;
    const intercepted = context.mock.method(fs, "open", async (...args) => {
      admissions++;
      const handle = await originalOpen(...args);
      const close = handle.close.bind(handle);
      if (failRead)
        handle.read = async () => {
          throw primary;
        };
      handle.close = async () => {
        if (denied) throw new Error("Injected close denial");
        return close();
      };
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const source = native();
      const result = await readNativeBytes(input, async () => source, path);
      assert.equal(result.ok, false);
      assert.equal(result.error._tag, "AnalysisOutputError");
      assert.equal(result.error.cleanupIncomplete, true);
      originalError = result.error;
      assert.equal(result.error.partialObservation.raw, source.value.raw);
      const projected = projectAnalysisError(result.error);
      const file = projected.details.partial_observation.producer_observation;
      if (failRead) {
        assert.equal(file.primary_failure, primary.message);
        assert.equal(result.error.cause.cause.outcome.cause, primary);
      } else assert.equal(file.completed.status, "matched");
      const blocked = await readNativeBytes(input, async () => native(), path);
      blockedError = blocked.error;
      assert.equal(blocked.error.cleanupIncomplete, true);
      assert.equal(admissions, 1);
      assert.equal(await retryNativeByteCleanup(), 1);
      assert.equal(originalError.cleanupIncomplete, true);
      assert.equal(blockedError.cleanupIncomplete, true);
    } finally {
      denied = false;
      assert.equal(await retryNativeByteCleanup(), 0);
      intercepted.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(originalError.cleanupIncomplete, false);
    assert.equal(blockedError.cleanupIncomplete, false);
    assert.deepEqual(originalError.cleanupResources, []);
    assert.deepEqual(blockedError.cleanupResources, []);
    const recovered = requireValue(
      await readNativeBytes(input, async () => native(), path),
    );
    assert.equal(recovered.result.complete, true);
  }
});

void test("cancelled reads and hashes retain their reason and failed-close lease through retry", async (context) => {
  for (const operation of ["bytes", "digest"]) {
    for (const stage of ["read", "close"]) {
      const controller = new AbortController();
      const reason = { operation, stage };
      const originalOpen = fs.open;
      let denied = true;
      let failure;
      const intercepted = context.mock.method(fs, "open", async (...args) => {
        const handle = await originalOpen(...args);
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        handle.read = async (...readArgs) => {
          const value = await read(...readArgs);
          if (stage === "read") controller.abort(reason);
          return value;
        };
        handle.close = async () => {
          if (stage === "close") controller.abort(reason);
          if (denied) throw new Error("Injected close denial");
          return close();
        };
        return handle;
      });
      syncBuiltinESMExports();
      try {
        if (operation === "digest") {
          await assert.rejects(
            digestTarget(path, controller.signal),
            (cause) => {
              failure = cause;
              return true;
            },
          );
        } else {
          const result = await readNativeBytes(
            input,
            async () => native(),
            path,
            {
              signal: controller.signal,
            },
          );
          assert.equal(result.ok, false);
          failure = result.error;
          assert.equal(failure.partialObservation.result.bytes_hex, "30405060");
        }
        assert.equal(failure._tag, "AnalysisCancelledError");
        assert.equal(failure.cause, reason);
        assert.equal(failure.cleanupIncomplete, true);
        assert.equal(await retryNativeByteCleanup(), 1);
      } finally {
        denied = false;
        assert.equal(await retryNativeByteCleanup(), 0);
        intercepted.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(failure.cleanupIncomplete, false);
      assert.equal(projectAnalysisError(failure).code, "cancelled");
      assert.equal(failure.cause, reason);
    }
  }
});

void test("an opaque cleanup-shaped abort reason during a file read never transfers an unrelated owner", async (context) => {
  let unrelatedCloses = 0;
  const reason = new RegularFileCleanupFailure({
    path: "/unrelated-owner",
    owner: {
      close: async () => {
        unrelatedCloses++;
      },
    },
    outcome: { kind: "completed", value: "unrelated" },
    cleanupCause: new Error("Opaque caller reason"),
  });
  const controller = new AbortController();
  const originalOpen = fs.open;
  const intercepted = context.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      controller.abort(reason);
      return result;
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const result = await readNativeBytes(input, async () => native(), path, {
      signal: controller.signal,
    });
    assert.equal(result.error._tag, "AnalysisCancelledError");
    assert.equal(result.error.cause, reason);
    assert.equal(result.error.cleanupIncomplete, false);
    assert.equal(await retryNativeByteCleanup(), 0);
    assert.equal(unrelatedCloses, 0);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
});

void test("target digests reject append and same-size writes during the descriptor read", async (context) => {
  const selected = join(folder, "changing-target");
  for (const mutation of ["append", "overwrite"]) {
    await writeFile(selected, fixture);
    const originalOpen = fs.open;
    let changed = false;
    const intercepted = context.mock.method(fs, "open", async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          if (mutation === "append") await fs.appendFile(selected, "new bytes");
          else await writeFile(selected, Buffer.alloc(fixture.length));
        }
        return result;
      };
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(digestTarget(selected), (cause) => {
        assert.equal(cause._tag, "AnalysisArtifactChangedError");
        assert.equal(cause.path, selected);
        assert.equal(projectAnalysisError(cause).code, "artifact_changed");
        return true;
      });
      assert.equal(changed, true);
      assert.equal(await retryNativeByteCleanup(), 0);
    } finally {
      intercepted.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(
      await digestTarget(selected),
      createHash("sha256")
        .update(await fs.readFile(selected))
        .digest("hex"),
    );
  }
});

void test("a changed target stays the primary error across failed close and consumer cleanup retry", async (context) => {
  const selected = join(folder, "changed-with-pending-close");
  await writeFile(selected, fixture);
  const originalOpen = fs.open;
  let denied = true;
  let changed = false;
  let failure;
  let composed;
  const intercepted = context.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.read = async (...readArgs) => {
      const value = await read(...readArgs);
      if (!changed) {
        changed = true;
        await fs.appendFile(selected, "changed");
      }
      return value;
    };
    handle.close = async () => {
      if (denied) throw new Error("Injected close denial");
      return close();
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(digestTarget(selected), (cause) => {
      failure = cause;
      return true;
    });
    assert.equal(failure.cleanupPrimary._tag, "AnalysisArtifactChangedError");
    assert.equal(failure.cleanupPrimary.path, selected);
    composed = observationError(failure, "consumer", "Digest failed", {
      selected,
    });
    for (const value of [failure, composed]) {
      assert.equal(projectAnalysisError(value).code, "cleanup_incomplete");
      assert.equal(value.cleanupIncomplete, true);
      assert.deepEqual(value.cleanupResources, [selected]);
    }
    assert.equal(await retryNativeByteCleanup(), 1);
  } finally {
    denied = false;
    assert.equal(await retryNativeByteCleanup(), 0);
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
  for (const value of [failure, composed]) {
    const projection = projectAnalysisError(value);
    assert.equal(value.cleanupIncomplete, false);
    assert.equal(projection.code, "artifact_changed");
    assert.equal(projection.retryable, true);
    assert.equal(projection.details.path, selected);
  }
});

void test("the capture-derived length bound and uint64 extent reject before reading", async () => {
  assert.equal(MAX_NATIVE_READ_BYTES, 1024 * 1024);
  assert.equal(
    byteInputSchema.safeParse({ address: "0x0", length: MAX_NATIVE_READ_BYTES })
      .success,
    true,
  );
  for (const value of [
    { address: "0x0", length: MAX_NATIVE_READ_BYTES + 1 },
    { address: "0xffffffffffffffff", length: 2 },
  ]) {
    let called = false;
    const result = await readNativeBytes(value, async () => {
      called = true;
      return native();
    });
    assert.equal(result.error._tag, "AnalysisInputError");
    assert.equal(called, false);
  }
});
