//! Register layer taken from one captured RT-Spark image.
//!
//! Addresses and operations below were read from instructions. Controller names
//! follow the STM32F407 map. The installed SPI flash part was not settled, so
//! that type cannot be built from a guess.

/// Image SHA-256 this layer was read from.
pub const IMAGE_SHA256: &str =
    "e2c7d06f5c3a9c0e12e220dcd7335110b447bce2310263ad668c1729ed828776";

pub const RCC_BASE: u32 = 0x4002_3800;
pub const RCC_AHB1ENR: u32 = RCC_BASE + 0x30;
pub const RCC_APB2ENR: u32 = RCC_BASE + 0x44;
pub const RCC_PLLCFGR: u32 = RCC_BASE + 0x04;

pub const USART1_BASE: u32 = 0x4001_1000;
pub const GPIOB_BASE: u32 = 0x4002_0400;

/// One observed read-modify-write. The mask is the immediate from the instruction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskedWrite {
    pub address: u32,
    pub mask: u32,
}

/// `0x0800c704` writes this value to `RCC_PLLCFGR`.
pub const PLLCFGR_WRITE: u32 = 0x2400_3010;

/// `0x0800e244` sets USART1EN after comparing the device base with USART1.
pub const USART1_CLOCK: MaskedWrite = MaskedWrite {
    address: RCC_APB2ENR,
    mask: 0x10,
};

/// `0x080604e4` sets GPIOBEN while preparing SPI flash, and loads the GPIOB base.
pub const SPI_FLASH_GPIOB_CLOCK: MaskedWrite = MaskedWrite {
    address: RCC_AHB1ENR,
    mask: 0x02,
};

/// Chip select passed into `rt_hw_spi_device_attach`: GPIOB and pin mask `0x1000`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChipSelect {
    pub gpio_base: u32,
    pub pin_mask: u32,
}

pub const SPI_FLASH_CS: ChipSelect = ChipSelect {
    gpio_base: GPIOB_BASE,
    pin_mask: 0x1000,
};

/// `0x0800e294` sets one bit of `RCC_AHB1ENR` for each GPIO port.
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

    pub const fn write(self) -> MaskedWrite {
        MaskedWrite {
            address: RCC_AHB1ENR,
            mask: self.mask(),
        }
    }
}

/// Pin index immediate passed to the pin wrappers.
/// `0x08073c94` takes bits 7:4 as the port and bits 3:0 as the pin.
/// The index does not name the board device attached to that pin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObservedPinIndex(u8);

impl ObservedPinIndex {
    pub const CALLED: &[ObservedPinIndex] = &[
        ObservedPinIndex(0x5c),
        ObservedPinIndex(0x5b),
        ObservedPinIndex(0x10),
        ObservedPinIndex(0x11),
        ObservedPinIndex(0x53),
        ObservedPinIndex(0x20),
        ObservedPinIndex(0x24),
        ObservedPinIndex(0x25),
        ObservedPinIndex(0x21),
    ];

    pub const fn port_index(self) -> u8 {
        self.0 >> 4
    }

    pub const fn pin(self) -> u8 {
        self.0 & 0x0f
    }

    /// GPIOA is `0x40020000`; each next port is `0x400` higher.
    pub const fn gpio_base(self) -> Option<u32> {
        let port = self.port_index();
        if port >= 9 {
            return None;
        }
        Some(0x4002_0000 + (port as u32) * 0x400)
    }
}

/// One supported JEDEC identity from the image table. Presence is not installation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SupportedFlashId {
    pub jedec: u32,
    pub name: &'static str,
}

/// Six Winbond rows at `0x080a4588`, stride `0x18`. The fitted chip is not among these facts.
pub const SUPPORTED_FLASH_IDS: &[SupportedFlashId] = &[
    SupportedFlashId { jedec: 0x00ef_4015, name: "W25Q16BV" },
    SupportedFlashId { jedec: 0x00ef_4016, name: "W25Q32BV" },
    SupportedFlashId { jedec: 0x00ef_4017, name: "W25Q64CV" },
    SupportedFlashId { jedec: 0x00ef_6017, name: "W25Q64DW" },
    SupportedFlashId { jedec: 0x00ef_4018, name: "W25Q128BV" },
    SupportedFlashId { jedec: 0x00ef_4019, name: "W25Q256FV" },
];

/// The installed SPI flash part. No public constructor: a table name is not an answer.
#[derive(Debug)]
pub struct UnresolvedFlashPart {
    _private: (),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usart_and_spi_clocks_use_the_manual_registers() {
        assert_eq!(USART1_CLOCK.address, 0x4002_3844);
        assert_eq!(USART1_CLOCK.mask, 0x10);
        assert_eq!(SPI_FLASH_GPIOB_CLOCK.mask, 0x02);
        assert_eq!(SPI_FLASH_CS.gpio_base, GPIOB_BASE);
        assert_eq!(SPI_FLASH_CS.pin_mask, 0x1000);
        assert_eq!(GPIOB_BASE, 0x4002_0400);
        assert_eq!(GpioPortClock::F.write().mask, 1 << 5);
        assert_eq!(ObservedPinIndex::CALLED[0], ObservedPinIndex(0x5c));
        assert_eq!(ObservedPinIndex(0x5c).port_index(), 5);
        assert_eq!(ObservedPinIndex(0x5c).pin(), 12);
        assert_eq!(ObservedPinIndex(0x5c).gpio_base(), Some(0x4002_1400));
        assert_eq!(ObservedPinIndex(0x5b).gpio_base(), Some(0x4002_1400));
        assert_eq!(ObservedPinIndex(0x20).gpio_base(), Some(0x4002_0800));
        assert_eq!(ObservedPinIndex(0x20).pin(), 0);
        assert_eq!(SUPPORTED_FLASH_IDS.len(), 6);
        assert!(SUPPORTED_FLASH_IDS.iter().any(|id| id.name == "W25Q64CV"));
        assert!(SUPPORTED_FLASH_IDS.iter().any(|id| id.name == "W25Q128BV"));
        assert_eq!(PLLCFGR_WRITE, 0x2400_3010);
    }
}
