import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.FlowType;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * Undo wrong no-return flags from auto-analysis. A function flagged no-return that contains a
 * real RET is an ordinary function (stream readers, cxa_guard_acquire, ...). Callers treated the
 * call as a terminator and the decompiler truncated them. Clear the flag, then re-disassemble only
 * the call sites of the functions that were cleared and refit their owning functions in place.
 */
public final class ReaGhidraNoReturnFix extends GhidraScript {
  @Override
  public void run() throws Exception {
    FunctionManager fm = currentProgram.getFunctionManager();
    Listing li = currentProgram.getListing();
    Set<Address> cleared = new HashSet<>();
    for (Function f : fm.getFunctions(true)) {
      monitor.checkCancelled();
      if (!f.hasNoReturn() || f.isThunk()) continue;
      for (Instruction ins : li.getInstructions(f.getBody(), true)) {
        FlowType ft = ins.getFlowType();
        if (ft.isTerminal() && !ft.isJump() && !ft.isCall()) {
          f.setNoReturn(false);
          cleared.add(f.getEntryPoint());
          break;
        }
      }
    }
    // A thunk inherits the flag of the function it forwards to.
    for (Function f : fm.getFunctions(true)) {
      if (!f.isThunk() || !f.hasNoReturn()) continue;
      Function target = f.getThunkedFunction(true);
      if (target != null && cleared.contains(target.getEntryPoint())) {
        f.setNoReturn(false);
        cleared.add(f.getEntryPoint());
      }
    }
    int redone = 0;
    TreeSet<Address> owners = new TreeSet<>();
    if (!cleared.isEmpty()) {
      List<Address> sites = new ArrayList<>();
      for (Instruction ins : li.getInstructions(true)) {
        monitor.checkCancelled();
        FlowType ft = ins.getFlowType();
        if (!(ft.isCall() && ft.isTerminal())) continue;
        Address[] flows = ins.getFlows();
        if (flows.length == 0 || !cleared.contains(flows[0])) continue;
        // A call that really ends the function is followed by another function or padding.
        Address next = ins.getMaxAddress().add(1);
        if (fm.getFunctionAt(next) != null || isX86Padding(next)) continue;
        sites.add(ins.getAddress());
      }
      for (Address s : sites) {
        monitor.checkCancelled();
        Instruction ins = li.getInstructionAt(s);
        if (ins == null) continue;
        Function owner = fm.getFunctionContaining(s);
        if (owner != null && !owner.isThunk()) owners.add(owner.getEntryPoint());
        clearListing(ins.getMinAddress(), ins.getMaxAddress());
        disassemble(s);
        redone++;
      }
      for (Address e : owners) {
        monitor.checkCancelled();
        Function f = fm.getFunctionAt(e);
        // Refit the body in place so the name, signature and calling convention survive.
        if (f != null) CreateFunctionCmd.fixupFunctionBody(currentProgram, f, monitor);
      }
      // No analyzeChanges here: on libpl2.so it adds about 70 s, which pushes startup past the 330 s deadline.
    }
    println(
        "REA no-return fix: cleared=" + cleared.size() + " sites=" + redone + " refit=" + owners.size());
  }

  private boolean isX86Padding(Address a) {
    if (!currentProgram.getLanguage().getProcessor().toString().equals("x86")) return false;
    try {
      int b = currentProgram.getMemory().getByte(a) & 0xff;
      return b == 0xcc || b == 0x90 || b == 0x00;
    } catch (Exception e) {
      return false;
    }
  }
}
