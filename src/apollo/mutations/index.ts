import parties from './parties';
import auth from './auth';
import profile from './profile';

export default {
  Mutation: {
    ...parties,
    ...auth,
    ...profile,
  },
};
