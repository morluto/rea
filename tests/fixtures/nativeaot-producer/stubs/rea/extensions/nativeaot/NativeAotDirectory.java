package rea.extensions.nativeaot;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Program;
import ghidra.util.task.TaskMonitor;
import ghidra.app.util.importer.MessageLog;
import nativeaot.rtr.ReadyToRunDirectory;
final class NativeAotDirectory {
    record Located(Address address,ReadyToRunDirectory directory,String discovery) {}
    static Located locate(Program p,TaskMonitor m,MessageLog l){return new Located(new Address(1),new ReadyToRunDirectory(),"symbol");}
}
