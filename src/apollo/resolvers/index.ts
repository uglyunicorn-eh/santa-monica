import app from './app';
import user from './user';

export default {
  Query: {
    ...app,
    ...user,
  },
};
