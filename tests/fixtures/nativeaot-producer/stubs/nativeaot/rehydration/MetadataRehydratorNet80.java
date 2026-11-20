package nativeaot.rehydration;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Program;
import ghidra.util.task.TaskMonitor;
import ghidra.app.util.importer.MessageLog;
public class MetadataRehydratorNet80 {
    public Scan rehydrate(Program p,Object r,TaskMonitor m,MessageLog l){return new Scan();}
    public static class Scan {
    public Range getScanningRange(){return new Range();}
    public Address[] getPointerLocations(){return new Address[]{new Address(1)};}
}
    public static class Range {
    public long getLength(){return 2;}
    public Address getMinAddress(){return new Address(1);}
} }
