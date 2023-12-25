import app from './app';
import user from './user';
import party from './party';

export default {
  Query: {
    ...app,
    ...user,
    ...party,
  },
};
