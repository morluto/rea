package rea.extensions.nativeaot;
import ghidra.program.model.listing.Program;
import ghidra.util.task.TaskMonitor;
import nativeaot.objectmodel.MethodTableManager;
final class NativeAotMethodConventions {
    static Object capture(Program p,TaskMonitor m){return null;}
    static void restore(Program p,MethodTableManager a,Object c,TaskMonitor m) {}
}
