package rea.extensions.nativeaot;
import com.google.gson.JsonObject;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.DataType;
import ghidra.program.model.listing.Program;
import ghidra.util.task.TaskMonitor;
import nativeaot.objectmodel.MethodTableManager;
final class NativeAotTypeMetadata {
    static JsonObject describe(Program p,MethodTableManager m,NativeAotDirectory.Located l,DataType t,JsonObject r,JsonObject d,TaskMonitor x){return null;}
}
