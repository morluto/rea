const _0x2debe9 = _0x5a1d;
(function (_0x568f9c, _0x35880a) {
  const _0x56cf23 = _0x5a1d,
    _0x163352 = _0x568f9c();
  while (!![]) {
    try {
      const _0x2e4b8f =
        -parseInt(_0x56cf23(0x194)) / 0x1 +
        parseInt(_0x56cf23(0x1a0)) / 0x2 +
        -parseInt(_0x56cf23(0x199)) / 0x3 +
        (-parseInt(_0x56cf23(0x198)) / 0x4) *
          (parseInt(_0x56cf23(0x191)) / 0x5) +
        (parseInt(_0x56cf23(0x1a4)) / 0x6) *
          (-parseInt(_0x56cf23(0x1a3)) / 0x7) +
        (-parseInt(_0x56cf23(0x196)) / 0x8) *
          (-parseInt(_0x56cf23(0x19a)) / 0x9) +
        (parseInt(_0x56cf23(0x192)) / 0xa) * (parseInt(_0x56cf23(0x190)) / 0xb);
      if (_0x2e4b8f === _0x35880a) break;
      else _0x163352["push"](_0x163352["shift"]());
    } catch (_0x35fbad) {
      _0x163352["push"](_0x163352["shift"]());
    }
  }
})(_0x4f29, 0x28f8f);
function computeInvoiceTotal(_0x4fb252, _0x1023a0) {
  const _0x390fcf = _0x5a1d;
  let _0xf390d1 = 0x0;
  for (const _0x509c4c of _0x4fb252) {
    _0xf390d1 += _0x509c4c[_0x390fcf(0x1a7)] * _0x509c4c[_0x390fcf(0x193)];
  }
  const _0x1a9d3b = _0xf390d1 * _0x1023a0;
  return { subtotal: _0xf390d1, tax: _0x1a9d3b, total: _0xf390d1 + _0x1a9d3b };
}
function formatCurrency(_0x560c95, _0x6e5ba0) {
  const _0x27651f = _0x5a1d;
  return new Intl[_0x27651f(0x19f)](_0x27651f(0x19d), {
    style: _0x27651f(0x1a1),
    currency: _0x6e5ba0,
  })[_0x27651f(0x19b)](_0x560c95);
}
class Cart {
  constructor() {
    this["items"] = [];
  }
  [_0x2debe9(0x19c)](_0x2f8a48) {
    this["items"]["push"](_0x2f8a48);
  }
  [_0x2debe9(0x1a6)](_0x3f8891, _0x13425d) {
    const _0x15fa0e = _0x2debe9,
      _0x1e8b6c = computeInvoiceTotal(this[_0x15fa0e(0x197)], _0x3f8891);
    return (
      formatCurrency(_0x1e8b6c[_0x15fa0e(0x19e)], _0x13425d) +
      "\x20(" +
      this["items"]["length"] +
      _0x15fa0e(0x1a5)
    );
  }
}
function _0x5a1d(_0x383814, _0x34fcb0) {
  _0x383814 = _0x383814 - 0x190;
  const _0x4f294c = _0x4f29();
  let _0x5a1d91 = _0x4f294c[_0x383814];
  return _0x5a1d91;
}
const cart = new Cart();
function _0x4f29() {
  const _0x490aee = [
    "quantity",
    "248116WxraKR",
    "5elBAMw",
    "210mowFrw",
    "unitPrice",
    "255161RAWUWx",
    "log",
    "114736qnDLXJ",
    "items",
    "436892fwkoSb",
    "623628agAkkT",
    "153OtamLr",
    "format",
    "add",
    "en-US",
    "total",
    "NumberFormat",
    "379998tcaScn",
    "currency",
    "USD",
    "14MCXstH",
    "502218RICUuE",
    "\x20items)",
    "summary",
  ];
  _0x4f29 = function () {
    return _0x490aee;
  };
  return _0x4f29();
}
(cart["add"]({ quantity: 0x2, unitPrice: 0x4e2 }),
  cart[_0x2debe9(0x19c)]({ quantity: 0x1, unitPrice: 0x1387 }),
  console[_0x2debe9(0x195)](cart[_0x2debe9(0x1a6)](0.0825, _0x2debe9(0x1a2))));
