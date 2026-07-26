// gRPC クライアントラッパー。RPC と同名のメソッドが「サービス実装(impl)」ではなく
// クライアント呼び出し(rpc エッジ)として解析されることのリグレッションケース。
package client

import (
	"context"

	userv1 "example.com/platform/proto/user/v1"
)

type UserClient struct {
	stub userv1.UserServiceClient
}

// GetUserByID は RPC と同名だが stub へのフォワードなので実装扱いにならないこと。
func (c *UserClient) GetUserByID(ctx context.Context, id string) (*userv1.GetUserReply, error) {
	return c.stub.GetUserByID(ctx, &userv1.GetUserRequest{Id: id})
}
