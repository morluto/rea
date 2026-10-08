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
    let argvDecoy = try token(in: fixture(
      arguments: ["/fixture/executable", "REA_PROCESS_RUN_ID=argv-decoy", "trailing"],
      environment: ["DECOY=words REA_PROCESS_RUN_ID=synthetic-decoy"]
    ))
    let realToken = try token(in: fixture(
      arguments: ["/fixture/executable"],
      environment: ["DECOY=words REA_PROCESS_RUN_ID=synthetic-decoy", "REA_PROCESS_RUN_ID=owned-token"]
    ))
    let emptyLaterArgument = try token(in: fixture(
      arguments: ["/fixture/executable", "", "after-empty"],
      environment: ["REA_PROCESS_RUN_ID=empty-argument-token"],
      pointerSize: 8
    ))
    let alternatePadding = try token(in: fixture(
      arguments: ["/fixture/executable", "argument"],
      environment: ["REA_PROCESS_RUN_ID=alternate-padding-token"],
      pointerSize: 4
    ), pointerSize: 4)
    let emptyArgv0Read = try token(in: fixture(
      arguments: ["", "", "after-empty"],
      environment: ["REA_PROCESS_RUN_ID=empty-argv0-token"],
      pointerSize: 8
    ))
    let finalAssignmentArgumentRead = try token(in: fixture(
      arguments: ["/fixture/executable", "FOO=bar"],
      environment: ["REA_PROCESS_RUN_ID=final-assignment-token"]
    ))
    let reservedArgumentIgnored = try token(in: fixture(
      arguments: ["/fixture/executable", "REA_PROCESS_RUN_ID=argv-decoy"],
      environment: ["DECOY=words REA_PROCESS_RUN_ID=synthetic-decoy"]
    ))
    let nonAsciiPathRead = try token(in: fixture(
      arguments: ["/fixture/é", "FOO=bar"],
      environment: ["REA_PROCESS_RUN_ID=utf8-path-token"],
      pointerSize: 8,
      executablePath: "/fixture/é"
    ))
    let appleVectorTokenFailsClosed: Bool
    do {
      _ = try token(in: fixture(
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
      _ = try token(in: fixture(
      arguments: ["/fixture/executable"],
      environment: ["REA_PROCESS_RUN_ID=cleared-pfz-owned-token"],
      appleRecords: ["REA_PROCESS_RUN_ID=apple-decoy"],
      zeroedPfz: true
      ))
      clearedAppleVectorTokenFailsClosed = false
    } catch RunTokenReadError.ambiguousEnvironmentBoundary {
      clearedAppleVectorTokenFailsClosed = true
    }
    let callerPfzBeforeTokenRead = try token(in: fixture(
      arguments: ["/fixture/executable"],
      environment: ["pfz=caller-value", "REA_PROCESS_RUN_ID=cleared-pfz-owned-token"],
      zeroedPfz: true
    ))
    let emptyEnvironmentRecordsBeforeTokenFailClosed: Bool
    do {
      _ = try token(in: fixture(
        arguments: ["/fixture/executable"],
        environment: ["DECOY=value", "", "", "REA_PROCESS_RUN_ID=synthetic-decoy"],
        appleRecords: [],
        zeroedPfz: true
      ))
      emptyEnvironmentRecordsBeforeTokenFailClosed = false
    } catch RunTokenReadError.ambiguousEnvironmentBoundary {
      emptyEnvironmentRecordsBeforeTokenFailClosed = true
    }
    let zeroArgumentsRead = try token(in: fixture(
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
      _ = try token(in: truncatedArgv)
      truncatedArgvFailsClosed = false
    } catch {
      truncatedArgvFailsClosed = true
    }
    let duplicateTokenFailsClosed: Bool
    do {
      _ = try token(in: fixture(
        arguments: ["/fixture/executable"],
        environment: ["REA_PROCESS_RUN_ID=first", "REA_PROCESS_RUN_ID=second"]
      ))
      duplicateTokenFailsClosed = false
    } catch RunTokenReadError.duplicateToken {
      duplicateTokenFailsClosed = true
    }
    let emptyEnvironmentFailsClosed: Bool
    do {
      _ = try token(in: fixture(arguments: ["/fixture/executable"], environment: []))
      emptyEnvironmentFailsClosed = false
    } catch RunTokenReadError.environmentUnavailable {
      emptyEnvironmentFailsClosed = true
    }
    let missingAppleBoundaryFailsClosed: Bool
    do {
      _ = try token(in: fixture(
        arguments: ["/fixture/executable"],
        environment: ["REA_PROCESS_RUN_ID=synthetic-decoy"],
        appleRecords: []
      ))
      missingAppleBoundaryFailsClosed = false
    } catch RunTokenReadError.appleVectorUnavailable {
      missingAppleBoundaryFailsClosed = true
    }

    let result: [String: Any] = [
      "argvDecoyIgnored": argvDecoy == nil,
      "realTokenRead": realToken == "owned-token",
      "emptyLaterArgumentRead": emptyLaterArgument == "empty-argument-token",
      "alternatePaddingRead": alternatePadding == "alternate-padding-token",
      "truncatedArgvFailsClosed": truncatedArgvFailsClosed,
      "duplicateTokenFailsClosed": duplicateTokenFailsClosed,
      "emptyEnvironmentFailsClosed": emptyEnvironmentFailsClosed,
      "missingAppleBoundaryFailsClosed": missingAppleBoundaryFailsClosed,
      "emptyArgv0Read": emptyArgv0Read == "empty-argv0-token",
      "finalAssignmentArgumentRead": finalAssignmentArgumentRead == "final-assignment-token",
      "reservedArgumentIgnored": reservedArgumentIgnored == nil,
      "nonAsciiPathRead": nonAsciiPathRead == "utf8-path-token",
      "appleVectorTokenFailsClosed": appleVectorTokenFailsClosed,
      "clearedAppleVectorTokenFailsClosed": clearedAppleVectorTokenFailsClosed,
      "callerPfzBeforeTokenRead": callerPfzBeforeTokenRead == "cleared-pfz-owned-token",
      "emptyEnvironmentRecordsBeforeTokenFailClosed": emptyEnvironmentRecordsBeforeTokenFailClosed,
      "zeroArgumentsRead": zeroArgumentsRead == "zero-argc-token",
    ]
    let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
  }
}
