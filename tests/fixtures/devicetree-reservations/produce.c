#include <assert.h>
#include <inttypes.h>
#include <libfdt.h>
#include <stdio.h>

static void hex_bytes(const unsigned char *bytes, int length) {
    for (int i = 0; i < length; ++i) printf("%02x", bytes[i]);
}

int main(void) {
    unsigned char blob[2048];
    const uint64_t addresses[] = {UINT64_C(0x120000000), UINT64_C(0x10000000)};
    const uint64_t sizes[] = {UINT64_C(0x2000), UINT64_C(0x100002000)};
    assert(fdt_create_empty_tree(blob, sizeof(blob)) == 0);
    for (int i = 0; i < 2; ++i)
        assert(fdt_add_mem_rsv(blob, addresses[i], sizes[i]) == 0);
    assert(fdt_pack(blob) == 0);
    puts("[");
    for (int version = 17; version >= 16; --version) {
        fdt_set_version(blob, version);
        assert(fdt_check_full(blob, fdt_totalsize(blob)) == 0);
        assert(fdt_num_mem_rsv(blob) == 2);
        printf("{\"version\":%d,\"reservations\":[", version);
        for (int i = 0; i < 2; ++i) {
            uint64_t address, size;
            assert(fdt_get_mem_rsv(blob, i, &address, &size) == 0);
            assert(address == addresses[i] && size == sizes[i]);
            printf("%s{\"address\":\"0x%" PRIx64 "\",\"size\":\"0x%" PRIx64 "\"}",
                   i ? "," : "", address, size);
        }
        printf("],\"table_hex\":\"");
        hex_bytes(blob + fdt_off_mem_rsvmap(blob), 3 * 16);
        printf("\",\"blob_hex\":\"");
        hex_bytes(blob, fdt_totalsize(blob));
        printf("\"}%s\n", version == 17 ? "," : "");
    }
    puts("]");
    return 0;
}
