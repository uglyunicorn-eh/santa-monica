import { PartyView } from 'src/do/types';
import { Env } from 'src/env';

/**
 * Signed-out visitors all see the same view of a party, so a party link that goes viral would send every one of them
 * to the same Durable Object. This keeps that view for a few seconds in the isolate's memory, keyed by the party's log
 * ref (never its code). It's memory only, never the Cache API, so party names aren't stored anywhere else. Each
 * isolate keeps its own copy, which is enough: a busy location runs a handful of isolates. A change made through an
 * isolate forgets its copy there; elsewhere a view is at most PUBLIC_VIEW_MS old.
 */

/** How long the stats are kept, unless `PUBLIC_CACHE_MS` says otherwise. */
export const PUBLIC_CACHE_MS = 10_000;

/**
 * How long signed-out views are kept, unless `PUBLIC_CACHE_MS` says otherwise. Shorter than the stats: a change
 * forgets the view only in the isolate that made it (`forgetView`), and others can't be told. For a viral link, it's
 * still at most one call per isolate this often.
 */
export const PUBLIC_VIEW_MS = 3_000;

/** Parties kept at once. A lookup over the limit drops the oldest entry. */
export const MAX_CACHED_VIEWS = 500;

const views = new Map<string, { view: PartyView; until: number }>();

/**
 * When each party's view was last forgotten after a write. A lookup that started before then may carry the view from
 * before the write, so it isn't kept. Capped like `views`, oldest first.
 */
const forgotten = new Map<string, number>();

/** How long public answers are kept in this environment, in ms: `PUBLIC_CACHE_MS`, or `byDefault`. 0 turns caching off. */
export const cacheTtl = (env: Env, byDefault = PUBLIC_CACHE_MS) => Number(env.PUBLIC_CACHE_MS ?? byDefault) || 0;

/** How long signed-out views are kept in this environment, in ms. */
export const viewTtl = (env: Env) => cacheTtl(env, PUBLIC_VIEW_MS);

/** The kept signed-out view of a party, or undefined when there's none or it's too old. */
export function cachedView(ref: string, now = Date.now()): PartyView | undefined {
  const entry = views.get(ref);
  if (entry && entry.until <= now) {
    views.delete(ref);
    return undefined;
  }
  return entry?.view;
}

/**
 * Keeps a signed-out view for `ttl` ms. `startedAt` is when the lookup that read it began: if the party was written
 * (and its view forgotten) since then, the view may be from before that write, so it's not kept.
 */
export function keepView(ref: string, view: PartyView, ttl: number, now = Date.now(), startedAt = now) {
  if (ttl <= 0 || (forgotten.get(ref) ?? -Infinity) >= startedAt) {
    return;
  }
  views.delete(ref);
  if (views.size >= MAX_CACHED_VIEWS) {
    // Maps keep insertion order: the first key is the oldest.
    views.delete(views.keys().next().value!);
  }
  views.set(ref, { view, until: now + ttl });
}

/** Forgets the kept view of a party that just changed, in this isolate, and refuses older lookups' views of it. */
export function forgetView(ref: string, now = Date.now()) {
  views.delete(ref);
  forgotten.delete(ref);
  if (forgotten.size >= MAX_CACHED_VIEWS) {
    forgotten.delete(forgotten.keys().next().value!);
  }
  forgotten.set(ref, now);
}

/** Forgets every kept view. Used by tests. */
export const clearViews = () => {
  views.clear();
  forgotten.clear();
};

/** How many views are kept. Used by tests. */
export const cachedViewCount = () => views.size;
