struct Envelope {
  private enum State {
    case ready
    @inline(never) func describe() -> Int { 42 }
  }

  private class Hidden {
    @inline(never) func value() -> Int { 7 }
  }

  @inline(never) func value() -> Int {
    State.ready.describe() + Hidden().value()
  }
}

final class Holder {
  private struct Item {
    let value: Int
    @inline(never) func doubled() -> Int { value * 2 }
  }

  private func secret() -> Int { 1 }

  @inline(never) func value() -> Int {
    secret() + Item(value: 2).doubled()
  }
}

@main
struct PrivateNestedTypes {
  static func main() { print(Envelope().value() + Holder().value()) }
}
