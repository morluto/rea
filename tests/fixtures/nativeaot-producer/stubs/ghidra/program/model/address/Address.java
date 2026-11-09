package ghidra.program.model.address;
public class Address implements Comparable<Address> {
    public long value;
public Address(long v) {value=v;}
    public long getOffset(){return value;}
    public Address getNewAddress(long n){return new Address(n);}
    public Address add(long n){return new Address(value+n);}
    public int compareTo(Address a){return Long.compare(value,a.value);}
}
