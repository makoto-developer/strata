import { getUserClient } from './clients/user';
import { formatUser } from '@lib/format';

export const resolvers = {
  Query: {
    user: async (_parent: unknown, args: { id: string }) => {
      const client = getUserClient();
      const reply = await client.getUser({ id: args.id });
      return formatUser(reply);
    },
  },
};
