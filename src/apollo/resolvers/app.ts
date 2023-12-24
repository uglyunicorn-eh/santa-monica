import { author, name, version } from 'package.json';

export default {
  app: async () => ({
    author,
    name,
    version,
  }),
};
