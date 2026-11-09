package nativeaot.rtr;
import ghidra.program.model.address.Address;
public class ReadyToRunSection {
    public static final int DEHYDRATED_DATA=1,FROZEN_OBJECT_REGION=2;
public long getStart(){return 1;}
    public long getEnd(){return 3;}
    public Address[] getPointersInSection(Address[] a){return a;}
}
