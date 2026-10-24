// 本物のサーバ実装。
package api

import (
	"context"

	userv1 "example.com/platform/proto/user/v1"
)

type Server struct {
	userv1.UnimplementedUserServiceServer
}

func (s *Server) GetUser(ctx context.Context, req *userv1.GetUserReq) (*userv1.GetUserRes, error) {
	return &userv1.GetUserRes{Name: "real"}, nil
}
