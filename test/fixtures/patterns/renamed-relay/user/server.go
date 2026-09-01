// 内部の利用者サービス。
package main

import (
	"context"

	apipb "example.com/acme/proto/api"
)

type server struct {
	apipb.UnimplementedUserServiceServer
}

// GetUser は利用者を返す。
func (s *server) GetUser(ctx context.Context, req *apipb.GetUserRequest) (*apipb.GetUserResponse, error) {
	return &apipb.GetUserResponse{Id: req.Id}, nil
}
