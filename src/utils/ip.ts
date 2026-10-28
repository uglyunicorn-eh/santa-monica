/**
 * The key a client's address is rate limited under. One IPv6 connection usually owns a whole /64 (2^64 addresses), so
 * IPv6 is counted per /64, as `a:b:c:d::/64`; IPv4 per address. An IPv4-mapped IPv6 address counts as its IPv4 one.
 * Anything that isn't a well-formed address is used as it is.
 */
export function rateLimitKey(ip: string): string {
  if (!ip.includes(':')) {
    return ip;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) {
    return mapped[1];
  }
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) {
    return ip;
  }
  const [head, tail] = halves.map(half => (half ? half.split(':') : []));
  const missing = 8 - head.length - (tail?.length ?? 0);
  if (tail ? missing < 1 : missing !== 0) {
    return ip;
  }
  const groups = [...head, ...Array<string>(missing).fill('0'), ...(tail ?? [])];
  if (!groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) {
    return ip;
  }
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
