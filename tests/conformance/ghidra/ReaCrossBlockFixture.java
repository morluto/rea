import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.mem.Memory;
import java.io.ByteArrayInputStream;

/** Create owned test memory in a disposable project; the input file is unchanged. */
public class ReaCrossBlockFixture extends GhidraScript {
    @Override
    public void run() throws Exception {
        Memory memory = currentProgram.getMemory();
        Address base = toAddr("60000000");
        Address other = toAddr("OTHER:0");
        int transaction = currentProgram.startTransaction("REA search-boundary fixture");
        try {
            memory.createInitializedBlock("cross_first", base,
                new ByteArrayInputStream(new byte[] {(byte) 0xde, (byte) 0xad}), 2, monitor, false);
            memory.createInitializedBlock("cross_second", base.add(2),
                new ByteArrayInputStream(new byte[] {0x11, 0x22}), 2, monitor, false);
            memory.createInitializedBlock("cross_third", base.add(4),
                new ByteArrayInputStream(new byte[] {(byte) 0xbe, (byte) 0xef}), 2, monitor, false);
            Address gap = base.add(0x100);
            memory.createInitializedBlock("gap_first", gap,
                new ByteArrayInputStream(new byte[] {(byte) 0xde, (byte) 0xad}), 2, monitor, false);
            memory.createUninitializedBlock("gap_middle", gap.add(2), 2, false);
            memory.createInitializedBlock("gap_second", gap.add(4),
                new ByteArrayInputStream(new byte[] {(byte) 0xbe, (byte) 0xef}), 2, monitor, false);
            memory.createInitializedBlock("overlay_test", base,
                new ByteArrayInputStream(new byte[] {(byte) 0xde, (byte) 0xad, 0x11, 0x22, (byte) 0xbe, (byte) 0xef}), 6, monitor, true);
            memory.createInitializedBlock("not_loaded_control", other,
                new ByteArrayInputStream(new byte[] {(byte) 0xde, (byte) 0xad, 0x11, 0x22, (byte) 0xbe, (byte) 0xef}), 6, monitor, true);
            currentProgram.endTransaction(transaction, true);
        } catch (Exception failure) {
            currentProgram.endTransaction(transaction, false);
            throw failure;
        }
    }
}
