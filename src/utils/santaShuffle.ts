import { randomInt } from 'src/utils/strings/random';

interface Pair<T> {
  src: T;
  target: T;
}

type Comparator<T> = (a: T, b: T) => boolean;

export function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export default function santaShuffle<T>(source: T[], cmp: Comparator<T> = (a, b) => a === b): Array<Pair<T>> {
  if (source.length < 2) {
    throw new Error('At least two participants are needed for a draw.');
  }

  let hat = [...source];
  const targets: T[] = [];

  for (let i = 0; i < source.length - 1; ++i) {
    const src = source[i];
    let target: T;
    while (true) {
      hat = shuffle(hat);
      target = hat.pop()!;
      if (!cmp(src, target)) {
        break;
      }
      hat.push(target);
    }
    targets.push(target);
  }

  const last = source[source.length - 1];
  if (cmp(last, hat[0])) {
    targets.push(targets.shift()!);
    targets.unshift(last);
  } else {
    targets.push(hat.pop()!);
  }

  return source.map((src, i) => ({ src, target: targets[i] }));
}
