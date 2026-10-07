import Foundation

let zero = captureChildCount(status: 0, success: 0, value: 0)
precondition(zero.value == 0, "A successful empty child list must remain a known zero")
precondition(zero.error == nil, "A successful child count must not report an error")

let failedCount = captureChildCount(status: -25204, success: 0, value: 0)
precondition(failedCount.value == nil, "A failed count must not be reported as zero")
precondition(failedCount.error == -25204, "A failed count must retain its AX error")

let slashRich = try! serializeHelperOutput([
  "ok": true,
  "result": [
    "control": "\u{0001}",
    "slash": String(repeating: "/", count: 4096),
    "unicode": "café 😀\u{2028}",
  ],
])
FileHandle.standardOutput.write(slashRich)
FileHandle.standardOutput.write(Data("\n".utf8))

let failed: ChildBatch<Int> = captureChildValues(requestedCount: 2) { nil }
precondition(failed.values.isEmpty, "AX retrieval failure must return no values")
precondition(!failed.complete, "AX retrieval failure must mark traversal incomplete")

let short = captureChildValues(requestedCount: 3) { [10, 20] }
precondition(short.values == [10, 20], "Short retrieval must preserve returned children")
precondition(!short.complete, "Short retrieval must mark traversal incomplete")
var visited: [Int] = []
for (index, value) in short.values.enumerated() {
  visited.append(index * 10 + value)
}
precondition(visited == [10, 30], "Traversal must use actual returned indices")

let complete = captureChildValues(requestedCount: 2) { [10, 20, 30] }
precondition(complete.values == [10, 20], "Retrieval must respect the requested node budget")
precondition(complete.complete, "A full bounded result must remain complete")

print("Native UI child retrieval and serialization seams passed")
