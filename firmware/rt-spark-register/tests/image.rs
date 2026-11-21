use rt_spark_register::{
    chip_select, field, gpio_base, masked_write, BitField, GpioLayout, GpioPortClock,
};

const IMAGE_SHA256: &str =
    "e2c7d06f5c3a9c0e12e220dcd7335110b447bce2310263ad668c1729ed828776";

const STM32F4_GPIO: GpioLayout = GpioLayout {
    origin: 0x4002_0000,
    stride: 0x400,
    port_limit: 9,
};

const STM32F1_GPIO: GpioLayout = GpioLayout {
    origin: 0x4001_0800,
    stride: 0x400,
    port_limit: 7,
};

#[test]
fn pin_and_pll_follow_the_caller_layout() {
    assert_eq!(gpio_base(0x5c, STM32F4_GPIO), Some(0x4002_1400));
    assert_eq!(gpio_base(0x5b, STM32F4_GPIO), Some(0x4002_1400));
    assert_eq!(gpio_base(0x20, STM32F4_GPIO), Some(0x4002_0800));
    assert_eq!(gpio_base(0, STM32F1_GPIO), Some(0x4001_0800));
    assert_eq!(gpio_base(0x10, STM32F1_GPIO), Some(0x4001_0c00));

    let word = 0x2400_3010;
    assert_eq!(field(word, BitField { low_bit: 0, width: 6 }), 16);
    assert_eq!(field(word, BitField { low_bit: 6, width: 9 }), 192);
    assert_eq!(field(word, BitField { low_bit: 16, width: 2 }), 0);
    assert_eq!(field(word, BitField { low_bit: 24, width: 4 }), 4);

    let ahb1enr = 0x4002_3830;
    assert_eq!(GpioPortClock::B.write(ahb1enr).mask, 0x02);
    assert_eq!(masked_write(ahb1enr, 0x02).address, ahb1enr);
    assert_eq!(
        chip_select(0x4002_0400, 0x1000),
        rt_spark_register::ChipSelect {
            gpio_base: 0x4002_0400,
            pin_mask: 0x1000,
        }
    );
    assert_eq!(IMAGE_SHA256.len(), 64);
}
