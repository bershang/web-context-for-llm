import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase();
  const mappedIpv4 = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPrivateIPv4(mappedIpv4);

  return (
    value === '::1' ||
    value === '::' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('ff')
  );
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

export async function validatePublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    const error = new Error(`Invalid URL: ${rawUrl}`);
    error.statusCode = 400;
    throw error;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    const error = new Error(`Only http/https URLs are allowed: ${rawUrl}`);
    error.statusCode = 400;
    throw error;
  }

  if (url.username || url.password) {
    const error = new Error('URLs containing embedded credentials are not allowed.');
    error.statusCode = 400;
    throw error;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    const error = new Error('Localhost URLs are not allowed.');
    error.statusCode = 400;
    throw error;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    const error = new Error(`Unable to resolve host: ${hostname}`);
    error.statusCode = 400;
    throw error;
  }

  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    const error = new Error(`Private or local network target is not allowed: ${hostname}`);
    error.statusCode = 400;
    throw error;
  }

  return url;
}
