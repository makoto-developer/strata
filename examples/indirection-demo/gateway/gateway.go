// 外部からの要求を内部サービスへ素通しする中継層(UserService をそのまま転送する)。
package main

import (
	"context"

	userclient "example.com/acme-grpc-clients/gen/user/v1"
	userv1 "example.com/platform/proto/acme/user/v1"
)

type Gateway struct {
	userv1.UnimplementedUserServiceServer
	upstream userclient.UserServiceClient
}

// GetUser は上流の利用者サービスへそのまま転送する。
func (g *Gateway) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserResponse, error) {
	res, err := g.upstream.GetUser(ctx, &userclient.GetUserRequest{Id: req.Id})
	if err != nil {
		return nil, err
	}
	return &userv1.GetUserResponse{Id: res.Id, Name: res.Name}, nil
}
