import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryBlock;
import java.math.BigInteger;

/**
 * Seed the declared DOS COM analysis context before default auto-analysis.
 *
 * ComLoader ("Old-style DOS Executable (COM)") maps a 256-byte placeholder at
 * 0000:0000 and the file at 0000:0100. The explicit BinaryLoader fallback maps
 * the file alone at 1000:0100. Both stay on x86:LE:16:Real Mode. Segment
 * registers match the load segment so later instructions use that coordinate.
 */
public final class ReaGhidraPrepareCom extends GhidraScript {
    private static final String COM_FORMAT = "Old-style DOS Executable (COM)";
    private static final String RAW_FORMAT = "Raw Binary";

    @Override
    public void run() throws Exception {
        if (!currentProgram.getLanguageID().getIdAsString().equals("x86:LE:16:Real Mode")) {
            throw new IllegalArgumentException("DOS COM preparation requires x86 real-mode import");
        }
        String format = currentProgram.getExecutableFormat();
        AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();
        if (format.equals(COM_FORMAT)) prepareComLoader(space);
        else if (format.equals(RAW_FORMAT)) prepareBinaryLoader(space);
        else {
            throw new IllegalArgumentException(
                "DOS COM preparation requires the ComLoader or raw BinaryLoader import"
            );
        }
        currentProgram.getOptions(Program.PROGRAM_INFO).setBoolean("REA DOS COM prepared", true);
    }

    /** ComLoader's PSP placeholder and file image, with segment registers at 0. */
    private void prepareComLoader(AddressSpace space) throws Exception {
        Address psp = space.getAddress("0000:0000");
        Address entry = space.getAddress("0000:0100");
        MemoryBlock placeholder = currentProgram.getMemory().getBlock("PSP");
        MemoryBlock code = currentProgram.getMemory().getBlock("CODE");
        if (placeholder == null || code == null ||
            !placeholder.getStart().equals(psp) || placeholder.getSize() != 0x100 ||
            !code.getStart().equals(entry) || code.getSize() < 1 || code.getSize() > 0xff00 ||
            !currentProgram.getMaxAddress().equals(code.getEnd())) {
            throw new IllegalArgumentException(
                "DOS COM ComLoader import must map a 256-byte PSP at 0000:0000 and 1..65280 code bytes at 0000:0100"
            );
        }
        seed(entry, psp, code.getEnd(), BigInteger.ZERO);
    }

    /** Explicit raw fallback: file bytes only, at the fixed real-mode segment. */
    private void prepareBinaryLoader(AddressSpace space) throws Exception {
        Address entry = space.getAddress("1000:0100");
        Address start = currentProgram.getMinAddress();
        Address end = currentProgram.getMaxAddress();
        if (!entry.equals(start) || end.subtract(start) + 1 > 0xff00) {
            throw new IllegalArgumentException("DOS COM import must map 1..65280 bytes at 1000:0100");
        }
        seed(entry, start, end, BigInteger.valueOf(0x1000));
    }

    private void seed(Address entry, Address start, Address end, BigInteger segment) throws Exception {
        for (String name : new String[] { "CS", "DS", "ES", "SS" }) {
            monitor.checkCancelled();
            currentProgram.getProgramContext().setValue(
                currentProgram.getRegister(name), start, end, segment
            );
        }
        addEntryPoint(entry);
        if (!disassemble(entry) || createFunction(entry, "entry") == null) {
            throw new IllegalStateException("DOS COM entry cannot be decoded as a function");
        }
    }
}
