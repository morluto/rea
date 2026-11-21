//! Register operations parameterized by the caller's manual.
//!
//! Bases, the captured image hash, and the fitted flash part are not stored
//! here. A table of supported chips is not an installed part, so that value
//! cannot be constructed.

/// GPIO port layout supplied by the caller. Origin and stride are manual facts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpioLayout {
    pub origin: u32,
    pub stride: u32,
    pub port_limit: u8,
}

/// One observed read-modify-write. The address is an argument, not a closed-over base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskedWrite {
    pub address: u32,
    pub mask: u32,
}

/// Chip select passed to an attach helper. The port base is an argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChipSelect {
    pub gpio_base: u32,
    pub pin_mask: u32,
}

/// One bitfield of a register word. The layout is the manual; the word is the image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BitField {
    pub low_bit: u32,
    pub width: u32,
}

pub const fn port_index(index: u8) -> u8 {
    index >> 4
}

pub const fn pin_number(index: u8) -> u8 {
    index & 0x0f
}

pub const fn gpio_base(index: u8, layout: GpioLayout) -> Option<u32> {
    let port = port_index(index);
    if port >= layout.port_limit {
        return None;
    }
    Some(layout.origin.wrapping_add((port as u32).wrapping_mul(layout.stride)))
}

pub const fn field(value: u32, spec: BitField) -> u32 {
    let mask = (1u32 << spec.width) - 1;
    (value >> spec.low_bit) & mask
}

pub const fn masked_write(address: u32, mask: u32) -> MaskedWrite {
    MaskedWrite { address, mask }
}

pub const fn chip_select(gpio_base: u32, pin_mask: u32) -> ChipSelect {
    ChipSelect {
        gpio_base,
        pin_mask,
    }
}

/// `RCC_AHB1ENR` bit for one GPIO port. The register address is an argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpioPortClock {
    A,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
    I,
}

impl GpioPortClock {
    pub const fn mask(self) -> u32 {
        1 << (self as u32)
    }

    pub const fn write(self, ahb1enr: u32) -> MaskedWrite {
        MaskedWrite {
            address: ahb1enr,
            mask: self.mask(),
        }
    }
}

/// The installed SPI flash part. No public constructor: a support table is not an answer.
#[derive(Debug)]
pub struct UnresolvedFlashPart {
    _private: (),
}
