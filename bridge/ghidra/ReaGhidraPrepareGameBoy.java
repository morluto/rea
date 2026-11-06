import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Program;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import java.util.List;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.LinkOption;

/** Static cartridge mapping only; no mapper execution or inferred bank-switch edges. */
public final class ReaGhidraPrepareGameBoy extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 2 || !currentProgram.getLanguageID().getIdAsString().equals("SM83:LE:16:default") ||
            !currentProgram.getExecutableFormat().equals("Raw Binary"))
            throw new IllegalArgumentException("Game Boy preparation requires the committed SM83 BinaryLoader import");
        int banks = Integer.parseInt(arguments[0]);
        Memory memory = currentProgram.getMemory();
        List<FileBytes> sources = memory.getAllFileBytes();
        if (banks < 2 || banks > 512 || sources.size() != 1 || sources.get(0).getSize() != 0x4000L)
            throw new IllegalArgumentException("Game Boy bank count does not match the complete imported file");
        FileBytes initial = sources.get(0);
        Path path = Path.of(arguments[1]);
        long expectedSize = banks * 0x4000L;
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) != expectedSize)
            throw new IllegalArgumentException("Game Boy snapshot size differs from the committed ROM");
        // Remove BinaryLoader's initial window; every bank retains its physical file offset.
        for (MemoryBlock block : memory.getBlocks()) memory.removeBlock(block, monitor);
        if (!memory.deleteFileBytes(initial))
            throw new IllegalStateException("Cannot release BinaryLoader's initial bank FileBytes");
        FileBytes source;
        try (var stream = Files.newInputStream(path)) {
            source = memory.createFileBytes(path.getFileName().toString(), 0, expectedSize, stream, monitor);
        }
        AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();
        for (int bank = 0; bank < banks; bank++) {
            monitor.checkCancelled();
            MemoryBlock block = memory.createInitializedBlock(String.format("ROM_%03x", bank),
                space.getAddress(bank == 0 ? 0 : 0x4000), source, bank * 0x4000L, 0x4000, bank > 1);
            block.setRead(true);
            block.setWrite(false);
            block.setExecute(true);
        }
        // Working address ranges, without claiming power-on contents or active RAM banks.
        int[][] ranges = {{0x8000,0x2000},{0xa000,0x2000},{0xc000,0x2000},{0xe000,0x1e00},
            {0xfe00,0xa0},{0xff00,0x80},{0xff80,0x7f},{0xffff,1}};
        String[] names = {"VRAM","CART_RAM_WINDOW","WRAM","ECHO_UNMODELED","OAM","IO","HRAM","IE"};
        for (int i = 0; i < ranges.length; i++) {
            MemoryBlock block = memory.createUninitializedBlock(names[i], space.getAddress(ranges[i][0]), ranges[i][1], false);
            block.setRead(true);
            block.setWrite(true);
            block.setExecute(false);
            if (names[i].equals("IO") || names[i].equals("IE")) block.setVolatile(true);
        }
        var entry = space.getAddress(0x100);
        addEntryPoint(entry);
        if (!disassemble(entry) || createFunction(entry, "entry") == null)
            throw new IllegalStateException("Game Boy cartridge entry cannot be decoded");
        currentProgram.getOptions(Program.PROGRAM_INFO).setBoolean("REA Game Boy prepared", true);
    }
}
