import Foundation

func fixture(
  arguments: [String],
  environment: [String],
  pointerSize: Int = 8,
  executablePath: String = "/fixture/executable",
  appleRecords: [String] = ["pfz=synthetic"],
  zeroedPfz: Bool = false
) -> [UInt8] {
  var bytes = withUnsafeBytes(of: Int32(arguments.count).littleEndian, Array.init)
  let pathBytes = Array(executablePath.utf8)
  bytes.append(contentsOf: pathBytes + [0])
  let prefixLength = Array("executable_path=".utf8).count
  let padding = (pointerSize - ((prefixLength + pathBytes.count + 1) % pointerSize)) % pointerSize
  bytes.append(contentsOf: repeatElement(UInt8(0), count: padding))
  for argument in arguments { bytes.append(contentsOf: Array(argument.utf8) + [0]) }
  for entry in environment { bytes.append(contentsOf: Array(entry.utf8) + [0]) }
  if zeroedPfz {
    bytes.append(contentsOf: repeatElement(UInt8(0), count: Array("pfz=synthetic".utf8).count + 1))
  }
  for record in appleRecords { bytes.append(contentsOf: Array(record.utf8) + [0]) }
  return bytes
}

@main
struct ProcessRunTokenParserProbe {
  static func main() throws {
    let argvDecoy = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable", "REA_PROCESS_RUN_ID=argv-decoy", "trailing"],
      environment: ["DECOY=words REA_PROCESS_RUN_ID=synthetic-decoy"]
    ))
    let realToken = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable"],
      environment: ["DECOY=words REA_PROCESS_RUN_ID=synthetic-decoy", "REA_PROCESS_RUN_ID=owned-token"]
    ))
    let readableNoToken = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable"],
      environment: ["PATH=/usr/bin"]
    ))
    let emptyLaterArgument = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable", "", "after-empty"],
      environment: ["REA_PROCESS_RUN_ID=empty-argument-token"],
      pointerSize: 8
    ))
    let alternatePadding = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable", "argument"],
      environment: ["REA_PROCESS_RUN_ID=alternate-padding-token"],
      pointerSize: 4
    ), pointerSize: 4)
    let emptyArgv0Read = try parseProcessEnvironment(in: fixture(
      arguments: ["", "", "after-empty"],
      environment: ["REA_PROCESS_RUN_ID=empty-argv0-token"],
      pointerSize: 8
    ))
    let finalAssignmentArgumentRead = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable", "FOO=bar"],
      environment: ["REA_PROCESS_RUN_ID=final-assignment-token"]
    ))
    let reservedArgumentIgnored = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable", "REA_PROCESS_RUN_ID=argv-decoy"],
      environment: ["DECOY=words REA_PROCESS_RUN_ID=synthetic-decoy"]
    ))
    let nonAsciiPathRead = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/é", "FOO=bar"],
      environment: ["REA_PROCESS_RUN_ID=utf8-path-token"],
      pointerSize: 8,
      executablePath: "/fixture/é"
    ))
    let appleVectorTokenFailsClosed: Bool
    do {
      _ = try parseProcessEnvironment(in: fixture(
        arguments: ["/fixture/executable"],
        environment: ["pfz=user-value", "PATH=/usr/bin"],
        appleRecords: ["pfz=synthetic", "REA_PROCESS_RUN_ID=apple-decoy"]
      ))
      appleVectorTokenFailsClosed = false
    } catch RunTokenReadError.ambiguousEnvironmentBoundary {
      appleVectorTokenFailsClosed = true
    }
    let clearedAppleVectorTokenFailsClosed: Bool
    do {
      _ = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable"],
      environment: ["REA_PROCESS_RUN_ID=cleared-pfz-owned-token"],
      appleRecords: ["REA_PROCESS_RUN_ID=apple-decoy"],
      zeroedPfz: true
      ))
      clearedAppleVectorTokenFailsClosed = false
    } catch RunTokenReadError.ambiguousEnvironmentBoundary {
      clearedAppleVectorTokenFailsClosed = true
    }
    let callerPfzBeforeTokenRead = try parseProcessEnvironment(in: fixture(
      arguments: ["/fixture/executable"],
      environment: ["pfz=caller-value", "REA_PROCESS_RUN_ID=cleared-pfz-owned-token"],
      zeroedPfz: true
    ))
    let emptyEnvironmentRecordsBeforeTokenFailClosed: Bool
    do {
      _ = try parseProcessEnvironment(in: fixture(
        arguments: ["/fixture/executable"],
        environment: ["DECOY=value", "", "", "REA_PROCESS_RUN_ID=synthetic-decoy"],
        appleRecords: [],
        zeroedPfz: true
      ))
      emptyEnvironmentRecordsBeforeTokenFailClosed = false
    } catch RunTokenReadError.ambiguousEnvironmentBoundary {
      emptyEnvironmentRecordsBeforeTokenFailClosed = true
    }
    let zeroArgumentsRead = try parseProcessEnvironment(in: fixture(
      arguments: [],
      environment: ["REA_PROCESS_RUN_ID=zero-argc-token"],
      pointerSize: 4
    ), pointerSize: 4)
    var truncatedArgv = withUnsafeBytes(of: Int32(2).littleEndian, Array.init)
    let truncatedPath = Array("/fixture/executable".utf8)
    truncatedArgv.append(contentsOf: truncatedPath + [0])
    let truncatedPadding = (8 - ((Array("executable_path=".utf8).count + truncatedPath.count + 1) % 8)) % 8
    truncatedArgv.append(contentsOf: repeatElement(UInt8(0), count: truncatedPadding))
    truncatedArgv.append(contentsOf: Array("/fixture/executable".utf8) + [0])
    truncatedArgv.append(contentsOf: Array("REA_PROCESS_RUN_ID=synthetic-decoy".utf8))
    let truncatedArgvFailsClosed: Bool
    do {
      _ = try parseProcessEnvironment(in: truncatedArgv)
      truncatedArgvFailsClosed = false
    } catch RunTokenReadError.invalidBuffer {
      truncatedArgvFailsClosed = true
    }
    var invalidPadding = fixture(arguments: ["x"], environment: [], executablePath: "x")
    invalidPadding[6] = 1 // argc (4 bytes), path and its NUL precede the padding.
    var unterminated = fixture(arguments: ["x"], environment: [], executablePath: "x")
    unterminated.removeLast()
    let malformedBuffers: [[UInt8]] = [
      [0, 0, 0], // Short argc.
      [255, 255, 255, 255], // Negative argc.
      [0, 0, 0, 0, 120], // Unterminated executable path.
      invalidPadding,
      unterminated,
    ]
    let malformedBuffersRejected = malformedBuffers.allSatisfy { bytes in
      do {
        _ = try parseProcessEnvironment(in: bytes)
        return false
      } catch RunTokenReadError.invalidBuffer {
        return true
      } catch {
        return false
      }
    }
    let malformedObservation = processRunTokenObservation(
      pid: 1,
      parse: .failure(.invalidBuffer),
      codeSigningFlags: { 0 }
    )
    let duplicateTokenFailsClosed: Bool
    do {
      _ = try parseProcessEnvironment(in: fixture(
        arguments: ["/fixture/executable"],
        environment: ["REA_PROCESS_RUN_ID=first", "REA_PROCESS_RUN_ID=second"]
      ))
      duplicateTokenFailsClosed = false
    } catch RunTokenReadError.duplicateToken {
      duplicateTokenFailsClosed = true
    }
    let missingAppleBoundaryFailsClosed: Bool
    do {
      _ = try parseProcessEnvironment(in: fixture(
        arguments: ["/fixture/executable"],
        environment: ["REA_PROCESS_RUN_ID=synthetic-decoy"],
        appleRecords: []
      ))
      missingAppleBoundaryFailsClosed = false
    } catch RunTokenReadError.appleVectorUnavailable {
      missingAppleBoundaryFailsClosed = true
    }

    let restrictedReadableNoToken = processRunTokenObservation(
      pid: 1,
      parse: .success(readableNoToken),
      codeSigningFlags: { 0x0000_0800 }
    )
    let restrictedEmptyEnvironment = processRunTokenObservation(
      pid: 1,
      parse: .success(try parseProcessEnvironment(in: fixture(
        arguments: ["/fixture/executable"],
        environment: []
      ))),
      codeSigningFlags: { 0x0000_0800 }
    )
    let platformEmptyEnvironment = processRunTokenObservation(
      pid: 1,
      parse: .success(try parseProcessEnvironment(in: fixture(
        arguments: ["/fixture/executable"],
        environment: []
      ))),
      codeSigningFlags: { 0x0400_0000 }
    )
    let restrictedUnavailableEnvironment = processRunTokenObservation(
      pid: 1,
      parse: .failure(.environmentUnavailable),
      codeSigningFlags: { 0x0000_0800 }
    )
    let restrictedAmbiguousEnvironment = processRunTokenObservation(
      pid: 1,
      parse: .failure(.ambiguousEnvironmentBoundary),
      codeSigningFlags: { 0x0000_0800 }
    )
    let ordinaryAmbiguousEnvironment = processRunTokenObservation(
      pid: 1,
      parse: .failure(.ambiguousEnvironmentBoundary),
      codeSigningFlags: { 0 }
    )
    let ordinaryUnavailableEnvironment = processRunTokenObservation(
      pid: 1,
      parse: .failure(.environmentUnavailable),
      codeSigningFlags: { 0 }
    )

    let result: [String: Any] = [
      "argvDecoyIgnored": argvDecoy.runId == nil && argvDecoy.environmentEntryCount == 1,
      "realTokenRead": realToken.runId == "owned-token",
      "readableEnvironmentWithoutToken": [
        "runId": readableNoToken.runId as Any? ?? NSNull(),
        "environmentEntryCount": readableNoToken.environmentEntryCount,
      ],
      "restrictedReadableEnvironmentWithoutToken": [
        "state": restrictedReadableNoToken.state,
        "reason": restrictedReadableNoToken.reason as Any? ?? NSNull(),
      ],
      "restrictedEmptyEnvironment": [
        "state": restrictedEmptyEnvironment.state,
        "reason": restrictedEmptyEnvironment.reason as Any? ?? NSNull(),
      ],
      "platformEmptyEnvironment": [
        "state": platformEmptyEnvironment.state,
        "reason": platformEmptyEnvironment.reason as Any? ?? NSNull(),
      ],
      "restrictedUnavailableEnvironment": [
        "state": restrictedUnavailableEnvironment.state,
        "reason": restrictedUnavailableEnvironment.reason as Any? ?? NSNull(),
      ],
      "restrictedAmbiguousEnvironment": [
        "state": restrictedAmbiguousEnvironment.state,
        "reason": restrictedAmbiguousEnvironment.reason as Any? ?? NSNull(),
      ],
      "ordinaryAmbiguousEnvironment": [
        "state": ordinaryAmbiguousEnvironment.state,
        "reason": ordinaryAmbiguousEnvironment.reason as Any? ?? NSNull(),
      ],
      "ordinaryUnavailableEnvironment": [
        "state": ordinaryUnavailableEnvironment.state,
        "reason": ordinaryUnavailableEnvironment.reason as Any? ?? NSNull(),
      ],
      "emptyLaterArgumentRead": emptyLaterArgument.runId == "empty-argument-token",
      "alternatePaddingRead": alternatePadding.runId == "alternate-padding-token",
      "truncatedArgvFailsClosed": truncatedArgvFailsClosed,
      "malformedBuffersRejected": malformedBuffersRejected,
      "malformedObservation": [
        "state": malformedObservation.state,
        "reason": malformedObservation.reason as Any? ?? NSNull(),
      ],
      "duplicateTokenFailsClosed": duplicateTokenFailsClosed,
      "missingAppleBoundaryFailsClosed": missingAppleBoundaryFailsClosed,
      "emptyArgv0Read": emptyArgv0Read.runId == "empty-argv0-token",
      "finalAssignmentArgumentRead": finalAssignmentArgumentRead.runId == "final-assignment-token",
      "reservedArgumentIgnored": reservedArgumentIgnored.runId == nil && reservedArgumentIgnored.environmentEntryCount == 1,
      "nonAsciiPathRead": nonAsciiPathRead.runId == "utf8-path-token",
      "appleVectorTokenFailsClosed": appleVectorTokenFailsClosed,
      "clearedAppleVectorTokenFailsClosed": clearedAppleVectorTokenFailsClosed,
      "callerPfzBeforeTokenRead": callerPfzBeforeTokenRead.runId == "cleared-pfz-owned-token",
      "emptyEnvironmentRecordsBeforeTokenFailClosed": emptyEnvironmentRecordsBeforeTokenFailClosed,
      "zeroArgumentsRead": zeroArgumentsRead.runId == "zero-argc-token",
    ]
    let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
  }
}
