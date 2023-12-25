import parties from './parties';
import auth from './auth';

export default {
  Mutation: {
    ...parties,
    ...auth,
  },
};
