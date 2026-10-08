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

    let output: [String: Any] = [
      "retriedAfterFreshSize": retried.failure == nil && sizeQueries == 2 && readAttempts == 2,
      "preservedOtherErrno": otherError.failure == "process_table_failed_\(EACCES)"
    ]
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
  }
}
