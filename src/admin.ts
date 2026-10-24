import { Context } from 'hono';

import { ImportSnapshot } from 'src/do/types';
import { Env } from 'src/env';

const safeEqual = (a: string, b: string) => {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
};

/**
 * Temporary endpoint for the one-off Mongo import (scripts/import.ts). Disabled unless ADMIN_SECRET is set.
 * Remove it, and the secret, after cutover.
 */
export const importHandler = async (c: Context<{ Bindings: Env }>) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret || !safeEqual(c.req.header('x-admin-secret') ?? '', secret)) {
    return c.notFound();
  }

  const snapshot = await c.req.json<ImportSnapshot>();

  const users = await Promise.all(
    snapshot.users.map(user => c.env.USER.getByName(user.email).importUser(user)),
  );
  const parties = await Promise.all(
    snapshot.parties.map(party => c.env.PARTY.getByName(party.slug).importParty(party)),
  );

  return c.json({
    status: 'ok',
    imported: {
      users: users.length,
      userParties: users.reduce((n, u) => n + u.parties, 0),
      parties: parties.length,
      memberships: parties.reduce((n, p) => n + p.memberships, 0),
    },
  });
};
