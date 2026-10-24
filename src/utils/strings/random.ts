const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomInt(max: number): number {
  // Rejection sampling keeps the distribution uniform.
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

export function randomString(length: number, abc: string = ABC): string {
  const result: string[] = [];
  for (let i = 0; i < length; i++) {
    result.push(abc.charAt(randomInt(abc.length)));
  }
  return result.join('');
}
