package ghidra.program.model.listing;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.DataType;
public class Program {
    public static boolean partial;
public boolean committed;
public int ends;
public LanguageID getLanguageID(){return new LanguageID();}
    public int startTransaction(String s){return 1;}
    public void endTransaction(int id,boolean commit){committed=commit;
ends++;}
    public Memory getMemory(){return new Memory();}
    public Listing getListing(){return new Listing();}
    public static class LanguageID {
    public String getIdAsString(){return "x86:LE:64";}
}
    public static class Memory {
    public int getBytes(Address a,byte[] b,int o,int n){return n;}
    public long getLong(Address a){return 1;}
}
    public static class Listing {
    public Data getDataAt(Address a){return new Data();}
}
    public static class Data {
    public DataType getDataType(){return partial ? new DataType(){public String getPathName(){return "other";}} : new DataType();}
} }
