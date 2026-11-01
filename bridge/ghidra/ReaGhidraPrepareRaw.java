import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.mem.MemoryBlockSourceInfo;
import java.math.BigInteger;

/** Seed the caller-supplied raw-binary entry before default auto-analysis. */
public final class ReaGhidraPrepareRaw extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 4) {
            throw new IllegalArgumentException(
                "Raw binary preparation requires the committed language, load base, entry and entry context"
            );
        }
        String expectedLanguage = arguments[0];
        String baseHex = arguments[1];
        String entryHex = arguments[2];
        String entryContext = arguments[3];
        if (!currentProgram.getLanguageID().getIdAsString().equals(expectedLanguage) ||
            !currentProgram.getExecutableFormat().equals("Raw Binary")) {
            throw new IllegalArgumentException(
                "Raw binary preparation requires the committed language and BinaryLoader import"
            );
        }
        Address base = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(baseHex);
        Address entry = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(entryHex);
        MemoryBlock block = base == null ? null : currentProgram.getMemory().getBlock(base);
        boolean fileStart = false;
        if (block != null) {
            // Processor-defined zero page/stack blocks can precede the imported file.
            for (MemoryBlockSourceInfo source : block.getSourceInfos()) {
                if (source.getFileBytes().isPresent() && source.getFileBytesOffset() == 0 &&
                    base.equals(source.getMinAddress())) {
                    fileStart = true;
                    break;
                }
            }
        }
        if (!fileStart) {
            throw new IllegalArgumentException(
                "Raw binary import must map file offset 0 at the committed load base"
            );
        }
        if (entry == null || !block.contains(entry)) {
            throw new IllegalArgumentException("Raw binary entry must lie inside the source-backed load block");
        }
        if (!entryContext.equals("language-default")) {
            // The committed language selects this context; refuse to analyze if it does not.
            String[] assignment = entryContext.split("=", 2);
            if (assignment.length != 2 || !assignment[1].startsWith("0x")) {
                throw new IllegalArgumentException("Raw binary entry context must be language-default or REGISTER=0xVALUE");
            }
            Register register = currentProgram.getRegister(assignment[0]);
            BigInteger expected = new BigInteger(assignment[1].substring(2), 16);
            if (register == null ||
                !expected.equals(currentProgram.getProgramContext().getValue(register, entry, false))) {
                throw new IllegalStateException("Raw binary entry context " + entryContext + " is not in effect at the entry");
            }
        }
        addEntryPoint(entry);
        // Named as Ghidra's loaders name a program entry, whatever its role. The
        // load image reports the role; a handler name such as Reset_Handler
        // would claim a symbol the image does not carry.
        if (!disassemble(entry) || createFunction(entry, "entry") == null) {
            throw new IllegalStateException("Raw binary entry cannot be decoded as a function");
        }
        currentProgram.getOptions(Program.PROGRAM_INFO).setBoolean("REA raw binary prepared", true);
    }
}
