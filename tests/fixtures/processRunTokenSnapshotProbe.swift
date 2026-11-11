import Darwin
import Foundation

@main
struct ProcessRunTokenSnapshotProbe {
  static func main() throws {
    var sizeQueries = 0
    var readAttempts = 0
    let retried = readProcessSnapshot { _, output, size in
      guard output != nil else {
        sizeQueries += 1
        size = MemoryLayout<kinfo_proc>.stride
        return 0
      }
      readAttempts += 1
      if readAttempts == 1 {
        errno = ENOMEM
        return -1
      }
      size = 0
      return 0
    }

    let otherError = readProcessSnapshot { _, output, size in
      if output == nil {
        size = MemoryLayout<kinfo_proc>.stride
        return 0
      }
      errno = EACCES
      return -1
    }

    let absentIdentities = readProcessIdentities(
      pids: [42],
      snapshot: ProcessSnapshot(metadata: [:], failure: nil)
    )
    let failedIdentities = readProcessIdentities(
      pids: [42],
      snapshot: ProcessSnapshot(metadata: [:], failure: "process_table_failed_13")
    )
    let invalidIdentity = readProcessIdentities(
      pids: [0],
      snapshot: ProcessSnapshot(metadata: [:], failure: nil)
    )
    let zombieIdentity = readProcessIdentities(
      pids: [42],
      snapshot: ProcessSnapshot(
        metadata: [42: ProcessMetadata(identity: "start:42", effectiveUid: 501, lifecycle: "zombie", parentPid: 7, processGroupId: 9, pointerSize: 8, name: "probe-name")],
        failure: nil
      )
    )

    let sample = ProcessMetadata(
      identity: "10:20",
      effectiveUid: 501,
      lifecycle: "non-zombie",
      parentPid: 1,
      processGroupId: 7,
      pointerSize: 8,
      name: "probe"
    )
    let replaced = ProcessMetadata(
      identity: "11:21",
      effectiveUid: 501,
      lifecycle: "non-zombie",
      parentPid: 1,
      processGroupId: 7,
      pointerSize: 8,
      name: "probe"
    )
    let readable = RunTokenObservation(pid: 7, state: "readable", run_id: "owned", reason: nil)
    var openReads = 0
    let recoveredOpening = readBracketSnapshot {
      openReads += 1
      if openReads == 1 {
        return ProcessSnapshot(metadata: [:], failure: "process_table_failed_5")
      }
      return ProcessSnapshot(metadata: [7: sample], failure: nil)
    }
    var stuckReads = 0
    let stuckOpening = readBracketSnapshot {
      stuckReads += 1
      return ProcessSnapshot(metadata: [:], failure: "process_table_failed_\(stuckReads)")
    }
    var stableReads = 0
    _ = readBracketSnapshot {
      stableReads += 1
      return ProcessSnapshot(metadata: [7: sample], failure: nil)
    }
    let failedOpening = attributedRunToken(
      pid: 7,
      observation: readable,
      before: ProcessSnapshot(metadata: [:], failure: "process_table_failed_5"),
      after: ProcessSnapshot(metadata: [7: sample], failure: nil)
    )
    let failedConfirming = attributedRunToken(
      pid: 7,
      observation: readable,
      before: ProcessSnapshot(metadata: [:], failure: nil),
      after: ProcessSnapshot(metadata: [:], failure: "process_table_failed_11")
    )
    var confirmReads = 0
    let recoveredConfirming = readBracketSnapshot {
      confirmReads += 1
      if confirmReads == 1 {
        return ProcessSnapshot(metadata: [:], failure: "process_table_failed_11")
      }
      return ProcessSnapshot(metadata: [7: sample], failure: nil)
    }
    let keptAfterReplacement = attributedRunToken(
      pid: 7,
      observation: readable,
      before: ProcessSnapshot(metadata: [7: sample], failure: nil),
      after: recoveredConfirming
    )
    let matched = attributedRunToken(
      pid: 7,
      observation: readable,
      before: ProcessSnapshot(metadata: [7: sample], failure: nil),
      after: ProcessSnapshot(metadata: [7: sample], failure: nil)
    )
    let changed = attributedRunToken(
      pid: 7,
      observation: readable,
      before: ProcessSnapshot(metadata: [7: sample], failure: nil),
      after: ProcessSnapshot(metadata: [7: replaced], failure: nil)
    )
    let missing = attributedRunToken(
      pid: 7,
      observation: readable,
      before: ProcessSnapshot(metadata: [:], failure: nil),
      after: ProcessSnapshot(metadata: [:], failure: nil)
    )
    let departed = attributedRunToken(
      pid: 7,
      observation: readable,
      before: ProcessSnapshot(metadata: [7: sample], failure: nil),
      after: ProcessSnapshot(metadata: [:], failure: nil)
    )

    let output: [String: Any] = [
      "retriedAfterFreshSize": retried.failure == nil && sizeQueries == 2 && readAttempts == 2,
      "preservedOtherErrno": otherError.failure == "process_table_failed_\(EACCES)",
      "successfulSnapshotMissingPidIsAbsent": absentIdentities.first?.state == "absent" && absentIdentities.first?.reason == "not-in-snapshot",
      "failedSnapshotMissingPidIsUnavailable": failedIdentities.first?.state == "unavailable" && failedIdentities.first?.reason == "process_table_failed_13",
      "invalidPidIsUnavailable": invalidIdentity.first?.state == "unavailable" && invalidIdentity.first?.reason == "invalid_process_id",
      "zombieLifecycleIsSeparateFromIdentity": zombieIdentity.first?.state == "readable" && zombieIdentity.first?.identity == "start:42" && zombieIdentity.first?.lifecycle == "zombie",
      "effectiveUidComesFromNativeIdentity": zombieIdentity.first?.effective_uid == 501,
      "nativeRelationIsSeparateFromIdentity": zombieIdentity.first?.relation?.parent_pid == 7 && zombieIdentity.first?.relation?.process_group_id == 9,
      "nativeNameIsSeparateFromIdentity": zombieIdentity.first?.name == "probe-name" && absentIdentities.first?.name == nil && failedIdentities.first?.name == nil,
      "bracketRetryUsesSuccessfulSnapshot": recoveredOpening.failure == nil && recoveredOpening.metadata[7]?.identity == "10:20" && openReads == 2,
      "bracketRetryReportsTheLatestFailure": stuckOpening.failure == "process_table_failed_2" && stuckReads == 2,
      "successfulBracketSnapshotIsNotReread": stableReads == 1,
      "failedOpeningSnapshotIsNotAbsence": failedOpening.state == "unavailable" && failedOpening.reason == "process_table_failed_5" && failedOpening.run_id == nil,
      "failedConfirmingSnapshotStaysUnavailable": failedConfirming.state == "unavailable" && failedConfirming.reason == "process_table_failed_11" && failedConfirming.run_id == nil,
      "replacementConfirmingSnapshotKeepsToken": keptAfterReplacement.state == "readable" && keptAfterReplacement.run_id == "owned" && confirmReads == 2,
      "matchingIdentitiesKeepTheToken": matched.state == "readable" && matched.run_id == "owned",
      "changedIdentityWithholdsTheToken": changed.state == "unavailable" && changed.reason == "process_identity_changed_during_token_read" && changed.run_id == nil,
      "successfulSnapshotsMissingPidIsAbsence": missing.state == "unavailable" && missing.reason == "process_not_in_snapshot" && missing.run_id == nil,
      "departedPidIsAbsence": departed.state == "unavailable" && departed.reason == "process_not_in_snapshot" && departed.run_id == nil
    ]
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
  }
}
