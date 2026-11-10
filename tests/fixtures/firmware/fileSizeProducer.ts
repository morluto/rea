import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { createFirmwareAnalysisProvider } from "../../../src/composition/firmware.js";
import { FirmwareAnalysisService } from "../../../src/application/firmware/FirmwareAnalysisService.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import type { assertFirmwareCleanup } from "./provider.js";
import { createTestTempDirectory } from "../temporaryDirectory.js";

/**
 * Run the production firmware provider and real prlimit with a synthetic
 * Unblob producer that writes one staged file of attemptedBytes. Real Unblob
 * has its own verifier. Python keeps SIGXFSZ ignored, so an over-limit write
 * fails with EFBIG and leaves a truncated file, as the real producer would.
 * The producer asserts the per-file limits it inherits and that the kernel
 * left exactly min(attempted, limit) bytes, then reports what is on disk, so
 * only REA's limit and inventory can expose the truncation. Python is used
 * because Node cannot start under the 1 GiB address-space limit.
 */
export const firmwareFileSizeService = async (limits: {
  attemptedBytes: number;
  probeFileBytes: number;
  extractionFileBytes: number;
}) => {
  const { attemptedBytes, probeFileBytes, extractionFileBytes } = limits;
  const directory = await createTestTempDirectory("rea-firmware-limits-");
  const command = join(directory, "unblob-probe");
  await writeFile(
    command,
    `#!/usr/bin/python3
import errno, hashlib, json, os, resource, sys
if '--version' in sys.argv:
    assert resource.getrlimit(resource.RLIMIT_FSIZE) == (${String(probeFileBytes)}, ${String(probeFileBytes)})
    print('26.6.4')
    sys.exit(0)
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (${String(extractionFileBytes)}, ${String(extractionFileBytes)})
args = sys.argv[1:]
report = args[args.index('--report') + 1]
log = args[args.index('--log') + 1]
source = args[-1]
child = os.path.join(args[args.index('--extract-dir') + 1], 'rootfs', 'config')
with open(source, 'rb') as handle:
    data = handle.read()
os.makedirs(os.path.dirname(child))
with open(child, 'wb', buffering=0) as handle:
    pending = memoryview(b'x' * ${String(attemptedBytes)})
    try:
        while pending:
            pending = pending[handle.write(pending):]
    except OSError as error:
        if error.errno != errno.EFBIG:
            raise
with open(child, 'rb') as handle:
    content = handle.read()
assert len(content) == min(${String(attemptedBytes)}, ${String(extractionFileBytes)})
with open(log, 'w') as handle:
    handle.write('resource fixture log\\n')
def stat(path, size):
    return {'__typename__': 'StatReport', 'path': path, 'size': size, 'is_file': True, 'is_dir': False, 'is_link': False, 'link_target': None}
def task(path, depth, blob_id):
    return {'path': path, 'depth': depth, 'blob_id': blob_id, 'is_multi_file': False}
def digest(value):
    return {'__typename__': 'HashReport', 'sha256': hashlib.sha256(value).hexdigest()}
child_task = task(child, 1, 'gzip-id')
chunk = {'__typename__': 'ChunkReport', 'id': 'gzip-id', 'start_offset': 0, 'end_offset': len(data), 'size': len(data), 'handler_name': 'gzip', 'is_encrypted': False, 'extraction_reports': []}
with open(report, 'w') as handle:
    json.dump([
        {'task': child_task, 'reports': [stat(child, len(content)), digest(content)], 'subtasks': []},
        {'task': task(source, 0, ''), 'reports': [stat(source, len(data)), digest(data), chunk], 'subtasks': [child_task]},
    ], handle)
`,
    { mode: 0o700 },
  );
  const path = join(directory, "input.bin");
  await writeFile(path, "fixture-input-data");
  const launches: Parameters<typeof assertFirmwareCleanup>[0] = [];
  const service = new FirmwareAnalysisService(
    createFirmwareAnalysisProvider(
      { ...process.env, REA_UNBLOB_COMMAND: command },
      async (options) => {
        const spawned = await spawnOwnedProviderProcess(options);
        launches.push({
          cwd: options.cwd,
          pid: spawned.process.pid,
          args: options.arguments,
        });
        return spawned;
      },
    ),
  );
  onTestFinished(() => service.close());
  return { service, path, output: join(directory, "output"), launches };
};
