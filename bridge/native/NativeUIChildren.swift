struct ChildBatch<Element> {
  let values: [Element]
  let complete: Bool
}

func captureChildValues<Element>(requestedCount: Int, copy: () -> [Element]?) -> ChildBatch<Element> {
  guard requestedCount > 0 else { return ChildBatch(values: [], complete: true) }
  let returned = copy() ?? []
  let values = Array(returned.prefix(requestedCount))
  return ChildBatch(values: values, complete: values.count == requestedCount)
}
