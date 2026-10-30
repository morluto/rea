//@category REA Verification

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Instruction;
import java.util.ArrayList;
import java.util.List;

/** Check the producer's decoded-instruction rules, not a hand-built dossier. */
public class ReaPrototypeConflictProbe extends GhidraScript {
    @Override
    public void run() throws Exception {
        require(currentProgram.getLanguageID().getIdAsString().startsWith("x86:LE:32:"),
            "The fixture requires x86-32");
        requireRead(0x1000, 0x100a); // Branch past an earlier LEAVE; RET.
        requireNoRead(0x1100);      // XCHG EAX, EBP before the frame-relative read.
        requireNoRead(0x1200);      // MOV BP, AX before the frame-relative read.
        requireRead(0x1300, 0x1303);
        requireRead(0x1600, 0x1603); // Read through old frame before overwriting EBP.
        requireNoRead(0x1700);      // POP [EBP+8] reads from ESP, not EBP.
        Instruction ret8 = decode(0x1400).get(0);
        Instruction ret0 = decode(0x1500).get(0);
        require(Long.valueOf(8).equals(ReaGhidraBridge.conflictingReturnCleanup(ret8, 0)),
            "A zero-parameter stdcall RET 8 is a mismatch");
        require(Long.valueOf(0).equals(ReaGhidraBridge.conflictingReturnCleanup(ret0, 16)),
            "A four-slot stdcall RET 0 is a mismatch");
        require(ReaGhidraBridge.conflictingReturnCleanup(ret8, 8) == null,
            "Matching cleanup is not a conflict");
        println("REA_PROTOTYPE_CONFLICT_OK");
    }

    private void requireRead(long entry, long expected) throws Exception {
        List<Instruction> instructions = decode(entry);
        ReaGhidraBridge.FrameRead read =
            ReaGhidraBridge.framedStackRead(instructions, monitor);
        require(read != null && read.instruction().getAddress().getOffset() == expected &&
            read.offset() == 8, "Expected entry-frame read at " + Long.toHexString(expected));
    }

    private void requireNoRead(long entry) throws Exception {
        require(ReaGhidraBridge.framedStackRead(decode(entry), monitor) == null,
            "EBP no longer holds the entry frame at " + Long.toHexString(entry));
    }

    private List<Instruction> decode(long entry) throws Exception {
        Address address = currentProgram.getAddressFactory().getDefaultAddressSpace()
            .getAddress(entry);
        disassemble(address);
        List<Instruction> instructions = new ArrayList<>();
        for (Instruction instruction : currentProgram.getListing().getInstructions(true)) {
            long offset = instruction.getAddress().getOffset();
            if (offset >= entry && offset < entry + 0x40) instructions.add(instruction);
        }
        return instructions;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
