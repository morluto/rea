# Isolated source-owned PSP static branch probe. Never run this target.
TARGET = rea_psp_indirect
OBJS = main.o control-flow.o
BUILD_PRX = 0
CFLAGS = -O0 -g -G0 -fno-inline -fno-builtin
ASFLAGS = -g
PSPSDK := $(shell psp-config --pspsdk-path)
include $(PSPSDK)/lib/build.mak
