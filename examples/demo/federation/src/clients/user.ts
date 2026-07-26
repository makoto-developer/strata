import { UserServiceClient } from './gen/user_pb';

export function getUserClient(): UserServiceClient {
  return new UserServiceClient('user-service:50051');
}
