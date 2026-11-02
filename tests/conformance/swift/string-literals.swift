@inline(never)
func consume(_ value: String) { print(value) }
@inline(never)
func copyString(_ value: String) -> String { value }
@inline(never)
func smallLiteral() { consume("SleepDisabled") }
@inline(never)
func largeLiteral() { consume("The power setting could not be changed.") }
@inline(never)
func unicodeLiterals() {
  consume("café")
  consume("Résumé of the naïve décor, written twice")
}
@inline(never)
func emptyAndControlLiterals() {
  consume("")
  consume("tab\there")
}
@inline(never)
func selectCopiedThroughLoop(_ condition: Bool) {
  // Different lengths force an AArch64 conditional select of the String pair.
  // The runtime bound retains a CFG back edge and the non-inlined identity
  // keeps a register copy between the select and the use.
  var carried = condition ? "LoopSelected" : "FallbackString"
  var index = 0
  while index < CommandLine.arguments.count {
    let copy = copyString(carried)
    consume(copy)
    carried = copy
    index += 1
  }
}
@inline(never)
func selectedJoin(_ condition: Bool) {
  let selected = condition ? "JoinSelected" : "JoinOrdinaryLong"
  let joined: String
  if condition {
    joined = selected
  } else {
    joined = "JoinOrdinary"
  }
  consume(joined)
}
@inline(never)
func selectedThenOrdinaryWrite(_ condition: Bool) {
  var value = condition ? "ClearedSelect" : "FallbackLongString"
  consume(value)
  value = "VisibleAfterWrite"
  consume(value)
}
@inline(never)
func returnedLiteral() -> String { "Holding awake" }
smallLiteral()
largeLiteral()
unicodeLiterals()
emptyAndControlLiterals()
print(returnedLiteral(), CommandLine.arguments.count)
selectCopiedThroughLoop(CommandLine.arguments.count > 1)
selectedJoin(CommandLine.arguments.count > 1)
selectedThenOrdinaryWrite(CommandLine.arguments.count > 1)
