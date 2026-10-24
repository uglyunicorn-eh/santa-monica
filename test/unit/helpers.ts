import { env, runDurableObjectAlarm } from 'cloudflare:test';

import { UserToken } from 'src/apollo/types';
import { createJwtHelpers } from 'src/utils/jwt';
import { nodeIdToStr } from 'src/utils/strings/nodeId';

import { domain } from 'src/config.json';

export const jwt = () => createJwtHelpers({ privateKey: env.JWT_PRIVATE_KEY, issuer: domain });

/** Creates a user the way `enter` does and returns a session token for it. */
export async function signIn(email: string, name = '') {
  const user = await env.USER.getByName(email).ensure(email);
  if (name) {
    await env.USER.getByName(email).apply([{ type: 'setName', name }]);
  }
  const sub = nodeIdToStr({ kind: 'User', id: user.id });
  const token = await jwt().issueToken<UserToken>('UserToken', { sub, email }, { ttl: 3600 });
  return { ...user, name, nodeId: sub, token, member: { id: user.id, email, name } };
}

/** Runs the party's alarm until its outbox is empty. The alarm may already be running on its own. */
export async function drainOutbox(slug: string) {
  const stub = env.PARTY.getByName(slug);
  for (let i = 0; i < 50; i++) {
    await runDurableObjectAlarm(stub);
    if (await stub.pendingOutbox() === 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Outbox of ${slug} did not drain`);
}
