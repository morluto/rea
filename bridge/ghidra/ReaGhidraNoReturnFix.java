import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.FlowType;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * Undo wrong no-return flags from auto-analysis. A function flagged no-return that contains a
 * real RET is an ordinary function (stream readers, cxa_guard_acquire, ...). Callers treated the
 * call as a terminator and the decompiler truncated them. Clear the flag, then re-disassemble the
 * call sites that were terminators and rebuild their owning functions.
 */
public final class ReaGhidraNoReturnFix extends GhidraScript {
  @Override
  public void run() throws Exception {
    FunctionManager fm = currentProgram.getFunctionManager();
    Listing li = currentProgram.getListing();
    int cleared = 0;
    for (Function f : fm.getFunctions(true)) {
      monitor.checkCancelled();
      if (!f.hasNoReturn()) continue;
      for (Instruction ins : li.getInstructions(f.getBody(), true)) {
        FlowType ft = ins.getFlowType();
        if (ft.isTerminal() && !ft.isJump() && !ft.isCall()) {
          f.setNoReturn(false);
          cleared++;
          break;
        }
      }
    }
    if (cleared == 0) return;
    List<Address> sites = new ArrayList<>();
    for (Instruction ins : li.getInstructions(true)) {
      monitor.checkCancelled();
      FlowType ft = ins.getFlowType();
      if (!(ft.isCall() && ft.isTerminal())) continue;
      Address[] flows = ins.getFlows();
      if (flows.length == 0) continue;
      Function callee = fm.getFunctionAt(flows[0]);
      if (callee != null && !callee.hasNoReturn()) sites.add(ins.getAddress());
    }
    TreeSet<Address> owners = new TreeSet<>();
    for (Address s : sites) {
      Instruction ins = li.getInstructionAt(s);
      if (ins == null) continue;
      Function owner = fm.getFunctionContaining(s);
      if (owner != null) owners.add(owner.getEntryPoint());
      clearListing(ins.getMinAddress(), ins.getMaxAddress());
      disassemble(s);
    }
    for (Address e : owners) {
      monitor.checkCancelled();
      Function f = fm.getFunctionAt(e);
      if (f != null) removeFunction(f);
      createFunction(e, null);
    }
    println("REA no-return fix: cleared=" + cleared + " sites=" + sites.size() + " rebuilt=" + owners.size());
  }
}
