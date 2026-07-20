import { createHash } from "node:crypto";

import { err, ok, type Result } from "../domain/result.js";
import { z } from "zod";

/** Stable operation names exposed by the Windows native authority boundary. */
export type WindowsNativeAuthorityOperation =
  | "load_native_authority"
  | "admit_path"
  | "create_private_root"
  | "spawn_owned_process"
  | "observe_process"
  | "wait_for_exit"
  | "close_resource";

/** Expected failures translated from the optional native adapter boundary. */
export type WindowsNativeAuthorityFailureReason =
  | "unavailable"
  | "invalid_input"
  | "policy_rejected"
  | "identity_drift"
  | "access_denied"
  | "resource_exhausted"
  | "timeout"
  | "cancelled"
  | "native_contract_mismatch"
  | "native_failure";

/** Provider-neutral failure from one Windows native authority operation. */
export class WindowsNativeAuthorityError extends Error {
  readonly _tag = "WindowsNativeAuthorityError" as const;

  constructor(
    readonly operation: WindowsNativeAuthorityOperation,
    readonly reason: WindowsNativeAuthorityFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Loaded native contract identity used for package and capability diagnostics. */
export interface WindowsNativeAuthorityIdentity {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly contractVersion: number;
  readonly nodeApiVersion: number;
  readonly artifactSha256: string;
}

/** Cancellation and one absolute deadline shared by every startup phase. */
export interface WindowsNativeOperationControl {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

/** Input for atomic path admission under the initial fail-closed policy. */
export interface WindowsPathAdmissionInput<
  TKind extends "file" | "directory" = "file" | "directory",
> extends WindowsNativeOperationControl {
  readonly path: string;
  readonly kind: TKind;
  readonly reparsePolicy: "reject_all";
  readonly expectedSha256?: string;
}

interface WindowsAdmittedPathObservation<TKind extends "file" | "directory"> {
  readonly kind: TKind;
  readonly requestedPath: string;
  readonly finalPath: string;
  readonly filesystem: "ntfs";
  readonly volumeIdentity: string;
  readonly fileIdentity: string;
  readonly stableIdentity: string;
  readonly reparseDisposition: "absent";
}

/** Backend observation for a handle-admitted regular file. */
interface WindowsAdmittedFileObservation
  extends WindowsAdmittedPathObservation<"file"> {
  readonly sha256: string;
}

/** Backend observation for a handle-admitted directory. */
interface WindowsAdmittedDirectoryObservation
  extends WindowsAdmittedPathObservation<"directory"> {
  readonly sha256: null;
}

const windowsPathIdentitySchema = z.strictObject({
  requestedPath: z.string().min(1),
  finalPath: z.string().min(1),
  filesystem: z.literal("ntfs"),
  volumeIdentity: z.string().regex(/^[0-9a-f]{16}$/u),
  fileIdentity: z.string().regex(/^[0-9a-f]{32}$/u),
  reparseDisposition: z.literal("absent"),
});

const admittedFileObservationSchema = windowsPathIdentitySchema.extend({
  kind: z.literal("file"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const admittedDirectoryObservationSchema = windowsPathIdentitySchema.extend({
  kind: z.literal("directory"),
  sha256: z.null(),
});

const privateDaclObservationSchema = z.strictObject({
  objectKind: z.enum(["directory", "file"]),
  owner: z.literal("current_user"),
  dacl: z.literal("present"),
  protection: z.enum(["protected", "inherited_from_protected_parent"]),
  aceDisposition: z.enum(["explicit", "inherited"]),
  propagation: z.enum(["none", "container_and_object"]),
  additionalTrustees: z.literal("absent"),
  broadAllowEntries: z.literal("absent"),
  currentUserRights: z.enum(["read_execute", "modify"]),
  systemRights: z.literal("full_control"),
  ownerRights: z.literal("write_dac_write_owner_denied"),
  descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  verifiedObjectCount: z.number().int().nonnegative(),
  policyManifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const explicitPolicySchema = privateDaclObservationSchema.extend({
  protection: z.literal("protected"),
  aceDisposition: z.literal("explicit"),
});

const rootDirectoryPolicySchema = explicitPolicySchema.extend({
  objectKind: z.literal("directory"),
  propagation: z.literal("none"),
  currentUserRights: z.literal("read_execute"),
  verifiedObjectCount: z.literal(1),
});

const readonlyDirectoryPolicySchema = explicitPolicySchema.extend({
  objectKind: z.literal("directory"),
  propagation: z.literal("container_and_object"),
  currentUserRights: z.literal("read_execute"),
});

const readonlyFilePolicySchema = explicitPolicySchema.extend({
  objectKind: z.literal("file"),
  propagation: z.literal("none"),
  currentUserRights: z.literal("read_execute"),
});

const writableDirectoryPolicySchema = explicitPolicySchema.extend({
  objectKind: z.literal("directory"),
  propagation: z.literal("container_and_object"),
  currentUserRights: z.literal("modify"),
});

const writableFilePolicySchema = privateDaclObservationSchema.extend({
  objectKind: z.literal("file"),
  protection: z.literal("inherited_from_protected_parent"),
  aceDisposition: z.literal("inherited"),
  propagation: z.literal("none"),
  currentUserRights: z.literal("modify"),
});

const privateRootObservationSchema = z.strictObject({
  canonicalPath: z.string().min(1),
  stableIdentity: z.string().min(1),
  state: z.literal("sealed"),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  launchSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  fileCount: z.number().int().nonnegative(),
  directoryCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  entrypoint: z.strictObject({
    relativePath: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    stableIdentity: z.string().min(1),
  }),
  security: z.strictObject({
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    rootDirectory: rootDirectoryPolicySchema,
    readonlyDirectories: readonlyDirectoryPolicySchema,
    readonlyFiles: readonlyFilePolicySchema,
    writableDirectories: writableDirectoryPolicySchema,
    writableFiles: writableFilePolicySchema,
  }),
});

const jobOwnershipObservationSchema = z.strictObject({
  jobObject: z.literal("dedicated_unnamed"),
  assignment: z.literal("proc_thread_attribute_job_list"),
  processExecution: z.literal("job_assigned_at_creation"),
  killOnJobClose: z.literal("enabled"),
  breakaway: z.literal("disabled"),
  nestedJob: z.literal("absent"),
  ownerHandle: z.literal("retained_non_inheritable"),
  jobHandleOwnership: z.literal("single_rea_handle"),
  inheritedHandles: z.literal("stdio_only"),
  membership: z.literal("verified"),
});

const ownedProcessExitSchema = z.strictObject({
  status: z.enum(["exited", "terminated"]),
  exitCode: z.number().int().nullable(),
});

const ownedProcessCloseSchema = z.strictObject({
  status: z.enum(["already_empty", "terminated"]),
});

const ownedProcessStreamSnapshotSchema = z.strictObject({
  retained: z.instanceof(Uint8Array),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const ownedProcessSnapshotSchema = z.strictObject({
  stdout: ownedProcessStreamSnapshotSchema,
  stderr: ownedProcessStreamSnapshotSchema,
  exit: ownedProcessExitSchema.nullable(),
});

/** Verified provider-neutral policy observations for a private runtime root. */
interface WindowsPrivateDaclObservation {
  readonly objectKind: "directory" | "file";
  readonly owner: "current_user";
  readonly dacl: "present";
  readonly protection: "protected" | "inherited_from_protected_parent";
  readonly aceDisposition: "explicit" | "inherited";
  readonly propagation: "none" | "container_and_object";
  readonly additionalTrustees: "absent";
  readonly broadAllowEntries: "absent";
  readonly currentUserRights: "read_execute" | "modify";
  readonly systemRights: "full_control";
  readonly ownerRights: "write_dac_write_owner_denied";
  readonly descriptorSha256: string;
  readonly verifiedObjectCount: number;
  readonly policyManifestSha256: string;
}

/** Exact normalized DACL policies read back from a sealed runtime tree. */
interface WindowsPrivateRootSecurityObservation {
  readonly manifestSha256: string;
  readonly rootDirectory: WindowsPrivateDaclObservation & {
    readonly objectKind: "directory";
    readonly protection: "protected";
    readonly aceDisposition: "explicit";
    readonly propagation: "none";
    readonly currentUserRights: "read_execute";
    readonly verifiedObjectCount: 1;
  };
  readonly readonlyDirectories: WindowsPrivateDaclObservation & {
    readonly objectKind: "directory";
    readonly protection: "protected";
    readonly aceDisposition: "explicit";
    readonly propagation: "container_and_object";
    readonly currentUserRights: "read_execute";
  };
  readonly readonlyFiles: WindowsPrivateDaclObservation & {
    readonly objectKind: "file";
    readonly protection: "protected";
    readonly aceDisposition: "explicit";
    readonly propagation: "none";
    readonly currentUserRights: "read_execute";
  };
  readonly writableDirectories: WindowsPrivateDaclObservation & {
    readonly objectKind: "directory";
    readonly protection: "protected";
    readonly aceDisposition: "explicit";
    readonly propagation: "container_and_object";
    readonly currentUserRights: "modify";
  };
  readonly writableFiles: WindowsPrivateDaclObservation & {
    readonly objectKind: "file";
    readonly protection: "inherited_from_protected_parent";
    readonly aceDisposition: "inherited";
    readonly propagation: "none";
    readonly currentUserRights: "modify";
  };
}

/** Verified provider-neutral policy observations for a private runtime root. */
interface WindowsPrivateRootObservation {
  readonly canonicalPath: string;
  readonly stableIdentity: string;
  readonly state: "sealed";
  readonly manifestSha256: string;
  readonly launchSha256: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
  readonly entrypoint: Readonly<{
    relativePath: string;
    sha256: string;
    stableIdentity: string;
  }>;
  readonly security: WindowsPrivateRootSecurityObservation;
}

/** Hard bounds applied while projecting admitted runtime inputs. */
interface WindowsRuntimeProjectionLimits {
  readonly entries: number;
  readonly depth: number;
  readonly bytes: number;
}

/** One admitted directory tree assigned a provider-neutral runtime role. */
interface WindowsRuntimeTreeProjection {
  readonly role: "ghidra" | "jdk";
  readonly source: WindowsAdmittedDirectory;
  readonly destination: string;
}

/** One admitted file assigned a provider-neutral runtime role. */
interface WindowsRuntimeFileProjection {
  readonly role: "bridge" | "session" | "target";
  readonly source: WindowsAdmittedFile;
  readonly destination: string;
}

/** Immutable bounds applied before an owned process is started. */
interface WindowsOwnedProcessLimits {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/** Final process observation independent of Win32 status structures. */
interface WindowsOwnedProcessExit {
  readonly status: "exited" | "terminated";
  readonly exitCode: number | null;
}

/** Normalized Job Object policy proven before an owned process is returned. */
interface WindowsJobOwnershipObservation {
  readonly jobObject: "dedicated_unnamed";
  readonly assignment: "proc_thread_attribute_job_list";
  readonly processExecution: "job_assigned_at_creation";
  readonly killOnJobClose: "enabled";
  readonly breakaway: "disabled";
  readonly nestedJob: "absent";
  readonly ownerHandle: "retained_non_inheritable";
  readonly jobHandleOwnership: "single_rea_handle";
  readonly inheritedHandles: "stdio_only";
  readonly membership: "verified";
  readonly policySha256: string;
}

/** Idempotent close observation for a dedicated process Job Object. */
interface WindowsOwnedProcessClose {
  readonly status: "already_empty" | "terminated";
}

/** One continuously drained stream with bounded retained bytes. */
interface WindowsOwnedProcessStreamSnapshot {
  readonly retained: Uint8Array;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/** Detached bounded output and exit observations for one owned process. */
export interface WindowsOwnedProcessSnapshot {
  readonly stdout: WindowsOwnedProcessStreamSnapshot;
  readonly stderr: WindowsOwnedProcessStreamSnapshot;
  readonly exit: WindowsOwnedProcessExit | null;
}

/** Adapter-private resource token; application callers never receive it. */
export interface WindowsNativeBackendResource {
  close(): Promise<Result<void, WindowsNativeAuthorityError>>;
}

/** Adapter-private process token with continuously drained bounded output. */
export interface WindowsNativeBackendProcess
  extends WindowsNativeBackendResource {
  readonly processId: number;
  readonly ownership: unknown;
  snapshot(): WindowsOwnedProcessSnapshot;
  waitForExit(
    signal?: AbortSignal,
  ): Promise<Result<WindowsOwnedProcessExit, WindowsNativeAuthorityError>>;
  closeProcess(): Promise<
    Result<WindowsOwnedProcessClose, WindowsNativeAuthorityError>
  >;
}

/** Backend result for one newly admitted file. */
interface WindowsNativeAdmittedFile {
  readonly resource: WindowsNativeBackendResource;
  readonly observation: unknown;
}

/** Backend result for one newly admitted directory. */
interface WindowsNativeAdmittedDirectory {
  readonly resource: WindowsNativeBackendResource;
  readonly observation: unknown;
}

/** Backend result for one newly created private root. */
interface WindowsNativePrivateRoot {
  readonly resource: WindowsNativeBackendResource;
  readonly observation: unknown;
}

/** Adapter-private admitted tree without application wrapper values. */
interface WindowsNativeRuntimeTreeProjection {
  readonly role: WindowsRuntimeTreeProjection["role"];
  readonly source: WindowsNativeBackendResource;
  readonly destination: string;
}

/** Adapter-private admitted file without application wrapper values. */
interface WindowsNativeRuntimeFileProjection {
  readonly role: WindowsRuntimeFileProjection["role"];
  readonly source: WindowsNativeBackendResource;
  readonly destination: string;
}

/** Narrow contract implemented by the optional platform package. */
export interface WindowsNativeAuthorityBackend {
  readonly identity: WindowsNativeAuthorityIdentity | null;
  admitFile(
    input: WindowsPathAdmissionInput<"file">,
  ): Promise<Result<WindowsNativeAdmittedFile, WindowsNativeAuthorityError>>;
  admitDirectory(
    input: WindowsPathAdmissionInput<"directory">,
  ): Promise<
    Result<WindowsNativeAdmittedDirectory, WindowsNativeAuthorityError>
  >;
  createPrivateRoot(
    input: Readonly<{
      parent: WindowsNativeBackendResource;
      prefix: string;
      trees: readonly WindowsNativeRuntimeTreeProjection[];
      files: readonly WindowsNativeRuntimeFileProjection[];
      writableDirectories: readonly string[];
      entrypoint: Readonly<{
        treeRole: "jdk";
        relativePath: string;
      }>;
      launch: Readonly<{
        arguments: readonly string[];
        environment: Readonly<Record<string, string>>;
      }>;
      limits: WindowsRuntimeProjectionLimits;
      control: WindowsNativeOperationControl;
    }>,
  ): Promise<Result<WindowsNativePrivateRoot, WindowsNativeAuthorityError>>;
  spawnOwnedProcess(input: {
    readonly runtimeProjection: WindowsNativeBackendResource;
    readonly limits: WindowsOwnedProcessLimits;
    readonly control: WindowsNativeOperationControl;
  }): Promise<Result<WindowsNativeBackendProcess, WindowsNativeAuthorityError>>;
}

type ResourceStatus = "open" | "closing" | "closed";
type ResourceKind = "file" | "directory" | "privateRoot" | "process";

interface CloseDeferred {
  readonly promise: Promise<Result<void, WindowsNativeAuthorityError>>;
  readonly resolve: (value: Result<void, WindowsNativeAuthorityError>) => void;
}

interface ResourceState {
  readonly owner: WindowsNativeAuthority;
  readonly backend: WindowsNativeBackendResource;
  readonly closeBackend: () => Promise<
    Result<void, WindowsNativeAuthorityError>
  >;
  readonly kind: ResourceKind;
  status: ResourceStatus;
  leaseCount: number;
  closePromise?: Promise<Result<void, WindowsNativeAuthorityError>>;
  closeDeferred?: CloseDeferred;
}

interface ResolvedResource {
  readonly backend: WindowsNativeBackendResource;
  readonly state: ResourceState;
}

interface ResolvedTreeProjection {
  readonly role: WindowsRuntimeTreeProjection["role"];
  readonly backend: WindowsNativeBackendResource;
  readonly destination: string;
  readonly state: ResourceState;
}

interface ResolvedFileProjection {
  readonly role: WindowsRuntimeFileProjection["role"];
  readonly backend: WindowsNativeBackendResource;
  readonly destination: string;
  readonly state: ResourceState;
}

const resourceStates = new WeakMap<object, ResourceState>();
const backendTokenStates = new WeakMap<
  WindowsNativeBackendResource,
  ResourceState
>();

/** Handle-admitted regular file scoped to its issuing authority instance. */
export interface WindowsAdmittedFile extends WindowsAdmittedFileObservation {
  /** Close the retained handle once and make the capability unusable. */
  close(): Promise<Result<void, WindowsNativeAuthorityError>>;
}

/** Handle-admitted directory scoped to its issuing authority instance. */
export interface WindowsAdmittedDirectory
  extends WindowsAdmittedDirectoryObservation {
  /** Close the retained handle once and make the capability unusable. */
  close(): Promise<Result<void, WindowsNativeAuthorityError>>;
}

/** Private runtime root scoped to its issuing authority instance. */
export interface WindowsPrivateRoot extends WindowsPrivateRootObservation {
  /** Close the retained root authority once and reject later use. */
  close(): Promise<Result<void, WindowsNativeAuthorityError>>;
}

/** Opaque owned process with bounded output and kill-on-close lifetime. */
export interface WindowsOwnedProcess {
  /** Provider-neutral process identifier retained for diagnostics only. */
  readonly processId: number;

  /** Parsed Job Object policy associated atomically with process creation. */
  readonly ownership: WindowsJobOwnershipObservation;

  /** Read the latest detached, bounded output and exit observation. */
  snapshot(): WindowsOwnedProcessSnapshot;

  /** Wait for exit; cancellation stops only this wait and never closes the job. */
  waitForExit(
    signal?: AbortSignal,
  ): Promise<Result<WindowsOwnedProcessExit, WindowsNativeAuthorityError>>;

  /** Close the Job Object once and observe whether it terminated processes. */
  close(): Promise<
    Result<WindowsOwnedProcessClose, WindowsNativeAuthorityError>
  >;
}

/** Input for creating one private child beneath an admitted directory. */
export interface WindowsPrivateRootInput extends WindowsNativeOperationControl {
  readonly parent: WindowsAdmittedDirectory;
  readonly prefix: string;
  readonly trees: readonly WindowsRuntimeTreeProjection[];
  readonly files: readonly WindowsRuntimeFileProjection[];
  readonly writableDirectories: readonly string[];
  readonly entrypoint: Readonly<{
    readonly treeRole: "jdk";
    readonly relativePath: string;
  }>;
  readonly launch: Readonly<{
    readonly arguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }>;
  readonly limits: WindowsRuntimeProjectionLimits;
}

/** Input for native process creation already assigned to its Job Object. */
export interface WindowsOwnedProcessInput
  extends WindowsNativeOperationControl {
  readonly runtimeProjection: WindowsPrivateRoot;
  readonly limits: WindowsOwnedProcessLimits;
}

const parseAdmittedObservation = <
  TObservation extends Omit<
    WindowsAdmittedPathObservation<"file" | "directory">,
    "stableIdentity"
  >,
>(
  schema: z.ZodType<TObservation>,
  value: unknown,
  requestedPath: string,
): Result<
  TObservation & { readonly stableIdentity: string },
  WindowsNativeAuthorityError
> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.requestedPath !== requestedPath)
    return malformedAdmissionObservation();
  return ok({
    ...parsed.data,
    stableIdentity: stablePathIdentity(parsed.data),
  });
};

const parsePrivateRootObservation = (
  value: unknown,
): Result<WindowsPrivateRootObservation, WindowsNativeAuthorityError> => {
  const parsed = privateRootObservationSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.fileCount !==
      parsed.data.security.readonlyFiles.verifiedObjectCount +
        parsed.data.security.writableFiles.verifiedObjectCount ||
    parsed.data.directoryCount !==
      1 +
        parsed.data.security.readonlyDirectories.verifiedObjectCount +
        parsed.data.security.writableDirectories.verifiedObjectCount ||
    parsed.data.security.manifestSha256 !==
      privateSecurityManifestSha256(
        parsed.data.manifestSha256,
        parsed.data.launchSha256,
        parsed.data.security,
      )
  )
    return err(
      new WindowsNativeAuthorityError(
        "create_private_root",
        "native_contract_mismatch",
        "Windows native adapter returned an invalid private DACL observation",
      ),
    );
  return ok(parsed.data);
};

const privateSecurityManifestSha256 = (
  projectionManifestSha256: string,
  launchSha256: string,
  security: Omit<WindowsPrivateRootSecurityObservation, "manifestSha256">,
): string => {
  const commitment = {
    version: 1,
    projectionManifestSha256,
    launchSha256,
    rootDirectory: policyCommitment(security.rootDirectory),
    readonlyDirectories: policyCommitment(security.readonlyDirectories),
    readonlyFiles: policyCommitment(security.readonlyFiles),
    writableDirectories: policyCommitment(security.writableDirectories),
    writableFiles: policyCommitment(security.writableFiles),
  };
  return createHash("sha256").update(JSON.stringify(commitment)).digest("hex");
};

const policyCommitment = (policy: WindowsPrivateDaclObservation) => ({
  verifiedObjectCount: policy.verifiedObjectCount,
  policyManifestSha256: policy.policyManifestSha256,
});

const jobOwnershipPolicySha256 = (
  ownership: Omit<WindowsJobOwnershipObservation, "policySha256">,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        jobObject: ownership.jobObject,
        assignment: ownership.assignment,
        processExecution: ownership.processExecution,
        killOnJobClose: ownership.killOnJobClose,
        breakaway: ownership.breakaway,
        nestedJob: ownership.nestedJob,
        ownerHandle: ownership.ownerHandle,
        jobHandleOwnership: ownership.jobHandleOwnership,
        inheritedHandles: ownership.inheritedHandles,
        membership: ownership.membership,
      }),
    )
    .digest("hex");

const stablePathIdentity = (identity: {
  readonly filesystem: "ntfs";
  readonly volumeIdentity: string;
  readonly fileIdentity: string;
}): string =>
  `${identity.filesystem}:${identity.volumeIdentity}:${identity.fileIdentity}`;

const malformedAdmissionObservation = <T>(): Result<
  T,
  WindowsNativeAuthorityError
> =>
  err(
    new WindowsNativeAuthorityError(
      "admit_path",
      "native_contract_mismatch",
      "Windows native adapter returned an invalid path identity observation",
    ),
  );

const completePathAdmission = async <
  TObservation extends Omit<
    WindowsAdmittedPathObservation<"file" | "directory">,
    "stableIdentity"
  >,
>(
  input: Readonly<{
    authority: WindowsNativeAuthority;
    admitted: Result<
      WindowsNativeAdmittedFile | WindowsNativeAdmittedDirectory,
      WindowsNativeAuthorityError
    >;
    schema: z.ZodType<TObservation>;
    requestedPath: string;
  }>,
): Promise<
  Result<
    TObservation & {
      readonly stableIdentity: string;
      close(): Promise<Result<void, WindowsNativeAuthorityError>>;
    },
    WindowsNativeAuthorityError
  >
> => {
  const admitted = input.admitted;
  if (!admitted.ok) return admitted;
  const observation = parseAdmittedObservation(
    input.schema,
    admitted.value.observation,
    input.requestedPath,
  );
  if (!observation.ok) {
    await poisonAliasedToken(admitted.value.resource, () =>
      admitted.value.resource.close(),
    );
    return observation;
  }
  const resource = createResource({
    authority: input.authority,
    operation: "admit_path",
    kind: observation.value.kind,
    observation: observation.value,
    backend: admitted.value.resource,
  });
  if (!resource.ok)
    await poisonAliasedToken(admitted.value.resource, () =>
      admitted.value.resource.close(),
    );
  return resource;
};

/** Application-owned authority wrapper that scopes every native resource. */
export class WindowsNativeAuthority {
  constructor(readonly backend: WindowsNativeAuthorityBackend) {}

  /** Loaded native contract identity after package validation. */
  get identity(): WindowsNativeAuthorityIdentity | null {
    return this.backend.identity;
  }

  /** Admit one file or directory without following a reparse point. */
  admitPath(
    input: WindowsPathAdmissionInput<"file">,
  ): Promise<Result<WindowsAdmittedFile, WindowsNativeAuthorityError>>;
  admitPath(
    input: WindowsPathAdmissionInput<"directory">,
  ): Promise<Result<WindowsAdmittedDirectory, WindowsNativeAuthorityError>>;
  async admitPath(
    input: WindowsPathAdmissionInput,
  ): Promise<
    Result<
      WindowsAdmittedFile | WindowsAdmittedDirectory,
      WindowsNativeAuthorityError
    >
  > {
    const admissionInput: WindowsPathAdmissionInput = {
      path: input.path,
      kind: input.kind,
      reparsePolicy: input.reparsePolicy,
      deadlineMs: input.deadlineMs,
      ...(input.expectedSha256 === undefined
        ? {}
        : { expectedSha256: input.expectedSha256 }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };

    if (input.kind === "file") {
      return completePathAdmission({
        authority: this,
        admitted: await this.backend.admitFile(
          admissionInput as WindowsPathAdmissionInput<"file">,
        ),
        schema: admittedFileObservationSchema,
        requestedPath: admissionInput.path,
      });
    }

    return completePathAdmission({
      authority: this,
      admitted: await this.backend.admitDirectory(
        admissionInput as WindowsPathAdmissionInput<"directory">,
      ),
      schema: admittedDirectoryObservationSchema,
      requestedPath: admissionInput.path,
    });
  }

  /** Create and verify a protected runtime root beneath owned authority. */
  async createPrivateRoot(
    input: WindowsPrivateRootInput,
  ): Promise<Result<WindowsPrivateRoot, WindowsNativeAuthorityError>> {
    const prefix = input.prefix;
    const writableDirectories = [...input.writableDirectories];
    const entrypoint = {
      treeRole: input.entrypoint.treeRole,
      relativePath: input.entrypoint.relativePath,
    };
    const launch = {
      arguments: [...input.launch.arguments],
      environment: { ...input.launch.environment },
    };
    const limits = {
      entries: input.limits.entries,
      depth: input.limits.depth,
      bytes: input.limits.bytes,
    };
    const controlSnapshot = control(input);

    const parent = ownedResource(
      this,
      input.parent,
      "create_private_root",
      "directory",
    );
    if (!parent.ok) return parent;

    const trees = ownedRuntimeTrees(this, input.trees);
    if (!trees.ok) return trees;

    const files = ownedRuntimeFiles(this, input.files);
    if (!files.ok) return files;

    const leases: ResourceState[] = [
      parent.value.state,
      ...trees.value.map((tree) => tree.state),
      ...files.value.map((file) => file.state),
    ];
    const leased = acquireLeases(leases, "create_private_root");
    if (!leased.ok) return leased;

    try {
      const created = await this.backend.createPrivateRoot({
        parent: parent.value.backend,
        prefix,
        trees: trees.value.map((tree) => ({
          role: tree.role,
          source: tree.backend,
          destination: tree.destination,
        })),
        files: files.value.map((file) => ({
          role: file.role,
          source: file.backend,
          destination: file.destination,
        })),
        writableDirectories,
        entrypoint,
        launch,
        limits,
        control: controlSnapshot,
      });
      if (!created.ok) return created;
      const observation = parsePrivateRootObservation(
        created.value.observation,
      );
      if (!observation.ok) {
        await poisonAliasedToken(created.value.resource, () =>
          created.value.resource.close(),
        );
        return observation;
      }
      const resource = createResource({
        authority: this,
        operation: "create_private_root",
        kind: "privateRoot",
        observation: observation.value,
        backend: created.value.resource,
      });
      if (!resource.ok)
        await poisonAliasedToken(created.value.resource, () =>
          created.value.resource.close(),
        );
      return resource;
    } finally {
      releaseLeases(leases);
    }
  }

  /** Spawn a process atomically assigned to a dedicated kill-on-close job. */
  async spawnOwnedProcess(
    input: WindowsOwnedProcessInput,
  ): Promise<Result<WindowsOwnedProcess, WindowsNativeAuthorityError>> {
    const limits = {
      stdoutBytes: input.limits.stdoutBytes,
      stderrBytes: input.limits.stderrBytes,
    };
    const controlSnapshot = control(input);

    const runtimeProjection = ownedResource(
      this,
      input.runtimeProjection,
      "spawn_owned_process",
      "privateRoot",
    );
    if (!runtimeProjection.ok) return runtimeProjection;

    const leases: ResourceState[] = [runtimeProjection.value.state];
    const leased = acquireLeases(leases, "spawn_owned_process");
    if (!leased.ok) return leased;

    try {
      const spawned = await this.backend.spawnOwnedProcess({
        runtimeProjection: runtimeProjection.value.backend,
        limits,
        control: controlSnapshot,
      });
      if (!spawned.ok) return spawned;
      const process = createOwnedProcess(this, spawned.value, limits);
      if (!process.ok)
        await poisonAliasedToken(spawned.value, async () => {
          await spawned.value.closeProcess();
        });
      return process;
    } finally {
      releaseLeases(leases);
    }
  }
}

const registerBackend = (
  input: Readonly<{
    authority: WindowsNativeAuthority;
    kind: ResourceKind;
    backend: WindowsNativeBackendResource;
    operation: WindowsNativeAuthorityOperation;
    closeBackend: ResourceState["closeBackend"];
  }>,
): Result<ResourceState, WindowsNativeAuthorityError> => {
  const existing = backendTokenStates.get(input.backend);
  if (existing !== undefined) {
    return err(
      new WindowsNativeAuthorityError(
        input.operation,
        "native_contract_mismatch",
        existing.kind === input.kind
          ? "Windows native backend token is already registered"
          : "Windows native backend token is registered with a different kind",
      ),
    );
  }

  const state: ResourceState = {
    owner: input.authority,
    backend: input.backend,
    closeBackend: input.closeBackend,
    kind: input.kind,
    status: "open",
    leaseCount: 0,
  };
  backendTokenStates.set(input.backend, state);
  return ok(state);
};

const poisonAliasedToken = async (
  backend: WindowsNativeBackendResource,
  cleanup: () => Promise<unknown>,
): Promise<void> => {
  const existing = backendTokenStates.get(backend);
  if (existing !== undefined) {
    if (existing.status === "closed") return;
    existing.status = "closing";
    if (existing.leaseCount > 0) {
      existing.closeDeferred ??= createDeferredClose();
      return;
    }
    existing.closePromise ??= safeCloseBackend(existing).then((result) => {
      existing.status = "closed";
      return result;
    });
    await existing.closePromise;
    return;
  }
  try {
    await cleanup();
  } catch {
    // The contract mismatch remains the caller-visible failure; the token is
    // poisoned even if the malformed backend also rejects cleanup.
  } finally {
    // A fresh malformed token has no wrapper state to retain.
  }
};

const safeCloseBackend = async (
  state: ResourceState,
): Promise<Result<void, WindowsNativeAuthorityError>> => {
  try {
    return await state.closeBackend();
  } catch (cause: unknown) {
    return err(
      new WindowsNativeAuthorityError(
        "close_resource",
        "native_failure",
        "Windows native resource cleanup failed",
        { cause },
      ),
    );
  }
};

const ownedResource = (
  authority: WindowsNativeAuthority,
  resource: object,
  operation: WindowsNativeAuthorityOperation,
  expectedKind: ResourceKind,
): Result<ResolvedResource, WindowsNativeAuthorityError> => {
  const state = resourceStates.get(resource);
  if (state === undefined || state.owner !== authority)
    return err(
      new WindowsNativeAuthorityError(
        operation,
        "invalid_input",
        "Windows native resource does not belong to this authority",
      ),
    );
  if (state.status !== "open")
    return err(
      new WindowsNativeAuthorityError(
        operation,
        "identity_drift",
        "Windows native resource is already closed",
      ),
    );
  if (state.kind !== expectedKind)
    return err(
      new WindowsNativeAuthorityError(
        operation,
        "native_contract_mismatch",
        `Windows native resource is not a ${expectedKind}`,
      ),
    );
  return ok({ backend: state.backend, state });
};

const ownedRuntimeTrees = (
  authority: WindowsNativeAuthority,
  trees: readonly WindowsRuntimeTreeProjection[],
): Result<readonly ResolvedTreeProjection[], WindowsNativeAuthorityError> => {
  const projected: ResolvedTreeProjection[] = [];
  for (const tree of trees) {
    const source = ownedResource(
      authority,
      tree.source,
      "create_private_root",
      "directory",
    );
    if (!source.ok) return source;
    projected.push({
      role: tree.role,
      backend: source.value.backend,
      destination: tree.destination,
      state: source.value.state,
    });
  }
  return ok(projected);
};

const ownedRuntimeFiles = (
  authority: WindowsNativeAuthority,
  files: readonly WindowsRuntimeFileProjection[],
): Result<readonly ResolvedFileProjection[], WindowsNativeAuthorityError> => {
  const projected: ResolvedFileProjection[] = [];
  for (const file of files) {
    const source = ownedResource(
      authority,
      file.source,
      "create_private_root",
      "file",
    );
    if (!source.ok) return source;
    projected.push({
      role: file.role,
      backend: source.value.backend,
      destination: file.destination,
      state: source.value.state,
    });
  }
  return ok(projected);
};

const acquireLeases = (
  states: readonly ResourceState[],
  operation: WindowsNativeAuthorityOperation,
): Result<void, WindowsNativeAuthorityError> => {
  const acquired: ResourceState[] = [];
  for (const state of states) {
    if (state.status !== "open") {
      for (const s of acquired) s.leaseCount--;
      return err(
        new WindowsNativeAuthorityError(
          operation,
          "identity_drift",
          "Windows native resource is already closed",
        ),
      );
    }
    state.leaseCount++;
    acquired.push(state);
  }
  return ok(undefined);
};

const releaseLeases = (states: readonly ResourceState[]): void => {
  for (const state of states) {
    state.leaseCount--;
    if (state.leaseCount === 0 && state.status === "closing") {
      state.closePromise = safeCloseBackend(state).then((result) => {
        state.status = "closed";
        state.closeDeferred?.resolve(result);
        return result;
      });
    }
  }
};

/** Construct a fail-closed authority backend when the package is unavailable. */
export const unavailableWindowsNativeAuthorityBackend = (
  message: string,
): WindowsNativeAuthorityBackend => ({
  identity: null,
  admitFile: () => Promise.resolve(unavailable("admit_path", message)),
  admitDirectory: () => Promise.resolve(unavailable("admit_path", message)),
  createPrivateRoot: () =>
    Promise.resolve(unavailable("create_private_root", message)),
  spawnOwnedProcess: () =>
    Promise.resolve(unavailable("spawn_owned_process", message)),
});

const createDeferredClose = (): CloseDeferred => {
  let resolve!: (value: Result<void, WindowsNativeAuthorityError>) => void;
  const promise = new Promise<Result<void, WindowsNativeAuthorityError>>(
    (res) => {
      resolve = res;
    },
  );
  return { promise, resolve };
};

const closeResource = (
  resource: object,
): Promise<Result<void, WindowsNativeAuthorityError>> => {
  const state = resourceStates.get(resource);
  if (state === undefined)
    return Promise.resolve(
      err(
        new WindowsNativeAuthorityError(
          "close_resource",
          "invalid_input",
          "Windows native resource is not owned by REA",
        ),
      ),
    );
  if (state.status === "closed")
    return state.closePromise ?? Promise.resolve(ok(undefined));
  if (state.status === "closing")
    return (
      state.closeDeferred?.promise ??
      state.closePromise ??
      Promise.resolve(ok(undefined))
    );

  state.status = "closing";
  if (state.leaseCount === 0) {
    state.closePromise = safeCloseBackend(state).then((result) => {
      state.status = "closed";
      return result;
    });
    return state.closePromise;
  }

  const deferred = createDeferredClose();
  state.closeDeferred = deferred;
  return deferred.promise;
};

const createResource = <TObservation extends object>(
  input: Readonly<{
    authority: WindowsNativeAuthority;
    operation: WindowsNativeAuthorityOperation;
    kind: Exclude<ResourceKind, "process">;
    observation: TObservation;
    backend: WindowsNativeBackendResource;
  }>,
): Result<
  TObservation & {
    close(): Promise<Result<void, WindowsNativeAuthorityError>>;
  },
  WindowsNativeAuthorityError
> => {
  const stateResult = registerBackend({
    authority: input.authority,
    kind: input.kind,
    backend: input.backend,
    operation: input.operation,
    closeBackend: () => input.backend.close(),
  });
  if (!stateResult.ok) return stateResult;
  const resource = {
    ...input.observation,
    close: () => closeResource(resource),
  } as TObservation & {
    close(): Promise<Result<void, WindowsNativeAuthorityError>>;
  };
  resourceStates.set(resource, stateResult.value);
  return ok(resource);
};

const createOwnedProcess = (
  authority: WindowsNativeAuthority,
  backend: WindowsNativeBackendProcess,
  limits: WindowsOwnedProcessLimits,
): Result<WindowsOwnedProcess, WindowsNativeAuthorityError> => {
  const ownership = jobOwnershipObservationSchema.safeParse(backend.ownership);
  if (
    !ownership.success ||
    !Number.isSafeInteger(backend.processId) ||
    backend.processId <= 0
  )
    return err(
      new WindowsNativeAuthorityError(
        "spawn_owned_process",
        "native_contract_mismatch",
        "Windows native adapter returned an invalid Job Object observation",
      ),
    );
  const ownershipObservation: WindowsJobOwnershipObservation = {
    ...ownership.data,
    policySha256: jobOwnershipPolicySha256(ownership.data),
  };
  const stateResult = registerBackend({
    authority,
    kind: "process",
    backend,
    operation: "spawn_owned_process",
    closeBackend: () =>
      closeOwnedProcess(backend).then((result) =>
        result.ok ? ok(undefined) : result,
      ),
  });
  if (!stateResult.ok) return stateResult;
  const state = stateResult.value;

  let closePromise:
    | Promise<Result<WindowsOwnedProcessClose, WindowsNativeAuthorityError>>
    | undefined;
  const process = {
    processId: backend.processId,
    ownership: ownershipObservation,
    snapshot: () => {
      try {
        return parseProcessSnapshot(backend.snapshot(), limits);
      } catch (cause: unknown) {
        if (cause instanceof WindowsNativeAuthorityError) throw cause;
        throw new WindowsNativeAuthorityError(
          "observe_process",
          "native_failure",
          "Windows native process observation failed",
          { cause },
        );
      }
    },
    waitForExit: async (signal?: AbortSignal) => {
      try {
        const result = await backend.waitForExit(signal);
        return parseProcessResult<WindowsOwnedProcessExit>(
          result,
          ownedProcessExitSchema,
          "wait_for_exit",
        );
      } catch (cause: unknown) {
        return nativeProcessFailure<WindowsOwnedProcessExit>(
          "wait_for_exit",
          "Windows native process wait failed",
          cause,
        );
      }
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      state.status = "closing";
      closePromise = closeOwnedProcess(backend).then((result) => {
        state.status = "closed";
        return result;
      });
      return closePromise;
    },
  };
  resourceStates.set(process, state);
  return ok(process);
};

const parseProcessSnapshot = (
  value: unknown,
  limits: WindowsOwnedProcessLimits,
): WindowsOwnedProcessSnapshot => {
  const parsed = ownedProcessSnapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    !validStreamSnapshot(parsed.data.stdout, limits.stdoutBytes) ||
    !validStreamSnapshot(parsed.data.stderr, limits.stderrBytes)
  )
    throw new WindowsNativeAuthorityError(
      "observe_process",
      "native_contract_mismatch",
      "Windows native adapter returned an invalid process snapshot",
    );
  return parsed.data;
};

const validStreamSnapshot = (
  stream: WindowsOwnedProcessStreamSnapshot,
  retainedLimit: number,
): boolean =>
  Number.isSafeInteger(stream.totalBytes) &&
  stream.retained.byteLength <= retainedLimit &&
  stream.retained.byteLength <= stream.totalBytes &&
  stream.truncated === stream.totalBytes > stream.retained.byteLength;

const parseProcessResult = <T>(
  value: unknown,
  successSchema: z.ZodType<T>,
  operation: "wait_for_exit" | "close_resource",
): Result<T, WindowsNativeAuthorityError> => {
  if (typeof value !== "object" || value === null || !("ok" in value))
    return malformedProcessResult(operation);
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.ok === true) {
    if (Object.keys(candidate).length !== 2 || !("value" in candidate))
      return malformedProcessResult(operation);
    const parsed = successSchema.safeParse(candidate.value);
    return parsed.success ? ok(parsed.data) : malformedProcessResult(operation);
  }
  if (
    candidate.ok !== false ||
    Object.keys(candidate).length !== 2 ||
    !(candidate.error instanceof WindowsNativeAuthorityError)
  )
    return malformedProcessResult(operation);
  return err(candidate.error);
};

const malformedProcessResult = <T>(
  operation: "wait_for_exit" | "close_resource",
): Result<T, WindowsNativeAuthorityError> =>
  err(
    new WindowsNativeAuthorityError(
      operation,
      "native_contract_mismatch",
      "Windows native adapter returned an invalid process result",
    ),
  );

const nativeProcessFailure = <T>(
  operation: "wait_for_exit" | "close_resource",
  message: string,
  cause: unknown,
): Result<T, WindowsNativeAuthorityError> =>
  err(
    new WindowsNativeAuthorityError(operation, "native_failure", message, {
      cause,
    }),
  );

const closeOwnedProcess = async (
  backend: WindowsNativeBackendProcess,
): Promise<Result<WindowsOwnedProcessClose, WindowsNativeAuthorityError>> => {
  try {
    return parseProcessResult<WindowsOwnedProcessClose>(
      await backend.closeProcess(),
      ownedProcessCloseSchema,
      "close_resource",
    );
  } catch (cause: unknown) {
    return nativeProcessFailure<WindowsOwnedProcessClose>(
      "close_resource",
      "Windows native process cleanup failed",
      cause,
    );
  }
};

const control = (
  input: WindowsNativeOperationControl,
): WindowsNativeOperationControl => ({
  deadlineMs: input.deadlineMs,
  ...(input.signal === undefined ? {} : { signal: input.signal }),
});

const unavailable = <T>(
  operation: WindowsNativeAuthorityOperation,
  message: string,
): Result<T, WindowsNativeAuthorityError> =>
  err(new WindowsNativeAuthorityError(operation, "unavailable", message));
