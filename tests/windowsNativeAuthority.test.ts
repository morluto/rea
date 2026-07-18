import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  WindowsNativeAuthority,
  WindowsNativeAuthorityError,
  unavailableWindowsNativeAuthorityBackend,
  type WindowsNativeAuthorityBackend,
  type WindowsNativeBackendProcess,
  type WindowsNativeBackendResource,
  type WindowsNativeOperationControl,
  type WindowsOwnedProcessSnapshot,
} from "../src/application/WindowsNativeAuthority.js";
import { err, ok } from "../src/domain/result.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const identity = {
  packageName: "@rea/windows-x64",
  packageVersion: "1.0.0",
  contractVersion: 1,
  nodeApiVersion: 9,
  artifactSha256: "a".repeat(64),
};

const pathIdentity = (requestedPath: string, fileIdentity: string) => ({
  requestedPath,
  finalPath: requestedPath,
  filesystem: "ntfs" as const,
  volumeIdentity: "0123456789abcdef",
  fileIdentity,
  reparseDisposition: "absent" as const,
});

const privateDacl = (input: {
  readonly objectKind: "directory" | "file";
  readonly protection: "protected" | "inherited_from_protected_parent";
  readonly aceDisposition: "explicit" | "inherited";
  readonly propagation: "none" | "container_and_object";
  readonly currentUserRights: "read_execute" | "modify";
  readonly verifiedObjectCount: number;
  readonly digestByte: string;
}) => ({
  objectKind: input.objectKind,
  owner: "current_user" as const,
  dacl: "present" as const,
  protection: input.protection,
  aceDisposition: input.aceDisposition,
  propagation: input.propagation,
  additionalTrustees: "absent" as const,
  broadAllowEntries: "absent" as const,
  currentUserRights: input.currentUserRights,
  systemRights: "full_control" as const,
  ownerRights: "write_dac_write_owner_denied" as const,
  descriptorSha256: input.digestByte.repeat(64),
  verifiedObjectCount: input.verifiedObjectCount,
  policyManifestSha256: input.digestByte.repeat(64),
});

const privateRootObservation = (canonicalPath: string) => {
  const manifestSha256 = "c".repeat(64);
  const launchSha256 = "e".repeat(64);
  const policies = {
    rootDirectory: privateDacl({
      objectKind: "directory",
      protection: "protected",
      aceDisposition: "explicit",
      propagation: "none",
      currentUserRights: "read_execute",
      verifiedObjectCount: 1,
      digestByte: "1",
    }),
    readonlyDirectories: privateDacl({
      objectKind: "directory",
      protection: "protected",
      aceDisposition: "explicit",
      propagation: "container_and_object",
      currentUserRights: "read_execute",
      verifiedObjectCount: 20,
      digestByte: "2",
    }),
    readonlyFiles: privateDacl({
      objectKind: "file",
      protection: "protected",
      aceDisposition: "explicit",
      propagation: "none",
      currentUserRights: "read_execute",
      verifiedObjectCount: 100,
      digestByte: "3",
    }),
    writableDirectories: privateDacl({
      objectKind: "directory",
      protection: "protected",
      aceDisposition: "explicit",
      propagation: "container_and_object",
      currentUserRights: "modify",
      verifiedObjectCount: 3,
      digestByte: "4",
    }),
    writableFiles: privateDacl({
      objectKind: "file",
      protection: "inherited_from_protected_parent",
      aceDisposition: "inherited",
      propagation: "none",
      currentUserRights: "modify",
      verifiedObjectCount: 0,
      digestByte: "5",
    }),
  };
  const commitment = {
    version: 1,
    projectionManifestSha256: manifestSha256,
    launchSha256,
    ...Object.fromEntries(
      Object.entries(policies).map(([name, policy]) => [
        name,
        {
          verifiedObjectCount: policy.verifiedObjectCount,
          policyManifestSha256: policy.policyManifestSha256,
        },
      ]),
    ),
  };
  return {
    canonicalPath,
    stableIdentity: "root:1",
    state: "sealed" as const,
    manifestSha256,
    launchSha256,
    fileCount: 100,
    directoryCount: 24,
    totalBytes: 1_000,
    entrypoint: {
      relativePath: "jdk\\bin\\java.exe",
      sha256: "d".repeat(64),
      stableIdentity: "projected-file:1",
    },
    security: {
      manifestSha256: createHash("sha256")
        .update(JSON.stringify(commitment))
        .digest("hex"),
      ...policies,
    },
  };
};

const privateRootPolicyOverride = (
  policyName:
    | "rootDirectory"
    | "readonlyDirectories"
    | "readonlyFiles"
    | "writableDirectories"
    | "writableFiles",
  override: Readonly<Record<string, unknown>>,
) => {
  const observation = privateRootObservation("C:\\runtime\\rea-1");
  const policy = observation.security[policyName];
  return {
    ...observation,
    security: {
      ...observation.security,
      [policyName]: { ...policy, ...override },
    },
  };
};

class FakeResource implements WindowsNativeBackendResource {
  readonly close = vi.fn(() => Promise.resolve(ok(undefined)));
}

const jobOwnership = {
  jobObject: "dedicated_unnamed",
  assignment: "proc_thread_attribute_job_list",
  processExecution: "job_assigned_at_creation",
  killOnJobClose: "enabled",
  breakaway: "disabled",
  nestedJob: "absent",
  ownerHandle: "retained_non_inheritable",
  jobHandleOwnership: "single_rea_handle",
  inheritedHandles: "stdio_only",
  membership: "verified",
};

const jobOwnershipObservation = {
  ...jobOwnership,
  policySha256: createHash("sha256")
    .update(JSON.stringify({ version: 1, ...jobOwnership }))
    .digest("hex"),
};

class FakeProcess extends FakeResource implements WindowsNativeBackendProcess {
  readonly processId = 42;
  constructor(readonly ownership: unknown = jobOwnership) {
    super();
  }
  readonly closeProcess = vi.fn(() =>
    Promise.resolve(ok({ status: "terminated" as const })),
  );
  readonly waitForExit = vi.fn(() =>
    Promise.resolve(ok({ status: "exited" as const, exitCode: 0 })),
  );
  snapshot(): WindowsOwnedProcessSnapshot {
    return {
      stdout: {
        retained: new Uint8Array([2, 3]),
        totalBytes: 3,
        truncated: true,
      },
      stderr: {
        retained: new Uint8Array(),
        totalBytes: 0,
        truncated: false,
      },
      exit: null,
    };
  }
}

const recordingBackend = () => {
  const fileResource = new FakeResource();
  const directoryResource = new FakeResource();
  const rootResource = new FakeResource();
  const process = new FakeProcess();
  const backend: WindowsNativeAuthorityBackend = {
    identity,
    admitFile: vi.fn<WindowsNativeAuthorityBackend["admitFile"]>((input) =>
      Promise.resolve(
        ok({
          resource: fileResource,
          observation: {
            kind: "file",
            ...pathIdentity(input.path, "00112233445566778899aabbccddeeff"),
            sha256: "b".repeat(64),
          },
        }),
      ),
    ),
    admitDirectory: vi.fn<WindowsNativeAuthorityBackend["admitDirectory"]>(
      (input) =>
        Promise.resolve(
          ok({
            resource: directoryResource,
            observation: {
              kind: "directory",
              ...pathIdentity(input.path, "3".repeat(32)),
              sha256: null,
            },
          }),
        ),
    ),
    createPrivateRoot: vi.fn<
      WindowsNativeAuthorityBackend["createPrivateRoot"]
    >((input) =>
      Promise.resolve(
        ok({
          resource: rootResource,
          observation: privateRootObservation(`C:\\runtime\\${input.prefix}1`),
        }),
      ),
    ),
    spawnOwnedProcess: vi.fn(() => Promise.resolve(ok(new FakeProcess()))),
  };
  vi.mocked(backend.spawnOwnedProcess).mockResolvedValueOnce(ok(process));
  return { backend, fileResource, directoryResource, rootResource, process };
};

const control: WindowsNativeOperationControl = { deadlineMs: 10_000 };

describe("Windows native authority port", () => {
  it("fails closed when the optional adapter is unavailable", async () => {
    const authority = new WindowsNativeAuthority(
      unavailableWindowsNativeAuthorityBackend("package is not installed"),
    );
    expect(authority.identity).toBeNull();
    await expect(
      authority.admitPath({
        ...control,
        path: "C:\\rea\\provider.exe",
        kind: "file",
        reparsePolicy: "reject_all",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: "admit_path", reason: "unavailable" },
    });
  });

  it("parses stable NTFS identity and closes malformed native observations", async () => {
    const recorded = recordingBackend();
    const authority = new WindowsNativeAuthority(recorded.backend);
    const admitted = await authority.admitPath({
      ...control,
      path: "C:\\rea\\provider.exe",
      kind: "file",
      reparsePolicy: "reject_all",
    });
    expect(admitted).toMatchObject({
      ok: true,
      value: {
        requestedPath: "C:\\rea\\provider.exe",
        finalPath: "C:\\rea\\provider.exe",
        filesystem: "ntfs",
        volumeIdentity: "0123456789abcdef",
        fileIdentity: "00112233445566778899aabbccddeeff",
        stableIdentity:
          "ntfs:0123456789abcdef:00112233445566778899aabbccddeeff",
      },
    });

    const malformed = recordingBackend();
    vi.mocked(malformed.backend.admitFile).mockResolvedValueOnce(
      ok({
        resource: malformed.fileResource,
        observation: {
          kind: "file",
          ...pathIdentity("C:\\other\\provider.exe", "2".repeat(32)),
          sha256: "b".repeat(64),
        },
      }),
    );
    await expect(
      new WindowsNativeAuthority(malformed.backend).admitPath({
        ...control,
        path: "C:\\rea\\provider.exe",
        kind: "file",
        reparsePolicy: "reject_all",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        operation: "admit_path",
        reason: "native_contract_mismatch",
      },
    });
    expect(malformed.fileResource.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "uppercase identity",
      {
        kind: "file",
        ...pathIdentity("C:\\rea\\provider.exe", "A".repeat(32)),
        sha256: "b".repeat(64),
      },
    ],
    [
      "unsupported filesystem",
      {
        kind: "file",
        ...pathIdentity(
          "C:\\rea\\provider.exe",
          "00112233445566778899aabbccddeeff",
        ),
        filesystem: "refs",
        sha256: "b".repeat(64),
      },
    ],
    [
      "unknown field",
      {
        kind: "file",
        ...pathIdentity(
          "C:\\rea\\provider.exe",
          "00112233445566778899aabbccddeeff",
        ),
        sha256: "b".repeat(64),
        unexpected: true,
      },
    ],
  ])("rejects a native observation with %s", async (_name, observation) => {
    const recorded = recordingBackend();
    vi.mocked(recorded.backend.admitFile).mockResolvedValueOnce(
      ok({ resource: recorded.fileResource, observation }),
    );
    await expect(
      new WindowsNativeAuthority(recorded.backend).admitPath({
        ...control,
        path: "C:\\rea\\provider.exe",
        kind: "file",
        reparsePolicy: "reject_all",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    expect(recorded.fileResource.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["null DACL", privateRootPolicyOverride("rootDirectory", { dacl: "null" })],
    [
      "broad allow entry",
      privateRootPolicyOverride("readonlyFiles", {
        broadAllowEntries: "present",
      }),
    ],
    [
      "non-modifiable writable policy",
      privateRootPolicyOverride("writableDirectories", {
        currentUserRights: "read_execute",
      }),
    ],
    [
      "wrong owner",
      privateRootPolicyOverride("rootDirectory", { owner: "administrators" }),
    ],
    [
      "unprotected immutable file",
      privateRootPolicyOverride("readonlyFiles", {
        protection: "inherited_from_protected_parent",
      }),
    ],
    [
      "missing OWNER RIGHTS denial",
      privateRootPolicyOverride("readonlyDirectories", {
        ownerRights: "absent",
      }),
    ],
    [
      "additional trustee",
      privateRootPolicyOverride("writableFiles", {
        additionalTrustees: "present",
      }),
    ],
    [
      "wrong SYSTEM rights",
      privateRootPolicyOverride("rootDirectory", { systemRights: "modify" }),
    ],
    [
      "leaf propagation",
      privateRootPolicyOverride("readonlyFiles", {
        propagation: "container_and_object",
      }),
    ],
    [
      "unknown policy field",
      privateRootPolicyOverride("rootDirectory", { unexpected: true }),
    ],
    [
      "malformed descriptor digest",
      privateRootPolicyOverride("rootDirectory", { descriptorSha256: "abc" }),
    ],
    [
      "mismatched object count",
      {
        ...privateRootObservation("C:\\runtime\\rea-1"),
        fileCount: 101,
      },
    ],
    [
      "mismatched security manifest",
      {
        ...privateRootObservation("C:\\runtime\\rea-1"),
        security: {
          ...privateRootObservation("C:\\runtime\\rea-1").security,
          manifestSha256: "0".repeat(64),
        },
      },
    ],
    [
      "security manifest from another projection",
      {
        ...privateRootObservation("C:\\runtime\\rea-1"),
        manifestSha256: "a".repeat(64),
      },
    ],
  ])(
    "rejects a private-root observation with %s",
    async (_name, observation) => {
      const recorded = recordingBackend();
      const authority = new WindowsNativeAuthority(recorded.backend);
      const directory = await authority.admitPath({
        ...control,
        path: "C:\\rea",
        kind: "directory",
        reparsePolicy: "reject_all",
      });
      if (!directory.ok) throw new Error("fake directory admission failed");
      vi.mocked(recorded.backend.createPrivateRoot).mockResolvedValueOnce(
        ok({ resource: recorded.rootResource, observation }),
      );
      await expect(
        authority.createPrivateRoot({
          ...control,
          parent: directory.value,
          prefix: "rea-",
          trees: [],
          files: [],
          writableDirectories: [],
          entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
          launch: { arguments: [], environment: {} },
          limits: { entries: 1, depth: 1, bytes: 1 },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          operation: "create_private_root",
          reason: "native_contract_mismatch",
        },
      });
      expect(recorded.rootResource.close).toHaveBeenCalledOnce();
    },
  );

  it("scopes resources, deadlines, and process lifetime to one authority", async () => {
    const recorded = recordingBackend();
    const authority = new WindowsNativeAuthority(recorded.backend);
    const foreignAuthority = new WindowsNativeAuthority(
      recordingBackend().backend,
    );
    const file = await authority.admitPath({
      ...control,
      path: "C:\\rea\\provider.exe",
      kind: "file",
      reparsePolicy: "reject_all",
    });
    const directory = await authority.admitPath({
      ...control,
      path: "C:\\rea",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!file.ok || !directory.ok) throw new Error("fake admission failed");
    const foreignDirectory = await foreignAuthority.admitPath({
      ...control,
      path: "C:\\foreign-jdk",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!foreignDirectory.ok) throw new Error("fake foreign admission failed");

    await expect(
      foreignAuthority.createPrivateRoot({
        ...control,
        parent: directory.value,
        prefix: "rea-",
        trees: [],
        files: [],
        writableDirectories: [],
        entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
        launch: { arguments: [], environment: {} },
        limits: { entries: 1, depth: 1, bytes: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: "create_private_root", reason: "invalid_input" },
    });
    await expect(
      authority.createPrivateRoot({
        ...control,
        parent: directory.value,
        prefix: "rea-",
        trees: [
          {
            role: "jdk",
            source: foreignDirectory.value,
            destination: "jdk",
          },
        ],
        files: [],
        writableDirectories: [],
        entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
        launch: { arguments: [], environment: {} },
        limits: { entries: 1, depth: 1, bytes: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: "create_private_root", reason: "invalid_input" },
    });

    const root = await authority.createPrivateRoot({
      ...control,
      parent: directory.value,
      prefix: "rea-",
      trees: [
        {
          role: "jdk",
          source: directory.value,
          destination: "jdk",
        },
      ],
      files: [
        {
          role: "target",
          source: file.value,
          destination: "in\\target.exe",
        },
      ],
      writableDirectories: ["home", "tmp"],
      entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
      launch: { arguments: ["-version"], environment: {} },
      limits: { entries: 1_000, depth: 20, bytes: 1_000_000 },
    });
    if (!root.ok) throw new Error("fake root creation failed");
    expect(root.value.security).toMatchObject({
      rootDirectory: {
        dacl: "present",
        protection: "protected",
        aceDisposition: "explicit",
        propagation: "none",
        currentUserRights: "read_execute",
        ownerRights: "write_dac_write_owner_denied",
      },
      readonlyDirectories: { currentUserRights: "read_execute" },
      readonlyFiles: { currentUserRights: "read_execute" },
      writableDirectories: { currentUserRights: "modify" },
      writableFiles: {
        protection: "inherited_from_protected_parent",
        aceDisposition: "inherited",
        currentUserRights: "modify",
      },
    });
    const spawned = await authority.spawnOwnedProcess({
      ...control,
      runtimeProjection: root.value,
      limits: { stdoutBytes: 2, stderrBytes: 2 },
    });
    if (!spawned.ok) throw new Error("fake process spawn failed");
    expect(spawned.value.ownership).toEqual(jobOwnershipObservation);

    expect(recorded.backend.createPrivateRoot).toHaveBeenCalledWith({
      parent: recorded.directoryResource,
      prefix: "rea-",
      trees: [
        {
          role: "jdk",
          source: recorded.directoryResource,
          destination: "jdk",
        },
      ],
      files: [
        {
          role: "target",
          source: recorded.fileResource,
          destination: "in\\target.exe",
        },
      ],
      writableDirectories: ["home", "tmp"],
      entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
      launch: { arguments: ["-version"], environment: {} },
      limits: { entries: 1_000, depth: 20, bytes: 1_000_000 },
      control,
    });
    expect(spawned.value.snapshot().stdout).toMatchObject({
      totalBytes: 3,
      truncated: true,
    });
    vi.spyOn(recorded.process, "snapshot").mockReturnValueOnce({
      stdout: { retained: new Uint8Array(3), totalBytes: 3, truncated: false },
      stderr: { retained: new Uint8Array(), totalBytes: 0, truncated: false },
      exit: null,
    });
    expect(() => spawned.value.snapshot()).toThrowError(
      expect.objectContaining({
        operation: "observe_process",
        reason: "native_contract_mismatch",
      }),
    );
    recorded.process.waitForExit.mockResolvedValueOnce(
      ok({ status: "exited", exitCode: 1.5 }) as never,
    );
    await expect(spawned.value.waitForExit()).resolves.toMatchObject({
      ok: false,
      error: {
        operation: "wait_for_exit",
        reason: "native_contract_mismatch",
      },
    });
    recorded.process.waitForExit.mockRejectedValueOnce(
      new Error("native wait rejection"),
    );
    await expect(spawned.value.waitForExit()).resolves.toMatchObject({
      ok: false,
      error: { operation: "wait_for_exit", reason: "native_failure" },
    });
    recorded.process.closeProcess.mockRejectedValueOnce(
      new Error("native close rejection"),
    );
    const firstClose = await spawned.value.close();
    const secondClose = await spawned.value.close();
    expect(firstClose).toMatchObject({
      ok: false,
      error: { operation: "close_resource", reason: "native_failure" },
    });
    expect(secondClose).toBe(firstClose);
    expect(recorded.process.closeProcess).toHaveBeenCalledTimes(1);

    await file.value.close();
    await file.value.close();
    expect(recorded.fileResource.close).toHaveBeenCalledTimes(1);

    const projectedSpawn = await authority.spawnOwnedProcess({
      ...control,
      runtimeProjection: root.value,
      limits: { stdoutBytes: 2, stderrBytes: 2 },
    });
    expect(projectedSpawn.ok).toBe(true);

    await root.value.close();
    await root.value.close();
    expect(recorded.rootResource.close).toHaveBeenCalledTimes(1);
    await expect(
      authority.spawnOwnedProcess({
        ...control,
        runtimeProjection: root.value,
        limits: { stdoutBytes: 2, stderrBytes: 2 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: "spawn_owned_process", reason: "identity_drift" },
    });
  });

  it.each([
    ["named Job", { ...jobOwnership, jobObject: "named" }],
    [
      "post-create assignment",
      { ...jobOwnership, assignment: "assign_after_create" },
    ],
    [
      "pre-assignment execution",
      { ...jobOwnership, processExecution: "started_unassigned" },
    ],
    ["disabled kill-on-close", { ...jobOwnership, killOnJobClose: "disabled" }],
    ["breakaway", { ...jobOwnership, breakaway: "enabled" }],
    ["nested Job", { ...jobOwnership, nestedJob: "compatible" }],
    [
      "inheritable owner handle",
      { ...jobOwnership, ownerHandle: "inheritable" },
    ],
    [
      "duplicate Job handle",
      { ...jobOwnership, jobHandleOwnership: "multiple_handles" },
    ],
    [
      "ambient inherited handles",
      { ...jobOwnership, inheritedHandles: "ambient" },
    ],
    ["unverified membership", { ...jobOwnership, membership: "assumed" }],
    ["unknown policy field", { ...jobOwnership, unexpected: true }],
  ])("rejects a process with %s", async (_name, malformedOwnership) => {
    const recorded = recordingBackend();
    const authority = new WindowsNativeAuthority(recorded.backend);
    const directory = await authority.admitPath({
      ...control,
      path: "C:\\rea",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!directory.ok) throw new Error("fake directory admission failed");
    const root = await authority.createPrivateRoot({
      ...control,
      parent: directory.value,
      prefix: "rea-",
      trees: [],
      files: [],
      writableDirectories: [],
      entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
      launch: { arguments: [], environment: {} },
      limits: { entries: 1, depth: 1, bytes: 1 },
    });
    if (!root.ok) throw new Error("fake root creation failed");
    const malformed = new FakeProcess(malformedOwnership);
    vi.mocked(recorded.backend.spawnOwnedProcess).mockReset();
    vi.mocked(recorded.backend.spawnOwnedProcess).mockResolvedValueOnce(
      ok(malformed),
    );
    await expect(
      authority.spawnOwnedProcess({
        ...control,
        runtimeProjection: root.value,
        limits: { stdoutBytes: 1, stderrBytes: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        operation: "spawn_owned_process",
        reason: "native_contract_mismatch",
      },
    });
    expect(malformed.closeProcess).toHaveBeenCalledOnce();
  });

  it("rejects a process with an invalid native process identifier", async () => {
    const recorded = recordingBackend();
    const authority = new WindowsNativeAuthority(recorded.backend);
    const directory = await authority.admitPath({
      ...control,
      path: "C:\\rea",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!directory.ok) throw new Error("fake directory admission failed");
    const root = await authority.createPrivateRoot({
      ...control,
      parent: directory.value,
      prefix: "rea-",
      trees: [],
      files: [],
      writableDirectories: [],
      entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
      launch: { arguments: [], environment: {} },
      limits: { entries: 1, depth: 1, bytes: 1 },
    });
    if (!root.ok) throw new Error("fake root creation failed");
    const malformed = new FakeProcess();
    Object.defineProperty(malformed, "processId", { value: -1 });
    vi.mocked(recorded.backend.spawnOwnedProcess).mockReset();
    vi.mocked(recorded.backend.spawnOwnedProcess).mockResolvedValueOnce(
      ok(malformed),
    );

    await expect(
      authority.spawnOwnedProcess({
        ...control,
        runtimeProjection: root.value,
        limits: { stdoutBytes: 1, stderrBytes: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        operation: "spawn_owned_process",
        reason: "native_contract_mismatch",
      },
    });
    expect(malformed.closeProcess).toHaveBeenCalledOnce();
  });

  it("defers resource closure across in-flight projection and spawn operations", async () => {
    const recorded = recordingBackend();
    const authority = new WindowsNativeAuthority(recorded.backend);
    const file = await authority.admitPath({
      ...control,
      path: "C:\\rea\\target.exe",
      kind: "file",
      reparsePolicy: "reject_all",
    });
    const directory = await authority.admitPath({
      ...control,
      path: "C:\\rea\\jdk",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!file.ok || !directory.ok) throw new Error("fake admission failed");

    const rootDeferred =
      deferred<
        Awaited<ReturnType<WindowsNativeAuthorityBackend["createPrivateRoot"]>>
      >();
    vi.mocked(recorded.backend.createPrivateRoot).mockReturnValueOnce(
      rootDeferred.promise,
    );
    const trees = [
      { role: "jdk" as const, source: directory.value, destination: "jdk" },
    ];
    const files = [
      {
        role: "target" as const,
        source: file.value,
        destination: "in\\target.exe",
      },
    ];
    const writableDirectories = ["home"];
    const launchArguments = ["-version"];
    const launchEnvironment: Record<string, string> = { HOME: "home" };
    const pendingRoot = authority.createPrivateRoot({
      ...control,
      parent: directory.value,
      prefix: "rea-",
      trees,
      files,
      writableDirectories,
      entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
      launch: {
        arguments: launchArguments,
        environment: launchEnvironment,
      },
      limits: { entries: 10, depth: 3, bytes: 1_000 },
    });

    trees[0]!.destination = "mutated";
    files[0]!.destination = "mutated";
    writableDirectories.push("mutated");
    launchArguments.push("mutated");
    launchEnvironment.HOME = "mutated";
    const directoryClose = directory.value.close();
    const fileClose = file.value.close();
    expect(recorded.directoryResource.close).not.toHaveBeenCalled();
    expect(recorded.fileResource.close).not.toHaveBeenCalled();
    expect(recorded.backend.createPrivateRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        trees: [expect.objectContaining({ destination: "jdk" })],
        files: [expect.objectContaining({ destination: "in\\target.exe" })],
        writableDirectories: ["home"],
        launch: { arguments: ["-version"], environment: { HOME: "home" } },
      }),
    );

    rootDeferred.resolve(
      ok({
        resource: recorded.rootResource,
        observation: privateRootObservation("C:\\runtime\\rea-1"),
      }),
    );
    const root = await pendingRoot;
    expect(root.ok).toBe(true);
    await Promise.all([directoryClose, fileClose]);
    expect(recorded.directoryResource.close).toHaveBeenCalledOnce();
    expect(recorded.fileResource.close).toHaveBeenCalledOnce();
    if (!root.ok) throw new Error("fake root creation failed");

    const spawnDeferred =
      deferred<
        Awaited<ReturnType<WindowsNativeAuthorityBackend["spawnOwnedProcess"]>>
      >();
    vi.mocked(recorded.backend.spawnOwnedProcess).mockReturnValueOnce(
      spawnDeferred.promise,
    );
    const pendingSpawn = authority.spawnOwnedProcess({
      ...control,
      runtimeProjection: root.value,
      limits: { stdoutBytes: 2, stderrBytes: 2 },
    });
    const rootClose = root.value.close();
    expect(recorded.rootResource.close).not.toHaveBeenCalled();
    spawnDeferred.resolve(ok(new FakeProcess()));
    expect((await pendingSpawn).ok).toBe(true);
    await rootClose;
    expect(recorded.rootResource.close).toHaveBeenCalledOnce();
  });

  it("rejects duplicate and cross-kind backend resource tokens", async () => {
    const shared = new FakeResource();
    const recorded = recordingBackend();
    vi.mocked(recorded.backend.admitFile).mockResolvedValue(
      ok({
        resource: shared,
        observation: {
          kind: "file",
          ...pathIdentity("C:\\rea\\a.exe", "4".repeat(32)),
          sha256: "a".repeat(64),
        },
      }),
    );
    vi.mocked(recorded.backend.admitDirectory).mockResolvedValue(
      ok({
        resource: shared,
        observation: {
          kind: "directory",
          ...pathIdentity("C:\\rea", "5".repeat(32)),
          sha256: null,
        },
      }),
    );
    const authority = new WindowsNativeAuthority(recorded.backend);
    expect(
      (
        await authority.admitPath({
          ...control,
          path: "C:\\rea\\a.exe",
          kind: "file",
          reparsePolicy: "reject_all",
        })
      ).ok,
    ).toBe(true);
    await expect(
      authority.admitPath({
        ...control,
        path: "C:\\rea\\b.exe",
        kind: "file",
        reparsePolicy: "reject_all",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    await expect(
      authority.admitPath({
        ...control,
        path: "C:\\rea",
        kind: "directory",
        reparsePolicy: "reject_all",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });

    const secondAuthority = new WindowsNativeAuthority(recorded.backend);
    await expect(
      secondAuthority.admitPath({
        ...control,
        path: "C:\\rea\\c.exe",
        kind: "file",
        reparsePolicy: "reject_all",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    expect(shared.close).toHaveBeenCalledOnce();
  });

  it("defers alias poisoning until an existing resource lease is released", async () => {
    const recorded = recordingBackend();
    const authority = new WindowsNativeAuthority(recorded.backend);
    const directory = await authority.admitPath({
      ...control,
      path: "C:\\rea\\jdk",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!directory.ok) throw new Error("fake directory admission failed");
    recorded.directoryResource.close.mockRejectedValueOnce(
      new Error("fixture cleanup rejection"),
    );

    const rootDeferred =
      deferred<
        Awaited<ReturnType<WindowsNativeAuthorityBackend["createPrivateRoot"]>>
      >();
    vi.mocked(recorded.backend.createPrivateRoot).mockReturnValueOnce(
      rootDeferred.promise,
    );
    const pendingRoot = authority.createPrivateRoot({
      ...control,
      parent: directory.value,
      prefix: "rea-",
      trees: [],
      files: [],
      writableDirectories: [],
      entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
      launch: { arguments: [], environment: {} },
      limits: { entries: 1, depth: 1, bytes: 1 },
    });
    vi.mocked(recorded.backend.admitFile).mockResolvedValueOnce(
      ok({
        resource: recorded.directoryResource,
        observation: {
          kind: "file",
          ...pathIdentity("C:\\rea\\alias.exe", "6".repeat(32)),
          sha256: "a".repeat(64),
        },
      }),
    );
    const pendingAlias = authority.admitPath({
      ...control,
      path: "C:\\rea\\alias.exe",
      kind: "file",
      reparsePolicy: "reject_all",
    });
    await Promise.resolve();
    expect(recorded.directoryResource.close).not.toHaveBeenCalled();

    rootDeferred.resolve(
      err(
        new WindowsNativeAuthorityError(
          "create_private_root",
          "native_failure",
          "fixture failure",
        ),
      ),
    );
    await pendingRoot;
    await expect(pendingAlias).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    expect(recorded.directoryResource.close).toHaveBeenCalledOnce();
    await expect(directory.value.close()).resolves.toMatchObject({
      ok: false,
      error: { operation: "close_resource", reason: "native_failure" },
    });
  });

  it("preserves alias rejection when registered cleanup rejects immediately", async () => {
    const recorded = recordingBackend();
    const authority = new WindowsNativeAuthority(recorded.backend);
    const file = await authority.admitPath({
      ...control,
      path: "C:\\rea\\provider.exe",
      kind: "file",
      reparsePolicy: "reject_all",
    });
    if (!file.ok) throw new Error("fake file admission failed");
    recorded.fileResource.close.mockRejectedValueOnce(
      new Error("fixture cleanup rejection"),
    );
    await expect(
      authority.admitPath({
        ...control,
        path: "C:\\rea\\provider.exe",
        kind: "file",
        reparsePolicy: "reject_all",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    await expect(file.value.close()).resolves.toMatchObject({
      ok: false,
      error: { operation: "close_resource", reason: "native_failure" },
    });
  });

  it("cleans up aliased roots and jobs before rejecting them", async () => {
    const rootAlias = recordingBackend();
    const rootAuthority = new WindowsNativeAuthority(rootAlias.backend);
    const directory = await rootAuthority.admitPath({
      ...control,
      path: "C:\\rea",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!directory.ok) throw new Error("fake admission failed");
    vi.mocked(rootAlias.backend.createPrivateRoot).mockImplementationOnce(
      async (input) =>
        ok({
          resource: rootAlias.directoryResource,
          observation: privateRootObservation(
            `C:\\runtime\\${input.prefix}alias`,
          ),
        }),
    );
    await expect(
      rootAuthority.createPrivateRoot({
        ...control,
        parent: directory.value,
        prefix: "rea-",
        trees: [],
        files: [],
        writableDirectories: [],
        entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
        launch: { arguments: [], environment: {} },
        limits: { entries: 1, depth: 1, bytes: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    expect(rootAlias.directoryResource.close).toHaveBeenCalledOnce();

    const processAlias = recordingBackend();
    const processAuthority = new WindowsNativeAuthority(processAlias.backend);
    const processDirectory = await processAuthority.admitPath({
      ...control,
      path: "C:\\rea",
      kind: "directory",
      reparsePolicy: "reject_all",
    });
    if (!processDirectory.ok) throw new Error("fake admission failed");
    vi.mocked(processAlias.backend.createPrivateRoot).mockImplementationOnce(
      async (input) =>
        ok({
          resource: processAlias.process,
          observation: privateRootObservation(
            `C:\\runtime\\${input.prefix}process-alias`,
          ),
        }),
    );
    const root = await processAuthority.createPrivateRoot({
      ...control,
      parent: processDirectory.value,
      prefix: "rea-",
      trees: [],
      files: [],
      writableDirectories: [],
      entrypoint: { treeRole: "jdk", relativePath: "bin\\java.exe" },
      launch: { arguments: [], environment: {} },
      limits: { entries: 1, depth: 1, bytes: 1 },
    });
    if (!root.ok) throw new Error("fake root creation failed");
    await expect(
      processAuthority.spawnOwnedProcess({
        ...control,
        runtimeProjection: root.value,
        limits: { stdoutBytes: 1, stderrBytes: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    expect(processAlias.process.close).toHaveBeenCalledOnce();
    expect(processAlias.process.closeProcess).not.toHaveBeenCalled();
  });
});
