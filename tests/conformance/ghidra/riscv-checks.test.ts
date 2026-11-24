import { describe, expect, it } from "vitest";
import {
  RISCV_ABIS,
  assertRiscvAbiTableConsistent,
  assertRiscvCallSites,
  assertRiscvCaller,
  assertRiscvStorage,
  parseRiscvCallSites,
  riscvStorageLocations,
} from "./riscv-checks.mjs";

// `llvm-objdump -d --no-show-raw-insn` of rea_riscv_abi_caller in the soft-float
// fixture, built by LLVM 19 at -O0 (tabs and runs of spaces collapsed). The real
// lane disassembles its own build; this tests the oracle, not Ghidra.
const LISTING = `
00011408 <rea_riscv_abi_caller>:
11408: addi sp, sp, -0xe0
1140a: sw ra, 0xdc(sp)
1140c: sw s0, 0xd8(sp)
1140e: addi s0, sp, 0xe0
11410: sw a0, -0xc(s0)
11414: lw a2, -0xc(s0)
11418: lui a0, 0x3fc00
1141c: lui a1, 0x40200
11420: jal 0x110f4 <rea_riscv_abi_pick>
11422: sw a0, -0x10(s0)
11426: lw a2, -0xc(s0)
1142a: li a0, 0x0
1142c: sw a0, -0xd4(s0)
11430: lui a1, 0x400a0
11434: jal 0x11130 <rea_riscv_abi_wide>
11436: lw a4, -0xd4(s0)
1143a: sw a1, -0x14(s0)
1143e: sw a0, -0x18(s0)
11442: lw a0, -0xc(s0)
11446: lui a2, 0x40130
1144a: lui a3, 0x40b00
1144e: lui a5, 0x40188
11452: mv a1, a4
11454: jal 0x1117e <rea_riscv_abi_mixed>
11456: lw a7, -0xd4(s0)
1145a: sw a1, -0x1c(s0)
1145e: sw a0, -0x20(s0)
11462: lw a6, -0xc(s0)
11466: mv a1, sp
11468: lui a0, 0x401d0
1146c: sw a0, 0x0(a1)
1146e: li a0, 0x1
11470: li a1, 0x2
11472: sw a1, -0xd8(s0)
11476: li a2, 0x3
11478: li a3, 0x4
1147a: li a4, 0x5
1147c: li a5, 0x6
1147e: jal 0x111e6 <rea_riscv_abi_split>
11480: sw a1, -0x24(s0)
11484: sw a0, -0x28(s0)
11488: lui a0, 0x41080
1148c: sw a0, -0x38(s0)
11490: lui a0, 0x41180
11494: sw a0, -0x34(s0)
11498: lw a1, -0x34(s0)
1149c: lw a0, -0x38(s0)
114a0: lui a2, 0x41280
114a4: jal 0x11256 <rea_riscv_abi_pair>
114a6: sw a1, -0x2c(s0)
114aa: sw a0, -0x30(s0)
114ae: lui a0, 0x41380
114b2: sw a0, -0x48(s0)
114b6: li a0, 0xc
114b8: sw a0, -0x44(s0)
114bc: lw a2, -0xc(s0)
114c0: lw a1, -0x44(s0)
114c4: lw a0, -0x48(s0)
114c8: jal 0x11296 <rea_riscv_abi_tagged>
114ca: mv a2, a0
114cc: lw a0, -0xd4(s0)
114d0: sw a2, -0xdc(s0)
114d4: mv a2, a1
114d6: lw a1, -0xdc(s0)
114da: sw a2, -0x3c(s0)
114de: sw a1, -0x40(s0)
114e2: lui a1, 0x402b0
114e6: sw a1, -0x74(s0)
114ea: sw a0, -0x78(s0)
114ee: lui a1, 0x402d0
114f2: sw a1, -0x6c(s0)
114f6: sw a0, -0x70(s0)
114fa: lui a0, 0x41780
114fe: sw a0, -0x68(s0)
11502: lw a0, -0x64(s0)
11506: sw a0, -0x7c(s0)
1150a: lw a0, -0x68(s0)
1150e: sw a0, -0x80(s0)
11512: lw a0, -0x6c(s0)
11516: sw a0, -0x84(s0)
1151a: lw a0, -0x70(s0)
1151e: sw a0, -0x88(s0)
11522: lw a0, -0x74(s0)
11526: sw a0, -0x8c(s0)
1152a: lw a0, -0x78(s0)
1152e: sw a0, -0x90(s0)
11532: addi a0, s0, -0x60
11536: addi a1, s0, -0x90
1153a: lui a2, 0x41840
1153e: jal 0x112d2 <rea_riscv_abi_large>
11540: lw a0, -0xd4(s0)
11544: lw a2, -0xc(s0)
11548: lui a1, 0x40037
1154c: addi a1, a1, -0x800
11550: sw a1, -0xc4(s0)
11554: sw a0, -0xc8(s0)
11558: sw a0, -0xcc(s0)
1155c: sw a0, -0xd0(s0)
11560: addi a0, s0, -0xc0
11564: addi a1, s0, -0xd0
11568: jal 0x11316 <rea_riscv_abi_quad>
1156a: lw a0, -0xd8(s0)
1156e: lw a6, -0xd4(s0)
11572: lw a1, -0xc0(s0)
11576: lw a2, -0xbc(s0)
1157a: lw a3, -0xb8(s0)
1157e: lw a4, -0xb4(s0)
11582: sw a4, -0x94(s0)
11586: sw a3, -0x98(s0)
1158a: sw a2, -0x9c(s0)
1158e: sw a1, -0xa0(s0)
11592: lw a4, -0xc(s0)
11596: mv a2, sp
11598: li a1, 0x13
1159a: sw a1, 0x0(a2)
1159c: lui a3, 0x40318
115a0: lui a7, 0x40328
115a4: mv a2, a6
115a6: jal 0x1136a <rea_riscv_abi_variadic>
115a8: sw a0, -0xa4(s0)
115ac: lui a0, 0x12
115b0: lw a3, 0x648(a0)
115b4: lw a2, -0xc(s0)
115b8: lui a0, 0x41a40
115bc: lui a1, 0x41ac0
115c0: jalr a3
115c2: sw a0, -0xa8(s0)
115c6: lw a0, -0x10(s0)
115ca: lw a1, -0x14(s0)
115ce: xor a0, a0, a1
115d0: lw a1, -0x1c(s0)
115d4: xor a0, a0, a1
115d6: lw a1, -0x24(s0)
115da: xor a0, a0, a1
115dc: lw a1, -0x30(s0)
115e0: xor a0, a0, a1
115e2: lw a1, -0x3c(s0)
115e6: xor a0, a0, a1
115e8: lw a1, -0x54(s0)
115ec: xor a0, a0, a1
115ee: lw a1, -0x94(s0)
115f2: xor a0, a0, a1
115f4: lw a1, -0xa4(s0)
115f8: xor a0, a0, a1
115fa: lw a1, -0xa8(s0)
115fe: xor a0, a0, a1
11600: lw ra, 0xdc(sp)
11602: lw s0, 0xd8(sp)
11604: addi sp, sp, 0xe0
11606: ret
`;

// Ghidra 12.1.4 HighFunction prototypes of the same build, printed as
// `name return | parameter:type@storage`. DERIVED uses __rea_ilp32. The two
// stock lines are Ghidra's ilp32d prototype, and the ilp32 prototype before it
// passed values over 8 bytes by reference.
const DERIVED = `
rea_riscv_abi_pick float@a0:4 | a:float@a0:4 | b:float@a1:4 | sel:int@a2:4
rea_riscv_abi_wide double@a1:4,a0:4 | a:double@a1:4,a0:4 | sel:int@a2:4
rea_riscv_abi_mixed double@a1:4,a0:4 | i:int@a0:4 | d:double@a2:4,a1:4 | f:float@a3:4 | e:double@a5:4,a4:4
rea_riscv_abi_split double@a1:4,a0:4 | a:int@a0:4 | b:int@a1:4 | c:int@a2:4 | d:int@a3:4 | e:int@a4:4 | f:int@a5:4 | g:int@a6:4 | x:double@Stack[0x0]:4,a7:4
rea_riscv_abi_pair rea_riscv_abi_pair@a1:4,a0:4 | value:rea_riscv_abi_pair@a1:4,a0:4 | scale:float@a2:4
rea_riscv_abi_tagged rea_riscv_abi_tagged@a1:4,a0:4 | value:rea_riscv_abi_tagged@a1:4,a0:4 | tag:int@a2:4
rea_riscv_abi_large rea_riscv_abi_large *@a0:4 | __return_storage_ptr__:rea_riscv_abi_large *@a0:4 (auto) | value:rea_riscv_abi_large *@a1:4 | scale:float@a2:4
rea_riscv_abi_quad long double *@a0:4 | __return_storage_ptr__:long double *@a0:4 (auto) | value:long double *@a1:4 | sel:int@a2:4
rea_riscv_abi_variadic uint@a0:4 | count:int@a0:4
`;
const DEFAULT_PICK =
  "rea_riscv_abi_pick float@fa0:4 | a:float@fa0:4 | b:float@fa1:4 | sel:int@a0:4";
const JOINED_QUAD =
  "rea_riscv_abi_quad long double *@a0:4 | __return_storage_ptr__:long double *@a0:4 (auto) | value:long double@a4:4,a3:4,a2:4,a1:4 | sel:int@a5:4";
const STRIPPED = `
rea_riscv_abi_pick undefined4@a0:4 | param_1:undefined4@a0:4 | param_2:undefined4@a1:4 | param_3:int@a2:4
rea_riscv_abi_wide undefined8@a1:4,a0:4 | param_1:undefined4@a0:4 | param_2:undefined4@a1:4 | param_3:int@a2:4
rea_riscv_abi_mixed undefined8@a1:4,a0:4 | param_1:int@a0:4 | param_2:undefined4@a1:4 | param_3:undefined4@a2:4 | param_4:undefined4@a3:4 | param_5:undefined4@a4:4 | param_6:undefined4@a5:4
rea_riscv_abi_split undefined8@a1:4,a0:4 | param_1:uint@a0:4 | param_2:uint@a1:4 | param_3:uint@a2:4 | param_4:uint@a3:4 | param_5:uint@a4:4 | param_6:uint@a5:4 | param_7:uint@a6:4 | param_8:undefined4@a7:4 | param_9:undefined4@Stack[0x0]:4
rea_riscv_abi_pair undefined8@a1:4,a0:4 | param_1:undefined4@a0:4 | param_2:undefined4@a1:4 | param_3:undefined4@a2:4
rea_riscv_abi_tagged undefined8@a1:4,a0:4 | param_1:undefined4@a0:4 | param_2:undefined4@a1:4 | param_3:undefined4@a2:4
rea_riscv_abi_large void@<VOID> | param_1:undefined4 *@a0:4 | param_2:undefined4 *@a1:4 | param_3:undefined4@a2:4
rea_riscv_abi_quad void@<VOID> | param_1:undefined4 *@a0:4 | param_2:undefined4 *@a1:4 | param_3:undefined4@a2:4
rea_riscv_abi_variadic uint@a0:4 | param_1:int@a0:4
`;

/** Rebuild inspect_native_api boundaries from the recorded prototype lines. */
const boundaries = (text: string, calling_convention = "__rea_ilp32") =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const [head = "", ...parameters] = line.split(" | ");
        const name = head.slice(0, head.indexOf(" "));
        const [data_type, storage] = head.slice(name.length + 1).split("@");
        return [
          name,
          {
            calling_convention,
            return_type: { data_type, storage },
            parameters: parameters.map((parameter, ordinal) => {
              const at = parameter.indexOf(":");
              const [type, place] = parameter.slice(at + 1).split("@");
              return {
                ordinal,
                name: parameter.slice(0, at),
                data_type: type,
                storage: place,
              };
            }),
          },
        ];
      }),
  );

// Call lines of rea_riscv_abi_caller's pseudocode from the same Ghidra runs.
const TYPED_CALLER = `
  local_10 = rea_riscv_abi_pick(1.5,2.5,sel);
  local_18 = rea_riscv_abi_wide(3.25,local_c);
  local_20 = rea_riscv_abi_mixed(local_c,4.75,5.5,6.125);
  local_28 = rea_riscv_abi_split(1,2,3,4,5,6,local_c,7.25);
  local_30 = rea_riscv_abi_pair((rea_riscv_abi_pair)0x4118000041080000,10.5);
  local_40 = rea_riscv_abi_tagged((rea_riscv_abi_tagged)0xc41380000,local_c);
  rea_riscv_abi_large(&rStack_60,&local_90,16.5);
  rea_riscv_abi_quad((long_double *)&local_c0,(long_double *)&local_d0,local_c);
  local_a4 = rea_riscv_abi_variadic(2,0x13,0,0x40318000,local_c);
  fVar1 = (*rea_riscv_abi_callback)(20.5,21.5,local_c);
`;
const DEFAULT_CALLER = `
  fVar2 = rea_riscv_abi_pick(in_fa0,in_fa1,0x3fc00000);
  dVar3 = rea_riscv_abi_wide((double)CONCAT44(extraout_var,fVar2),0);
  (*rea_riscv_abi_callback)(extraout_fa0,extraout_fa1_00,0x41a40000);
`;
const STRIPPED_CALLER = `
  local_10 = FUN_ram_000110f4(0x3fc00000,0x40200000,param_1);
  local_18 = FUN_ram_00011130(0,0x400a0000,local_c);
  local_20 = FUN_ram_0001117e(local_c,0,0x40130000,0x40b00000,0,0x40188000);
  local_28 = FUN_ram_000111e6(1,2,3,4,5,6,local_c,0,0x401d0000);
  local_30 = FUN_ram_00011256(0x41080000,0x41180000,0x41280000);
  local_40 = FUN_ram_00011296(0x41380000,0xc,local_c);
  FUN_ram_000112d2(auStack_60,&local_90,0x41840000);
  FUN_ram_00011316(&local_c0,&local_d0,local_c);
  local_a4 = FUN_ram_0001136a(2,0x13,0,0x40318000,local_c);
  uVar1 = (*(code *)PTR_FUN_ram_000110f4_ram_00012648)
                    (0x41a40000,0x41ac0000,local_c,PTR_FUN_ram_000110f4_ram_00012648);
`;
const ADDRESSES = {
  rea_riscv_abi_pick: "0x110f4",
  rea_riscv_abi_wide: "0x11130",
  rea_riscv_abi_mixed: "0x1117e",
  rea_riscv_abi_split: "0x111e6",
  rea_riscv_abi_pair: "0x11256",
  rea_riscv_abi_tagged: "0x11296",
  rea_riscv_abi_large: "0x112d2",
  rea_riscv_abi_quad: "0x11316",
  rea_riscv_abi_variadic: "0x1136a",
};

// The single-float fixture's callers, built by LLVM 19 at -O0 with ESP32-H4's
// -march=rv32imafc_zicsr_zifencei -mabi=ilp32f.
const SINGLE_LISTING = `
00011408 <rea_riscv_abi_caller>:
11408: addi sp, sp, -0xe0
1140a: sw ra, 0xdc(sp)
1140c: sw s0, 0xd8(sp)
1140e: addi s0, sp, 0xe0
11410: sw a0, -0xc(s0)
11414: lw a0, -0xc(s0)
11418: lui a1, 0x3fc00
1141c: fmv.w.x fa0, a1
11420: lui a1, 0x40200
11424: fmv.w.x fa1, a1
11428: jal 0x110f4 <rea_riscv_abi_pick>
1142a: fsw fa0, -0x10(s0)
1142e: lw a2, -0xc(s0)
11432: li a0, 0x0
11434: sw a0, -0xd4(s0)
11438: lui a1, 0x400a0
1143c: jal 0x11130 <rea_riscv_abi_wide>
1143e: lw a3, -0xd4(s0)
11442: sw a1, -0x14(s0)
11446: sw a0, -0x18(s0)
1144a: lw a0, -0xc(s0)
1144e: lui a1, 0x40b00
11452: fmv.w.x fa0, a1
11456: lui a2, 0x40130
1145a: lui a4, 0x40188
1145e: mv a1, a3
11460: jal 0x1117e <rea_riscv_abi_mixed>
11462: lw a7, -0xd4(s0)
11466: sw a1, -0x1c(s0)
1146a: sw a0, -0x20(s0)
1146e: lw a6, -0xc(s0)
11472: mv a1, sp
11474: lui a0, 0x401d0
11478: sw a0, 0x0(a1)
1147a: li a0, 0x1
1147c: li a1, 0x2
1147e: sw a1, -0xd8(s0)
11482: li a2, 0x3
11484: li a3, 0x4
11486: li a4, 0x5
11488: li a5, 0x6
1148a: jal 0x111e6 <rea_riscv_abi_split>
1148c: sw a1, -0x24(s0)
11490: sw a0, -0x28(s0)
11494: lui a0, 0x41080
11498: sw a0, -0x38(s0)
1149c: lui a0, 0x41180
114a0: sw a0, -0x34(s0)
114a4: flw fa0, -0x38(s0)
114a8: flw fa1, -0x34(s0)
114ac: lui a0, 0x41280
114b0: fmv.w.x fa2, a0
114b4: jal 0x11256 <rea_riscv_abi_pair>
114b6: fsw fa0, -0x30(s0)
114ba: fsw fa1, -0x2c(s0)
114be: lui a0, 0x41380
114c2: sw a0, -0x48(s0)
114c6: li a0, 0xc
114c8: sw a0, -0x44(s0)
114cc: lw a1, -0xc(s0)
114d0: flw fa0, -0x48(s0)
114d4: lw a0, -0x44(s0)
114d8: jal 0x11296 <rea_riscv_abi_tagged>
114da: mv a1, a0
114dc: lw a0, -0xd4(s0)
114e0: fsw fa0, -0x40(s0)
114e4: sw a1, -0x3c(s0)
114e8: lui a1, 0x402b0
114ec: sw a1, -0x74(s0)
114f0: sw a0, -0x78(s0)
114f4: lui a1, 0x402d0
114f8: sw a1, -0x6c(s0)
114fc: sw a0, -0x70(s0)
11500: lui a0, 0x41780
11504: sw a0, -0x68(s0)
11508: lw a0, -0x64(s0)
1150c: sw a0, -0x7c(s0)
11510: lw a0, -0x68(s0)
11514: sw a0, -0x80(s0)
11518: lw a0, -0x6c(s0)
1151c: sw a0, -0x84(s0)
11520: lw a0, -0x70(s0)
11524: sw a0, -0x88(s0)
11528: lw a0, -0x74(s0)
1152c: sw a0, -0x8c(s0)
11530: lw a0, -0x78(s0)
11534: sw a0, -0x90(s0)
11538: lui a0, 0x41840
1153c: fmv.w.x fa0, a0
11540: addi a0, s0, -0x60
11544: addi a1, s0, -0x90
11548: jal 0x112d2 <rea_riscv_abi_large>
1154a: lw a0, -0xd4(s0)
1154e: lw a2, -0xc(s0)
11552: lui a1, 0x40037
11556: addi a1, a1, -0x800
1155a: sw a1, -0xc4(s0)
1155e: sw a0, -0xc8(s0)
11562: sw a0, -0xcc(s0)
11566: sw a0, -0xd0(s0)
1156a: addi a0, s0, -0xc0
1156e: addi a1, s0, -0xd0
11572: jal 0x11316 <rea_riscv_abi_quad>
11574: lw a0, -0xd8(s0)
11578: lw a6, -0xd4(s0)
1157c: lw a1, -0xc0(s0)
11580: lw a2, -0xbc(s0)
11584: lw a3, -0xb8(s0)
11588: lw a4, -0xb4(s0)
1158c: sw a4, -0x94(s0)
11590: sw a3, -0x98(s0)
11594: sw a2, -0x9c(s0)
11598: sw a1, -0xa0(s0)
1159c: lw a4, -0xc(s0)
115a0: mv a2, sp
115a2: li a1, 0x13
115a4: sw a1, 0x0(a2)
115a6: lui a3, 0x40318
115aa: lui a7, 0x40328
115ae: mv a2, a6
115b0: jal 0x1136a <rea_riscv_abi_variadic>
115b2: sw a0, -0xa4(s0)
115b6: lui a0, 0x12
115ba: lw a1, 0x7f4(a0)
115be: lw a0, -0xc(s0)
115c2: lui a2, 0x41a40
115c6: fmv.w.x fa0, a2
115ca: lui a2, 0x41ac0
115ce: fmv.w.x fa1, a2
115d2: jalr a1
115d4: fsw fa0, -0xa8(s0)
115d8: lw a0, -0x10(s0)
115dc: lw a1, -0x14(s0)
115e0: xor a0, a0, a1
115e2: lw a1, -0x1c(s0)
115e6: xor a0, a0, a1
115e8: lw a1, -0x24(s0)
115ec: xor a0, a0, a1
115ee: lw a1, -0x30(s0)
115f2: xor a0, a0, a1
115f4: lw a1, -0x3c(s0)
115f8: xor a0, a0, a1
115fa: lw a1, -0x54(s0)
115fe: xor a0, a0, a1
11600: lw a1, -0x94(s0)
11604: xor a0, a0, a1
11606: lw a1, -0xa4(s0)
1160a: xor a0, a0, a1
1160c: lw a1, -0xa8(s0)
11610: xor a0, a0, a1
11612: lw ra, 0xdc(sp)
11614: lw s0, 0xd8(sp)
11616: addi sp, sp, 0xe0
11618: ret
000116bc <rea_riscv_abi_single_caller>:
116bc: addi sp, sp, -0x40
116be: sw ra, 0x3c(sp)
116c0: sw s0, 0x38(sp)
116c2: addi s0, sp, 0x40
116c4: sw a0, -0xc(s0)
116c8: li a0, 0x2a
116cc: sb a0, -0x1c(s0)
116d0: lui a0, 0x41b40
116d4: sw a0, -0x18(s0)
116d8: flw fa0, -0x18(s0)
116dc: lbu a0, -0x1c(s0)
116e0: lui a1, 0x41bc0
116e4: fmv.w.x fa1, a1
116e8: jal 0x1161a <rea_riscv_abi_flagged>
116ea: sb a0, -0x14(s0)
116ee: fsw fa0, -0x10(s0)
116f2: lui a0, 0x41dc0
116f6: sw a0, -0x28(s0)
116fa: li a0, 0x1c
116fc: sw a0, -0x24(s0)
11700: lw a1, -0x24(s0)
11704: lw a0, -0x28(s0)
11708: lui a2, 0x3f800
1170c: fmv.w.x fa0, a2
11710: lui a2, 0x40000
11714: fmv.w.x fa1, a2
11718: lui a2, 0x40400
1171c: fmv.w.x fa2, a2
11720: lui a2, 0x40800
11724: fmv.w.x fa3, a2
11728: lui a2, 0x40a00
1172c: fmv.w.x fa4, a2
11730: lui a2, 0x40c00
11734: fmv.w.x fa5, a2
11738: lui a2, 0x40e00
1173c: fmv.w.x fa6, a2
11740: lui a2, 0x41000
11744: fmv.w.x fa7, a2
11748: lui a2, 0x41ec0
1174c: jal 0x11666 <rea_riscv_abi_fill>
1174e: fsw fa0, -0x20(s0)
11752: lui a0, 0x12
11756: lw a2, 0x7f8(a0)
1175a: lui a0, 0x41fc0
1175e: sw a0, -0x38(s0)
11762: li a0, 0x20
11766: sw a0, -0x34(s0)
1176a: lw a1, -0xc(s0)
1176e: flw fa0, -0x38(s0)
11772: lw a0, -0x34(s0)
11776: jalr a2
11778: fsw fa0, -0x30(s0)
1177c: sw a0, -0x2c(s0)
11780: lbu a0, -0x14(s0)
11784: lw a1, -0x20(s0)
11788: xor a0, a0, a1
1178a: lw a1, -0x2c(s0)
1178e: xor a0, a0, a1
11790: lw ra, 0x3c(sp)
11792: lw s0, 0x38(sp)
11794: addi sp, sp, 0x40
11796: ret
`;

// Ghidra 12.1.4 HighFunction prototypes of the same build with __rea_ilp32f,
// typed and stripped.
const SINGLE_DERIVED = `
rea_riscv_abi_pick float@fa0:4 | a:float@fa0:4 | b:float@fa1:4 | sel:int@a0:4
rea_riscv_abi_wide double@a1:4,a0:4 | a:double@a1:4,a0:4 | sel:int@a2:4
rea_riscv_abi_mixed double@a1:4,a0:4 | i:int@a0:4 | d:double@a2:4,a1:4 | f:float@fa0:4 | e:double@a4:4,a3:4
rea_riscv_abi_split double@a1:4,a0:4 | a:int@a0:4 | b:int@a1:4 | c:int@a2:4 | d:int@a3:4 | e:int@a4:4 | f:int@a5:4 | g:int@a6:4 | x:double@Stack[0x0]:4,a7:4
rea_riscv_abi_pair rea_riscv_abi_pair@fa1:4,fa0:4 | value:rea_riscv_abi_pair@fa1:4,fa0:4 | scale:float@fa2:4
rea_riscv_abi_tagged rea_riscv_abi_tagged@a0:4,fa0:4 | value:rea_riscv_abi_tagged@a0:4,fa0:4 | tag:int@a1:4
rea_riscv_abi_large rea_riscv_abi_large *@a0:4 | __return_storage_ptr__:rea_riscv_abi_large *@a0:4 (auto) | value:rea_riscv_abi_large *@a1:4 | scale:float@fa0:4
rea_riscv_abi_quad long double *@a0:4 | __return_storage_ptr__:long double *@a0:4 (auto) | value:long double *@a1:4 | sel:int@a2:4
rea_riscv_abi_variadic uint@a0:4 | count:int@a0:4
rea_riscv_abi_flagged rea_riscv_abi_flagged@fa0:4,a0:4 | value:rea_riscv_abi_flagged@fa0:4,a0:4 | scale:float@fa1:4
rea_riscv_abi_fill float@fa0:4 | a:float@fa0:4 | b:float@fa1:4 | c:float@fa2:4 | d:float@fa3:4 | e:float@fa4:4 | f:float@fa5:4 | g:float@fa6:4 | h:float@fa7:4 | value:rea_riscv_abi_tagged@a1:4,a0:4 | z:float@a2:4
`;
const SINGLE_STRIPPED = `
rea_riscv_abi_pick undefined4@fa0:4 | param_1:undefined4@fa0:4 | param_2:undefined4@fa1:4 | param_3:int@a0:4
rea_riscv_abi_wide undefined8@a1:4,a0:4 | param_1:undefined4@a0:4 | param_2:undefined4@a1:4 | param_3:int@a2:4
rea_riscv_abi_mixed undefined8@a1:4,a0:4 | param_1:undefined4@fa0:4 | param_2:int@a0:4 | param_3:undefined4@a1:4 | param_4:undefined4@a2:4 | param_5:undefined4@a3:4 | param_6:undefined4@a4:4
rea_riscv_abi_split undefined8@a1:4,a0:4 | param_1:uint@a0:4 | param_2:uint@a1:4 | param_3:uint@a2:4 | param_4:uint@a3:4 | param_5:uint@a4:4 | param_6:uint@a5:4 | param_7:uint@a6:4 | param_8:undefined4@a7:4 | param_9:undefined4@Stack[0x0]:4
rea_riscv_abi_pair undefined8@fa1:4,fa0:4 | param_1:undefined4@fa0:4 | param_2:undefined4@fa1:4 | param_3:undefined4@fa2:4
rea_riscv_abi_tagged undefined4@a0:4 | param_1:undefined4@a0:4 | param_2:undefined4@a1:4
rea_riscv_abi_large void@<VOID> | param_1:uint@fa0:4 | param_2:undefined4 *@a0:4 | param_3:undefined4 *@a1:4
rea_riscv_abi_quad void@<VOID> | param_1:undefined4 *@a0:4 | param_2:undefined4 *@a1:4 | param_3:undefined4@a2:4
rea_riscv_abi_variadic uint@a0:4 | param_1:int@a0:4
rea_riscv_abi_flagged byte@a0:1 | param_1:undefined4@fa0:4 | param_2:undefined4@fa1:4 | param_3:byte@a0:1
rea_riscv_abi_fill undefined4@fa0:4 | param_1:undefined4@a0:4 | param_2:uint@a1:4 | param_3:uint@a2:4
`;
const SINGLE_TYPED_CALLERS = {
  rea_riscv_abi_caller: `
  local_10 = rea_riscv_abi_pick(1.5,2.5,sel);
  local_18 = rea_riscv_abi_wide(3.25,local_c);
  local_20 = rea_riscv_abi_mixed(local_c,4.75,5.5,6.125);
  local_28 = rea_riscv_abi_split(1,2,3,4,5,6,local_c,7.25);
  rVar2 = rea_riscv_abi_pair((rea_riscv_abi_pair)0x4118000041080000,10.5);
  rVar3 = rea_riscv_abi_tagged((rea_riscv_abi_tagged)0xc41380000,local_c);
  rea_riscv_abi_large(&rStack_60,&local_90,16.5);
  rea_riscv_abi_quad((long_double *)&local_c0,(long_double *)&local_d0,local_c);
  local_a4 = rea_riscv_abi_variadic(2,0x13,0,0x40318000,local_c);
  fVar1 = (*rea_riscv_abi_callback)(20.5,21.5,local_c);
`,
  rea_riscv_abi_single_caller: `
  rVar3 = rea_riscv_abi_flagged((rea_riscv_abi_flagged)0x41b400000000002a,23.5);
  fVar1 = rea_riscv_abi_fill(1.0,2.0,3.0,4.0,5.0,6.0,7.0,8.0,(rea_riscv_abi_tagged)0x1c41dc0000,29.5
                            );
  rVar2 = (*rea_riscv_abi_tagged_callback)((rea_riscv_abi_tagged)0x2041fc0000,sel);
`,
};
// The stripped caller reads tagged's float half as extraout_fa0: without types
// Ghidra cannot recover a return split between fa0 and a0.
const SINGLE_STRIPPED_CALLERS = {
  rea_riscv_abi_caller: `
  undefined4 extraout_fa0;
  local_10 = FUN_ram_000110f4(0x3fc00000,0x40200000,param_1);
  local_18 = FUN_ram_00011130(0,0x400a0000,local_c);
  local_20 = FUN_ram_0001117e(0x40b00000,local_c,0,0x40130000,0,0x40188000);
  local_28 = FUN_ram_000111e6(1,2,3,4,5,6,local_c,0,0x401d0000);
  local_30 = FUN_ram_00011256(0x41080000,0x41180000,0x41280000);
  local_3c = FUN_ram_00011296(0x41380000,0xc,local_c);
  local_40 = extraout_fa0;
  FUN_ram_000112d2(0x41840000,auStack_60,&local_90);
  FUN_ram_00011316(&local_c0,&local_d0,local_c);
  local_a4 = FUN_ram_0001136a(2,0x13,0,0x40318000,local_c);
  uVar1 = (*(code *)PTR_FUN_ram_000110f4_ram_000127f4)
                    (0x41a40000,0x41ac0000,local_c,PTR_FUN_ram_000110f4_ram_000127f4);
`,
  rea_riscv_abi_single_caller: `
  bVar1 = FUN_ram_0001161a(0x41b40000,0x41bc0000,0x2a);
  uVar3 = FUN_ram_00011666(0x3f800000,0x40000000,0x40400000,0x40800000,0x40a00000,0x40c00000,
                           0x40e00000,0x41000000,0x41dc0000,0x1c,0x41ec0000);
  uVar2 = (*(code *)PTR_FUN_ram_00011296_ram_000127f8)
                    (0x41fc0000,0x20,param_1,PTR_FUN_ram_00011296_ram_000127f8);
`,
};
const SINGLE_ADDRESSES = {
  ...ADDRESSES,
  rea_riscv_abi_flagged: "0x1161a",
  rea_riscv_abi_fill: "0x11666",
};

describe("RISC-V ilp32 conformance checks", () => {
  it("keeps every call-site word at its storage location", () => {
    expect(() => assertRiscvAbiTableConsistent("ilp32")).not.toThrow();
    expect(riscvStorageLocations("Stack[0x0]:4,a7:4")).toEqual([
      "Stack[0x0]",
      "a7",
    ]);
    expect(riscvStorageLocations("a0:4 (auto)")).toEqual(["a0"]);
  });

  it("recovers the words the compiler's call sites write", () => {
    const calls = parseRiscvCallSites(LISTING);
    expect(calls.map((call) => call.target)).toEqual([
      "rea_riscv_abi_pick",
      "rea_riscv_abi_wide",
      "rea_riscv_abi_mixed",
      "rea_riscv_abi_split",
      "rea_riscv_abi_pair",
      "rea_riscv_abi_tagged",
      "rea_riscv_abi_large",
      "rea_riscv_abi_quad",
      "rea_riscv_abi_variadic",
      "indirect",
    ]);
    expect(new Set(calls.map((call) => call.caller))).toEqual(
      new Set(["rea_riscv_abi_caller"]),
    );
    expect(() => assertRiscvCallSites("ilp32", calls)).not.toThrow();
    // The variadic pairs skip a1, which still holds the stack argument.
    expect(calls[8]?.words).toMatchObject({
      a1: { word: 19 },
      a3: { word: 0x40318000 },
      a7: { word: 0x40328000 },
      "Stack[0x0]": { word: 19 },
    });
  });

  it("refuses a listing whose call site places a value elsewhere", () => {
    const moved = LISTING.replace("lui a1, 0x40200", "lui a2, 0x40200");
    expect(() =>
      assertRiscvCallSites("ilp32", parseRiscvCallSites(moved)),
    ).toThrow(/rea_riscv_abi_pick: a1/u);
    // The long double copy that a1 points at must hold 22.5L's words.
    const copied = LISTING.replace("lui a1, 0x40037", "lui a1, 0x40038");
    expect(() =>
      assertRiscvCallSites("ilp32", parseRiscvCallSites(copied)),
    ).toThrow(/rea_riscv_abi_quad: a1/u);
  });

  it("accepts the derived prototypes and refuses Ghidra's stock ilp32d model", () => {
    expect(() =>
      assertRiscvStorage("ilp32", boundaries(DERIVED)),
    ).not.toThrow();
    expect(() =>
      assertRiscvStorage("ilp32", boundaries(STRIPPED), { stripped: true }),
    ).not.toThrow();
    for (const stock of [DEFAULT_PICK, JOINED_QUAD])
      expect(() =>
        assertRiscvStorage("ilp32", {
          ...boundaries(DERIVED),
          ...boundaries(stock),
        }),
      ).toThrow();
    expect(() =>
      assertRiscvStorage("ilp32", boundaries(DERIVED, "__stdcall")),
    ).toThrow();
    expect(Object.keys(boundaries(DERIVED))).toEqual(
      Object.keys(RISCV_ABIS.ilp32.functions),
    );
  });

  it("checks a stripped build's return storage, not its recovered types", () => {
    const stripped = (text: string) =>
      assertRiscvStorage("ilp32", boundaries(text), { stripped: true });
    expect(() =>
      stripped(STRIPPED.replaceAll("undefined8@", "ulonglong@")),
    ).not.toThrow();
    // A register-pair return that loses its high word is refused.
    expect(() =>
      stripped(
        STRIPPED.replace(
          "rea_riscv_abi_wide undefined8@a1:4,a0:4",
          "rea_riscv_abi_wide undefined4@a0:4",
        ),
      ),
    ).toThrow(/rea_riscv_abi_wide inferred return storage/u);
  });

  it("reads the caller's arguments through the corrected storage", () => {
    const caller = "rea_riscv_abi_caller";
    expect(() =>
      assertRiscvCaller("ilp32", caller, TYPED_CALLER, ADDRESSES),
    ).not.toThrow();
    expect(() =>
      assertRiscvCaller("ilp32", caller, STRIPPED_CALLER, ADDRESSES, {
        stripped: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertRiscvCaller("ilp32", caller, DEFAULT_CALLER, ADDRESSES),
    ).toThrow();
    expect(() =>
      assertRiscvCaller(
        "ilp32",
        caller,
        STRIPPED_CALLER.replace(
          "0x40130000,0x40b00000",
          "0x40b00000,0x40130000",
        ),
        ADDRESSES,
        { stripped: true },
      ),
    ).toThrow(/rea_riscv_abi_mixed call arguments/u);
  });
});

describe("RISC-V ilp32f conformance checks", () => {
  const singleCaller = "rea_riscv_abi_single_caller";

  it("keeps every call-site word at its storage location", () => {
    expect(() => assertRiscvAbiTableConsistent("ilp32f")).not.toThrow();
    expect(RISCV_ABIS.ilp32f.callers).toEqual([
      "rea_riscv_abi_caller",
      singleCaller,
    ]);
  });

  it("recovers float-register and sub-word stack words from both callers", () => {
    const calls = parseRiscvCallSites(SINGLE_LISTING);
    expect(
      calls.map((call) => `${String(call.caller)}:${String(call.target)}`),
    ).toEqual([
      ...[
        "rea_riscv_abi_pick",
        "rea_riscv_abi_wide",
        "rea_riscv_abi_mixed",
        "rea_riscv_abi_split",
        "rea_riscv_abi_pair",
        "rea_riscv_abi_tagged",
        "rea_riscv_abi_large",
        "rea_riscv_abi_quad",
        "rea_riscv_abi_variadic",
        "indirect",
      ].map((target) => `rea_riscv_abi_caller:${target}`),
      ...["rea_riscv_abi_flagged", "rea_riscv_abi_fill", "indirect"].map(
        (target) => `${singleCaller}:${target}`,
      ),
    ]);
    expect(() => assertRiscvCallSites("ilp32f", calls)).not.toThrow();
    // A byte store read back by lbu, and float registers set by fmv.w.x.
    expect(calls[10]?.words).toMatchObject({
      a0: { word: 42 },
      fa0: { word: 0x41b40000 },
      fa1: { word: 0x41bc0000 },
    });
    expect(calls[11]?.words).toMatchObject({ fa7: { word: 0x41000000 } });
  });

  it("reads a word stored as two halfwords", () => {
    const [call] = parseRiscvCallSites(`
00011000 <rea_riscv_abi_single_caller>:
11000: addi sp, sp, -0x20
11002: addi s0, sp, 0x20
11004: li a0, 0x19
11006: sh a0, -0x10(s0)
1100a: li a0, 0x1a
1100c: sh a0, -0xe(s0)
11010: lb a2, -0xe(s0)
11014: lw a1, -0x10(s0)
11018: jal 0x11100 <rea_riscv_abi_spread>
`);
    expect(call?.words).toMatchObject({
      a1: { word: 0x1a0019 },
      a2: { word: 0x1a },
    });
    expect(call?.memory.get(-0x10)).toEqual({ word: 0x1a0019 });
  });

  it("refuses a listing whose float argument moved", () => {
    const moved = SINGLE_LISTING.replace(
      "116e4: fmv.w.x fa1, a1",
      "116e4: fmv.w.x fa2, a1",
    );
    expect(moved).not.toBe(SINGLE_LISTING);
    expect(() =>
      assertRiscvCallSites("ilp32f", parseRiscvCallSites(moved)),
    ).toThrow(/rea_riscv_abi_flagged: fa1/u);
  });

  it("accepts the derived prototypes and refuses misplaced ones", () => {
    const derived = boundaries(SINGLE_DERIVED, "__rea_ilp32f");
    const stripped = (text: string) =>
      assertRiscvStorage("ilp32f", boundaries(text, "__rea_ilp32f"), {
        stripped: true,
      });
    expect(() => assertRiscvStorage("ilp32f", derived)).not.toThrow();
    expect(() => stripped(SINGLE_STRIPPED)).not.toThrow();
    // A stripped float-pair return that loses its high word is refused.
    expect(() =>
      stripped(
        SINGLE_STRIPPED.replace(
          "rea_riscv_abi_pair undefined8@fa1:4,fa0:4",
          "rea_riscv_abi_pair undefined4@fa0:4",
        ),
      ),
    ).toThrow(/rea_riscv_abi_pair inferred return storage/u);
    expect(Object.keys(derived)).toEqual(
      Object.keys(RISCV_ABIS.ilp32f.functions),
    );
    for (const [label, wrong] of [
      // The integer part first: the float takes the more significant word.
      [
        "flagged",
        "rea_riscv_abi_flagged rea_riscv_abi_flagged@a0:4,fa0:4 | value:rea_riscv_abi_flagged@a0:4,fa0:4 | scale:float@fa1:4",
      ],
      // Ghidra's stock ilp32d model joins a float and an int into a pair.
      [
        "tagged",
        "rea_riscv_abi_tagged rea_riscv_abi_tagged@a1:4,a0:4 | value:rea_riscv_abi_tagged@a1:4,a0:4 | tag:int@a2:4",
      ],
      // Stock float entries take a double whole.
      [
        "wide",
        "rea_riscv_abi_wide double@fa0:8 | a:double@fa0:8 | sel:int@a0:4",
      ],
    ] as const)
      expect(
        () =>
          assertRiscvStorage("ilp32f", {
            ...derived,
            ...boundaries(wrong, "__rea_ilp32f"),
          }),
        label,
      ).toThrow();
    expect(() =>
      assertRiscvStorage("ilp32f", boundaries(SINGLE_DERIVED, "__rea_ilp32")),
    ).toThrow();
  });

  it("reads both callers' arguments through the derived storage", () => {
    for (const [caller, pseudocode] of Object.entries(SINGLE_TYPED_CALLERS))
      expect(() =>
        assertRiscvCaller("ilp32f", caller, pseudocode, SINGLE_ADDRESSES),
      ).not.toThrow();
    for (const [caller, pseudocode] of Object.entries(SINGLE_STRIPPED_CALLERS))
      expect(() =>
        assertRiscvCaller("ilp32f", caller, pseudocode, SINGLE_ADDRESSES, {
          stripped: true,
        }),
      ).not.toThrow();
    expect(() =>
      assertRiscvCaller(
        "ilp32f",
        singleCaller,
        SINGLE_TYPED_CALLERS[singleCaller].replace(
          "0x41b400000000002a",
          "0x2a41b40000",
        ),
        SINGLE_ADDRESSES,
      ),
    ).toThrow(/rea_riscv_abi_flagged call arguments/u);
    // A typed caller names no register value outside a prototype.
    expect(() =>
      assertRiscvCaller(
        "ilp32f",
        "rea_riscv_abi_caller",
        `${SINGLE_TYPED_CALLERS.rea_riscv_abi_caller}  uVar5 = in_fa0;\n`,
        SINGLE_ADDRESSES,
      ),
    ).toThrow();
  });
});
