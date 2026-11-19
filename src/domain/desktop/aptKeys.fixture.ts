/** Two ed25519 vendor keys GnuPG 2.4.4 made on Ubuntu 24.04, each as `gpg --export` writes it. */
export const VENDOR_A = {
  fingerprint: "6C1716CACE3F98B181C3CE346701CFD5B893036C",
  key: Buffer.from(
    "mDMEauuPaBYJKwYBBAHaRw8BAQdAU6pi/2EhXePFnrHKRH29KuHZHwAQElOjI9pN" +
      "c4b8HbG0GFZlbmRvciBBIDxhQGV4YW1wbGUuY29tPoiZBBMWCgBBFiEEbBcWys4/" +
      "mLGBw840ZwHP1biTA2wFAmrrj2gCGwMFCQXw8dgFCwkIBwICIgIGFQoJCAsCBBYC" +
      "AwECHgcCF4AACgkQZwHP1biTA2x38AD/TyC+wrSKRFUaH3E/VTwobbbg5wZbGYMk" +
      "n1ytPPD61xkA/j+dC/mvcEkT5YfMLx7KFPrlRnp+SAAWZBzW9ywLNo4A",
    "base64",
  ),
};

export const VENDOR_B = {
  fingerprint: "C28D7F3337C79AEBD7DD4976FAE5192163FCA268",
  key: Buffer.from(
    "mDMEauuPaBYJKwYBBAHaRw8BAQdA7npYbfFfwg0YB91jv2Ion9nZATrqRjMxfyoM" +
      "zYbuIKW0GFZlbmRvciBCIDxiQGV4YW1wbGUuY29tPoiZBBMWCgBBFiEEwo1/MzfH" +
      "muvX3Ul2+uUZIWP8omgFAmrrj2gCGwMFCQXw8dgFCwkIBwICIgIGFQoJCAsCBBYC" +
      "AwECHgcCF4AACgkQ+uUZIWP8omi6wwEAwdUiyGmAnfqDDEbm5jx1LyKa7NtHEEcH" +
      "FNiRbBi99DQBAJTsAHBzv2QhQ4t3tCelAnVI/u7T47wfKi3NgIp1MBkC",
    "base64",
  ),
};

/** `gpg --armor --export A`, GnuPG 2.4.9. */
export const A_ARMORED = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEauuPaBYJKwYBBAHaRw8BAQdAU6pi/2EhXePFnrHKRH29KuHZHwAQElOjI9pN
c4b8HbG0GFZlbmRvciBBIDxhQGV4YW1wbGUuY29tPoiZBBMWCgBBFiEEbBcWys4/
mLGBw840ZwHP1biTA2wFAmrrj2gCGwMFCQXw8dgFCwkIBwICIgIGFQoJCAsCBBYC
AwECHgcCF4AACgkQZwHP1biTA2x38AD/TyC+wrSKRFUaH3E/VTwobbbg5wZbGYMk
n1ytPPD61xkA/j+dC/mvcEkT5YfMLx7KFPrlRnp+SAAWZBzW9ywLNo4A
=Em8s
-----END PGP PUBLIC KEY BLOCK-----
`;

/** `gpg --armor --export B`, GnuPG 2.4.9. */
export const B_ARMORED = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEauuPaBYJKwYBBAHaRw8BAQdA7npYbfFfwg0YB91jv2Ion9nZATrqRjMxfyoM
zYbuIKW0GFZlbmRvciBCIDxiQGV4YW1wbGUuY29tPoiZBBMWCgBBFiEEwo1/MzfH
muvX3Ul2+uUZIWP8omgFAmrrj2gCGwMFCQXw8dgFCwkIBwICIgIGFQoJCAsCBBYC
AwECHgcCF4AACgkQ+uUZIWP8omi6wwEAwdUiyGmAnfqDDEbm5jx1LyKa7NtHEEcH
FNiRbBi99DQBAJTsAHBzv2QhQ4t3tCelAnVI/u7T47wfKi3NgIp1MBkC
=OjLx
-----END PGP PUBLIC KEY BLOCK-----
`;

/** The Signed-By field `add-apt-repository ppa:…` writes for a key on Ubuntu 24.04: each line indented, an empty one as ` .`. */
export const inlineSignedBy = (armored: string): string =>
  [
    "Signed-By: ",
    ...armored
      .trimEnd()
      .split("\n")
      .map((line) => (line === "" ? " ." : ` ${line}`)),
  ].join("\n");

/** `gpg --armor --export A B`: both keys in one armor block. */
export const BOTH_ARMORED = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEauuPaBYJKwYBBAHaRw8BAQdAU6pi/2EhXePFnrHKRH29KuHZHwAQElOjI9pN
c4b8HbG0GFZlbmRvciBBIDxhQGV4YW1wbGUuY29tPoiZBBMWCgBBFiEEbBcWys4/
mLGBw840ZwHP1biTA2wFAmrrj2gCGwMFCQXw8dgFCwkIBwICIgIGFQoJCAsCBBYC
AwECHgcCF4AACgkQZwHP1biTA2x38AD/TyC+wrSKRFUaH3E/VTwobbbg5wZbGYMk
n1ytPPD61xkA/j+dC/mvcEkT5YfMLx7KFPrlRnp+SAAWZBzW9ywLNo4AmDMEauuP
aBYJKwYBBAHaRw8BAQdA7npYbfFfwg0YB91jv2Ion9nZATrqRjMxfyoMzYbuIKW0
GFZlbmRvciBCIDxiQGV4YW1wbGUuY29tPoiZBBMWCgBBFiEEwo1/MzfHmuvX3Ul2
+uUZIWP8omgFAmrrj2gCGwMFCQXw8dgFCwkIBwICIgIGFQoJCAsCBBYCAwECHgcC
F4AACgkQ+uUZIWP8omi6wwEAwdUiyGmAnfqDDEbm5jx1LyKa7NtHEEcHFNiRbBi9
9DQBAJTsAHBzv2QhQ4t3tCelAnVI/u7T47wfKi3NgIp1MBkC
=5Myd
-----END PGP PUBLIC KEY BLOCK-----
`;

/** A Release clearsigned by both keys with `gpg -u A -u B --clearsign`, as an InRelease. */
export const SIGNED_BY_BOTH = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Origin: example
Label: example
Suite: stable
Codename: stable
-----BEGIN PGP SIGNATURE-----

iHUEARYKAB0WIQRsFxbKzj+YsYHDzjRnAc/VuJMDbAUCauuPaAAKCRBnAc/VuJMD
bLhpAP9yQJK3bOAJv7wR/vrKkIJzfhojuodYk3oFiN6NO7LRrgEA9X7ZNFdBBrSM
MfPdLmzaDgyBSNTogCOR5TIs04fcmgyIdQQBFgoAHRYhBMKNfzM3x5rr191Jdvrl
GSFj/KJoBQJq649oAAoJEPrlGSFj/KJo43MA/0gL17mIp0G3EzvJOrhm90quId7o
cVyCYu6RZ3Sj7QUwAP0Rcr0se3BN61bGOOi2sU73A4+ahQF7l/57P+2OEc/NAQ==
=L7rN
-----END PGP SIGNATURE-----
`;

/** gpgv 2.4.4's status for SIGNED_BY_BOTH checked with A's key alone; it exits 2. */
export const GPGV_A_ONLY = [
  "[GNUPG:] NEWSIG",
  "[GNUPG:] KEY_CONSIDERED 6C1716CACE3F98B181C3CE346701CFD5B893036C 0",
  "[GNUPG:] SIG_ID cTQ2/4l/vWO2WQ3s8vbt1dxME1M 2026-11-04 1793822568",
  "[GNUPG:] GOODSIG 6701CFD5B893036C Vendor A <a@example.com>",
  "[GNUPG:] VALIDSIG 6C1716CACE3F98B181C3CE346701CFD5B893036C 2026-11-04 1793822568 0 4 0 22 10 01 6C1716CACE3F98B181C3CE346701CFD5B893036C",
  "[GNUPG:] NEWSIG",
  "[GNUPG:] ERRSIG FAE5192163FCA268 22 10 01 1793822568 9 C28D7F3337C79AEBD7DD4976FAE5192163FCA268",
  "[GNUPG:] NO_PUBKEY FAE5192163FCA268",
  "",
].join("\n");
