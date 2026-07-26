import { header } from './page';

export function formatUser(reply: { name: string }): string {
  return header() + reply.name;
}
