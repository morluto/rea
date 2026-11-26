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

    var openingSizeQueries = 0
    let failedOpeningTokens = readRunTokens(pids: [42, 43]) { _, output, size in
      if let output = output {
        output.assumingMemoryBound(to: kinfo_proc.self).pointee.kp_proc.p_pid = 42
        size = MemoryLayout<kinfo_proc>.stride
        return 0
      }
      openingSizeQueries += 1
      if openingSizeQueries == 1 {
        errno = EACCES
        return -1
      }
      size = MemoryLayout<kinfo_proc>.stride
      return 0
    }
    let absentTokens = readRunTokens(pids: [42]) { _, output, size in
      size = output == nil ? MemoryLayout<kinfo_proc>.stride : 0
      return 0
    }

    let ownPid = getpid()
    func observeToken(
      confirmationError: Int32? = nil,
      changeConfirmation: (UnsafeMutablePointer<kinfo_proc>) -> Void = { _ in }
    ) -> [RunTokenObservation] {
      var sizeQueries = 0
      return readRunTokens(pids: [ownPid]) { _, output, size in
        size = MemoryLayout<kinfo_proc>.stride
        guard let output else {
          sizeQueries += 1
          if sizeQueries == 2, let confirmationError {
            errno = confirmationError
            return -1
          }
          return 0
        }
        let process = output.assumingMemoryBound(to: kinfo_proc.self)
        process.pointee.kp_proc.p_pid = ownPid
        process.pointee.kp_proc.p_flag = P_LP64
        if sizeQueries == 2 { changeConfirmation(process) }
        return 0
      }
    }
    let confirmedTokens = observeToken()
    let refusedConfirmations = [
      "failed": observeToken(confirmationError: EIO),
      "changedGeneration": observeToken { $0.pointee.kp_proc.p_starttime.tv_usec = 1 },
      "changedPointerWidth": observeToken { $0.pointee.kp_proc.p_flag = 0 },
    ].mapValues { tokens in
      tokens.map { ["state": $0.state, "reason": $0.reason ?? "", "tokenPresent": $0.run_id != nil] }
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

    let output: [String: Any] = [
      "retriedAfterFreshSize": retried.failure == nil && sizeQueries == 2 && readAttempts == 2,
      "preservedOtherErrno": otherError.failure == "process_table_failed_\(EACCES)",
      "openingRunTokenSnapshotReads": openingSizeQueries,
      "failedOpeningRunTokens": failedOpeningTokens.map { ["pid": $0.pid, "state": $0.state, "reason": $0.reason ?? ""] },
      "absentRunTokens": absentTokens.map { ["pid": $0.pid, "state": $0.state, "reason": $0.reason ?? ""] },
      "refusedConfirmations": refusedConfirmations,
      "confirmedRunTokens": confirmedTokens.map { ["state": $0.state, "matchesFixtureToken": $0.run_id == "rea-snapshot-probe"] },
      "successfulSnapshotMissingPidIsAbsent": absentIdentities.first?.state == "absent" && absentIdentities.first?.reason == "not-in-snapshot",
      "failedSnapshotMissingPidIsUnavailable": failedIdentities.first?.state == "unavailable" && failedIdentities.first?.reason == "process_table_failed_13",
      "invalidPidIsUnavailable": invalidIdentity.first?.state == "unavailable" && invalidIdentity.first?.reason == "invalid_process_id",
      "zombieLifecycleIsSeparateFromIdentity": zombieIdentity.first?.state == "readable" && zombieIdentity.first?.identity == "start:42" && zombieIdentity.first?.lifecycle == "zombie",
      "effectiveUidComesFromNativeIdentity": zombieIdentity.first?.effective_uid == 501,
      "nativeRelationIsSeparateFromIdentity": zombieIdentity.first?.relation?.parent_pid == 7 && zombieIdentity.first?.relation?.process_group_id == 9,
      "nativeNameIsSeparateFromIdentity": zombieIdentity.first?.name == "probe-name" && absentIdentities.first?.name == nil && failedIdentities.first?.name == nil
    ]
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
  }
}
