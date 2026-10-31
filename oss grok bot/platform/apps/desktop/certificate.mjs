import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
export function inspectCertificate(pem, address) {
  try {
    const url = new URL(address),
      cert = new X509Certificate(pem),
      host = url.hostname.replace(/^\[|\]$/g, '');
    if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) < Date.now())
      return { valid: false, reason: 'The host certificate is outside its validity period.' };
    if (!(isIP(host) ? cert.checkIP(host) : cert.checkHost(host)))
      return { valid: false, reason: 'The certificate does not match the selected primary host.' };
    return { valid: true, fingerprint: cert.fingerprint256 };
  } catch {
    return { valid: false, reason: 'The host did not provide a valid TLS certificate.' };
  }
}
