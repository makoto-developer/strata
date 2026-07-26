import { resolvers } from './resolvers';

export function start(): void {
  console.log('federation subgraph up', Object.keys(resolvers));
}

start();
