package nativeaot.objectmodel;
import java.util.List;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.DataType;
import ghidra.program.model.listing.Program;
import nativeaot.rtr.ReadyToRunDirectory;
public class MethodTableManager {
    public static boolean failAudit,failTypes;
public static MethodTableManager createForDirectory(Program p,ReadyToRunDirectory d){return new MethodTableManager();}
    public Object getObjectMT(){return this;}
    public Object getStringMT(){return this;}
    public int getMethodTableCount(){return 1;}
    public Table getMethodTable(long n){if(failAudit) throw new IllegalStateException("audit failure");
return new Table();}
    public List<Table> getMethodTables(){return List.of(new Table());}
    public static class Table {
    public Address getAddress(){return new Address(1);}
    public DataType getMTType(){if(failTypes) throw new IllegalStateException("type failure");
return new DataType();}
    public DataType getInstanceType(){return new DataType();}
} }
