// 公開 API を内部 API へ橋渡しする。RPC 名が変わるので素通しの中継とは呼べない。
package main

import (
	"context"

	apipb "example.com/acme/proto/api"
)

type Gateway struct {
	apipb.UnimplementedPublicServiceServer
	users apipb.UserServiceClient
}

// ResolveAccount は公開 API の名前で内部の GetUser を呼ぶ。
func (g *Gateway) ResolveAccount(ctx context.Context, req *apipb.ResolveAccountRequest) (*apipb.ResolveAccountResponse, error) {
	res, err := g.users.GetUser(ctx, &apipb.GetUserRequest{Id: req.Handle})
	if err != nil {
		return nil, err
	}
	return &apipb.ResolveAccountResponse{Id: res.Id}, nil
}
