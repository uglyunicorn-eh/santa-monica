import { randomInt } from 'src/utils/strings/random';

interface Pair<T> {
  src: T;
  target: T;
}

type Comparator<T> = (a: T, b: T) => boolean;

/** A uniformly random order of `items` (Fisher–Yates, with a cryptographic random source). */
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Draws who gives a gift to whom: everyone gets exactly one target, never themselves. Every such draw is equally
 * likely, so nobody can guess who drew whom better than by chance: the targets are shuffled, and shuffled again
 * whenever someone drew themselves (about 2.7 tries on average, for any number of people).
 */
export default function santaShuffle<T>(source: T[], cmp: Comparator<T> = (a, b) => a === b): Array<Pair<T>> {
  if (source.length < 2) {
    throw new Error('At least two participants are needed for a draw.');
  }
  for (;;) {
    const targets = shuffle(source);
    if (source.every((src, i) => !cmp(src, targets[i]))) {
      return source.map((src, i) => ({ src, target: targets[i] }));
    }
  }
}
