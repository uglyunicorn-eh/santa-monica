import app from './app';
import user from './user';
import party, { partyFields } from './party';

export default {
  Query: {
    ...app,
    ...user,
    ...party,
  },
  Party: partyFields,
};
