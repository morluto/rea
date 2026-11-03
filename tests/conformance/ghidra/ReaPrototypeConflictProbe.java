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
        requireLowerBlockRead();    // An owned block below entry precedes it in the scan.
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
            ReaGhidraBridge.framedStackRead(address(entry), instructions, monitor);
        require(read != null && read.instruction().getAddress().getOffset() == expected &&
            read.offset() == 8, "Expected entry-frame read at " + Long.toHexString(expected));
    }

    private void requireNoRead(long entry) throws Exception {
        require(ReaGhidraBridge.framedStackRead(address(entry), decode(entry), monitor) == null,
            "EBP no longer holds the entry frame at " + Long.toHexString(entry));
    }

    private Address address(long offset) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
    }

    /**
     * A block owned below the entry can appear first in an address-ordered scan.
     * The prologue must still be found by the function's entry address.
     */
    private void requireLowerBlockRead() throws Exception {
        List<Instruction> entry = decode(0x1800);
        List<Instruction> lower = decode(0x1a00);
        require(!lower.isEmpty(), "The lower block requires decoded instructions");
        List<Instruction> scanned = new ArrayList<>(lower);
        scanned.addAll(entry);
        ReaGhidraBridge.FrameRead read =
            ReaGhidraBridge.framedStackRead(address(0x1800), scanned, monitor);
        require(read != null && read.instruction().getAddress().getOffset() == 0x1803 &&
            read.offset() == 8, "A lower owned block must not hide the entry frame");
    }

    private List<Instruction> decode(long entry) throws Exception {
        Address address = address(entry);
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
