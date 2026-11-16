/**
 * Entry file of the shared provider toolkit. Production code outside
 * src/resources imports the toolkit only from here; verify:module-boundaries
 * counts any other import as an import past the entry file. Export a name
 * here when a new outside use needs it.
 */
export {
  admitAsarHeader,
  asarHeaderAdmissionFailure,
  asarHeaderAdmissionRecovery,
  createAsarHeaderSignatureProbe,
  readAsarHeader,
  resolveAsarHeaderAdmission,
} from "./AsarHeader.js";
export type {
  AsarHeaderExtents,
  FinalAsarHeaderProbeObservation,
} from "./AsarHeader.js";
export {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "./AnalysisCleanupLease.js";
export { artifactFileAdmissionFailure } from "./ArtifactFileAdmission.js";
export {
  ArtifactFileSource,
  assertArtifactFileSelectedSource,
} from "./ArtifactFileSource.js";
export { translateArtifactFailure } from "./ArtifactOperationFailure.js";
export {
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  artifactFileCompletion,
  artifactFilePrimaryFacts,
  artifactOperationCause,
  artifactParseFailure,
  artifactReadCancelledBy,
  artifactSelectedPathErrno,
  assertArtifactReadActive,
  bindArtifactFileCleanup,
  mapArtifactFileFailure,
  withArtifactFileHandle,
  withArtifactRegularFile,
} from "./ArtifactFileOperation.js";
export type { ArtifactFilePrimaryFacts } from "./ArtifactFileOperation.js";
export {
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
  artifactPrimaryCleanupLeases,
  assertProducedEntry,
  copyArtifactEntry,
  sameArtifactEntry,
  sameArtifactSourceIdentity,
} from "./ArtifactReader.js";
export { artifactReaderLimitFailure } from "./ArtifactReaderLimits.js";
export type {
  ArtifactEntry,
  ArtifactFixedLimit,
  ArtifactReader,
  ArtifactReaderFailureOptions,
  ArtifactReaderTraversal,
  ArtifactTraversalOmission,
  ArtifactTraversalOptions,
  ArtifactTraversalSink,
  CleanupFailedRead,
} from "./ArtifactReader.js";
export {
  assertArtifactSelectedSource,
  resolveArtifactSourcePath,
} from "./ArtifactSelectedSource.js";
export {
  DirectoryArtifactEntryAccessDenied,
  DirectoryArtifactReader,
  DirectoryArtifactRootFailure,
  DirectoryArtifactTraversalLimit,
} from "./DirectoryArtifactReader.js";
export type { DirectoryArtifactEntry } from "./DirectoryArtifactReader.js";
export { hostExecutableMarking } from "./hostExecutableMarking.js";
export {
  ArtifactResourceRetryFailure,
  ArtifactResourceScope,
} from "./ArtifactResourceScope.js";
export type {
  ArtifactCleanupAttempt,
  ArtifactResourceOwner,
} from "./ArtifactResourceScope.js";
export {
  imageFileSizeRemediation,
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  readerIntegrityFailure,
  regularFileSymlinkRecovery,
  stableArtifactInputFailure,
  stableArtifactInputRecovery,
} from "./StableArtifactFailure.js";
export type { RequestField } from "./StableArtifactFailure.js";
export { selectedFileTargetError } from "./RegularFileErrorProjection.js";
export { completedStableArtifactObservation } from "./StableArtifactObservation.js";
export {
  fileAccessFailureReason,
  writeTextFile,
  writeTextParts,
} from "./TextFileWrite.js";
export {
  assertStableArtifactState,
  completedStableArtifact,
  readStableArtifact,
  readStableArtifactRanges,
} from "./readStableArtifact.js";
export type {
  StableArtifactFileSystem,
  StableArtifactSnapshot,
} from "./readStableArtifact.js";
export {
  ArtifactPathRegistry,
  DestinationCaseCollisionFailure,
  DestinationPathUnrepresentableFailure,
  annotateEnglishUnicodeCaseCollisions,
  hasDestinationPath,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
export { SafeOutputTree } from "./SafeOutputTree.js";
export {
  SafeOutputTreeDestinationRefusal,
  outputDirectoryAdmissionRefusal,
} from "./SafeOutputTreeAdmission.js";
export { SafeOutputTreeCreationFailure } from "./SafeOutputTreeCreationFailure.js";
export { streamChunkToBuffer } from "./StreamBytes.js";
export { readArtifactFileChunks } from "./readArtifactFileChunks.js";
export { abortIfNeeded, digestReadableToCompletion } from "./StreamDigest.js";
export type { StreamDigest, StreamDigestObserver } from "./StreamDigest.js";
export {
  hashStableRootArtifact,
  hashStableRootArtifactHandle,
  openRootArtifact,
  releaseRootArtifact,
} from "./StableRootArtifact.js";
export {
  targetDigestChangedFailure,
  withArtifactTargetIdentity,
} from "./withArtifactTargetIdentity.js";
export {
  ZIP_READER_OPTIONS,
  ZipArtifactReader,
  decodeZipEntryText,
  zipEntryPath,
} from "./ZipArtifactReader.js";
