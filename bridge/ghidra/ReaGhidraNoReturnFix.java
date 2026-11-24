import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.FlowType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.pcode.PcodeOp;
import ghidra.program.model.pcode.Varnode;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * Undo wrong no-return flags from auto-analysis. A function flagged no-return that contains a
 * real RET is an ordinary function (stream readers, cxa_guard_acquire, ...). Known returning
 * libc/TLS imports have no body to inspect, so clear their flags by exact external ABI name.
 * Callers treated the call as a terminator and the decompiler truncated them. Clear the flag, then re-disassemble only
 * the call sites of the functions that were cleared and refit their owning functions in place.
 * Then end the computed calls whose target the instruction stream fixes to a function that keeps
 * its flag: Ghidra applies the flag only to calls with a decoded flow, so these calls keep a
 * fallthrough the decompiler never follows.
 */
public final class ReaGhidraNoReturnFix extends GhidraScript {
  private static final Set<String> RETURNING_IMPORTS = Set.of(
      "malloc", "__tls_get_addr", "memcpy", "memset", "strlen", "__errno_location");
  /** Instructions, counting the call, that may define a computed call's target (auipc+jalr is 2). */
  private static final int TARGET_INSTRUCTIONS = 4;
  /** P-code definitions that one target proof may evaluate. */
  private static final int TARGET_DEFINITIONS = 16;

  @Override
  public void run() throws Exception {
    // Windows P0 does not admit analysis-database mutation.
    if (System.getProperty("os.name", "").startsWith("Windows")) return;
    FunctionManager fm = currentProgram.getFunctionManager();
    Listing li = currentProgram.getListing();
    Set<Address> cleared = new HashSet<>();
    Deque<Address> pending = new ArrayDeque<>();
    for (Function f : fm.getExternalFunctions()) {
      monitor.checkCancelled();
      // Do not apply import-name assumptions to local functions or to arbitrary externals.
      if (!f.hasNoReturn() || !RETURNING_IMPORTS.contains(externalAbiName(f))) continue;
      f.setNoReturn(false);
      enqueueReturning(f, cleared, pending);
    }
    for (Function f : fm.getFunctions(true)) {
      monitor.checkCancelled();
      if (clearDecodedReturn(f, li)) {
        enqueueReturning(f, cleared, pending);
      }
    }
    int redone = 0;
    TreeSet<Address> owners = new TreeSet<>();
    while (!pending.isEmpty()) {
      Address target = pending.removeFirst();
      TreeSet<Address> sites = new TreeSet<>();
      // References include computed import calls after Ghidra resolves their destination.
      // Collect before redisassembly mutates the reference table.
      for (Reference reference : currentProgram.getReferenceManager().getReferencesTo(target)) {
        monitor.checkCancelled();
        sites.add(reference.getFromAddress());
      }
      for (Address s : sites) {
        monitor.checkCancelled();
        Instruction ins = li.getInstructionAt(s);
        if (ins == null) continue;
        FlowType ft = ins.getFlowType();
        if (!(ft.isCall() && ft.isTerminal())) continue;
        Address[] flows = ins.getFlows();
        boolean callsTarget = false;
        for (Address flow : flows) {
          if (flow.equals(target)) callsTarget = true;
        }
        if (!callsTarget) continue;
        // Do not redisassemble into an independently identified function.
        Address next = ins.getMaxAddress().add(1);
        if (fm.getFunctionAt(next) != null || !currentProgram.getMemory().contains(next)) continue;
        Function owner = fm.getFunctionContaining(s);
        if (owner != null && !owner.isThunk()) owners.add(owner.getEntryPoint());
        clearListing(ins.getMinAddress(), ins.getMaxAddress());
        disassemble(s);
        redone++;
        // Refit the body in place so the name, signature and calling convention survive.
        if (owner != null && !owner.isThunk()) {
          CreateFunctionCmd.fixupFunctionBody(currentProgram, owner, monitor);
          // Auto-analysis may have propagated the false flag to this truncated caller.
          // Its RET becomes visible only now; repair its callers in the same pass.
          if (clearDecodedReturn(owner, li)) enqueueReturning(owner, cleared, pending);
        }
      }
    }
    // The disassembler applies a callee's flag only to a call it decoded a flow for. A computed
    // call that analysis resolves later, such as a RISC-V auipc+jalr pair, keeps its fallthrough.
    // A recorded reference is only a candidate, so each call must also prove its target constant.
    TreeSet<Address> computed = new TreeSet<>();
    for (Function f : fm.getFunctions(true)) {
      monitor.checkCancelled();
      if (!f.hasNoReturn() || f.isThunk()) continue;
      for (Reference reference : currentProgram.getReferenceManager().getReferencesTo(f.getEntryPoint())) {
        monitor.checkCancelled();
        if (!reference.getReferenceType().isCall()) continue;
        Instruction ins = li.getInstructionAt(reference.getFromAddress());
        if (ins != null && resolvedComputedCall(ins, f.getEntryPoint())) computed.add(ins.getAddress());
      }
    }
    TreeSet<Address> ended = new TreeSet<>();
    for (Address s : computed) {
      monitor.checkCancelled();
      // Ghidra's own idiom (FixupNoReturnFunctionsScript): the call keeps its reference, not its fallthrough.
      li.getInstructionAt(s).setFlowOverride(FlowOverride.CALL_RETURN);
      Function owner = fm.getFunctionContaining(s);
      if (owner != null && !owner.isThunk()) ended.add(owner.getEntryPoint());
    }
    for (Address entry : ended) {
      monitor.checkCancelled();
      // Refit once per owner, after all of its calls have ended.
      CreateFunctionCmd.fixupFunctionBody(currentProgram, fm.getFunctionAt(entry), monitor);
      owners.add(entry);
    }
    // No analyzeChanges here: on libpl2.so it adds about 70 s, which pushes startup past the 330 s deadline.
    println("REA no-return fix: cleared=" + cleared.size() + " sites=" + redone + " computed="
        + computed.size() + " refit=" + owners.size());
  }

  /**
   * An unconditional computed call without a decoded flow or an override, whose only resolved
   * flow is the callee and whose target the instruction stream proves to be that callee.
   */
  private boolean resolvedComputedCall(Instruction instruction, Address callee) {
    FlowType flow = instruction.getFlowType();
    if (!flow.isCall() || !flow.isComputed() || flow.isConditional() || flow.isTerminal()) return false;
    // Never replace an override that analysis chose.
    if (instruction.getFlowOverride() != FlowOverride.NONE) return false;
    // getFlows() includes references that analysis added; getDefaultFlows() has only decoded flows.
    if (instruction.getDefaultFlows().length != 0) return false;
    Address[] flows = instruction.getFlows();
    return flows.length == 1 && flows[0].equals(callee) && constantTarget(instruction, callee);
  }

  /**
   * Prove that the call's one CALLIND reads the callee's address computed only from constants.
   * Ghidra's references are candidates: a slot or register that other code can change gives no
   * such proof. The trace walks back through the call's own p-code and at most
   * TARGET_INSTRUCTIONS - 1 fallthrough predecessors. It accepts COPY, INT_ADD, INT_SUB,
   * INT_AND, INT_NEGATE, INT_LEFT, INT_ZEXT and INT_SEXT on constants, registers and unique
   * values that it defines; RISC-V auipc+jalr needs INT_LEFT, INT_ADD, INT_NEGATE and INT_AND.
   * The window must be straight-line as a whole: a control-flow op anywhere in a predecessor's
   * p-code or before the CALLIND, such as the CBRANCH of x86 CMOVcc or ARM ADREQ, can skip a
   * definition the trace relies on. It also refuses memory, a register defined outside the
   * window, a partial definition, delay slots, and a join: a function entry, an external entry
   * or any referenced instruction between the oldest instruction it reads and the call.
   */
  private boolean constantTarget(Instruction call, Address callee) {
    if (call.getDelaySlotDepth() != 0) return false;
    PcodeOp[] operations = call.getPcode();
    int index = -1;
    for (int i = 0; i < operations.length; i++) {
      if (operations[i].getOpcode() != PcodeOp.CALLIND) continue;
      if (index >= 0) return false;
      index = i;
    }
    if (index < 0 || !straightLine(operations, index)) return false;
    Varnode target = operations[index].getInput(0);
    Long value = new TargetTrace(call, operations).before(target, 0, index);
    return value != null && callee.getAddressSpace().getPhysicalSpace().equals(
            call.getAddress().getAddressSpace().getPhysicalSpace())
        && value == truncate(callee.getAddressableWordOffset(), target.getSize());
  }

  /** The straight-line instructions that end at one call, newest first. */
  private final class TargetTrace {
    private final List<Instruction> instructions = new ArrayList<>();
    private final List<PcodeOp[]> operations = new ArrayList<>();
    private int definitions;

    TargetTrace(Instruction call, PcodeOp[] pcode) {
      instructions.add(call);
      operations.add(pcode);
    }

    /** The value that a varnode holds before operation `index` of instruction `position`. */
    Long before(Varnode varnode, int position, int index) {
      if (varnode.isConstant()) return truncate(varnode.getOffset(), varnode.getSize());
      if ((!varnode.isRegister() && !varnode.isUnique()) || varnode.getSize() > 8) return null;
      while (true) {
        PcodeOp[] ops = operations.get(position);
        for (int i = index - 1; i >= 0; i--) {
          Varnode output = ops[i].getOutput();
          if (output == null || !output.intersects(varnode)) continue;
          if (output.getOffset() != varnode.getOffset() || output.getSize() != varnode.getSize()) return null;
          return ++definitions > TARGET_DEFINITIONS ? null : evaluate(ops[i], position, i);
        }
        // A unique value lives in one instruction; a register comes from the predecessor.
        if (varnode.isUnique() || !predecessor(position)) return null;
        position++;
        index = operations.get(position).length;
      }
    }

    private Long evaluate(PcodeOp operation, int position, int index) {
      int count = operation.getNumInputs();
      long[] inputs = new long[count];
      for (int i = 0; i < count; i++) {
        Long input = before(operation.getInput(i), position, index);
        if (input == null) return null;
        inputs[i] = input;
      }
      long result;
      switch (operation.getOpcode()) {
        case PcodeOp.COPY, PcodeOp.INT_ZEXT -> result = inputs[0];
        case PcodeOp.INT_SEXT -> {
          int shift = 64 - 8 * operation.getInput(0).getSize();
          result = (inputs[0] << shift) >> shift;
        }
        case PcodeOp.INT_ADD -> result = inputs[0] + inputs[1];
        case PcodeOp.INT_SUB -> result = inputs[0] - inputs[1];
        case PcodeOp.INT_AND -> result = inputs[0] & inputs[1];
        case PcodeOp.INT_NEGATE -> result = ~inputs[0];
        case PcodeOp.INT_LEFT -> result = inputs[1] >= 64 || inputs[1] < 0 ? 0 : inputs[0] << inputs[1];
        default -> { return null; }
      }
      return truncate(result, operation.getOutput().getSize());
    }

    /** Extend the window by the instruction that falls into the oldest one, if nothing else enters. */
    private boolean predecessor(int position) {
      if (position + 1 < instructions.size()) return true;
      if (instructions.size() >= TARGET_INSTRUCTIONS) return false;
      Instruction newer = instructions.get(position);
      Address entered = newer.getAddress();
      if (currentProgram.getFunctionManager().getFunctionAt(entered) != null
          || currentProgram.getReferenceManager().hasReferencesTo(entered)
          || currentProgram.getSymbolTable().isExternalEntryPoint(entered)) return false;
      Address from = newer.getFallFrom();
      Instruction older = from == null ? null : currentProgram.getListing().getInstructionAt(from);
      if (older == null || older.isInDelaySlot() || older.getDelaySlotDepth() != 0) return false;
      FlowType flow = older.getFlowType();
      if (flow.isCall() || flow.isJump() || flow.isTerminal() || !flow.isFallthrough()) return false;
      PcodeOp[] pcode = older.getPcode();
      if (!straightLine(pcode, pcode.length)) return false;
      instructions.add(older);
      operations.add(pcode);
      return true;
    }
  }

  /** No operation before `end` can transfer control, so every one of them runs. */
  private static boolean straightLine(PcodeOp[] operations, int end) {
    for (int i = 0; i < end; i++) {
      if (controlFlow(operations[i].getOpcode())) return false;
    }
    return true;
  }

  private static boolean controlFlow(int opcode) {
    return switch (opcode) {
      case PcodeOp.BRANCH, PcodeOp.CBRANCH, PcodeOp.BRANCHIND, PcodeOp.CALL, PcodeOp.CALLIND,
          PcodeOp.CALLOTHER, PcodeOp.RETURN -> true;
      default -> false;
    };
  }

  private static long truncate(long value, int size) {
    return size >= 8 ? value : value & ((1L << (8 * size)) - 1);
  }

  private void enqueueReturning(Function function, Set<Address> cleared, Deque<Address> pending) {
    if (cleared.add(function.getEntryPoint())) pending.addLast(function.getEntryPoint());
    // A thunk inherits the flag of the function it forwards to, including through other thunks.
    Address[] thunks = function.getFunctionThunkAddresses(true);
    if (thunks == null) return;
    for (Address thunk : thunks) {
      if (cleared.add(thunk)) pending.addLast(thunk);
    }
  }

  private String externalAbiName(Function function) {
    String name = function.getName();
    // Mach-O stores C-linkage symbols with one object-format underscore prefix.
    if (currentProgram.getExecutableFormat().contains("Mach-O") && name.startsWith("_"))
      return name.substring(1);
    return name;
  }

  private boolean clearDecodedReturn(Function function, Listing listing) throws Exception {
    if (!function.hasNoReturn() || function.isThunk()) return false;
    for (Instruction instruction : listing.getInstructions(function.getBody(), true)) {
      monitor.checkCancelled();
      FlowType flow = instruction.getFlowType();
      if (flow.isJump() || flow.isCall()) continue;
      for (PcodeOp operation : instruction.getPcode()) {
        if (operation.getOpcode() != PcodeOp.RETURN) continue;
        function.setNoReturn(false);
        return true;
      }
    }
    return false;
  }
}
