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

print("Native UI child retrieval seam passed")
