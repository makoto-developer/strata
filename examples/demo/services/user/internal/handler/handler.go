package handler

import (
	"context"

	userv1 "example.com/platform/proto/user/v1"
	"example.com/platform/services/user/internal/metrics"
	"example.com/platform/services/user/internal/store"
)

type Server struct{}

func Register() {
	_ = &Server{}
}

// GetUser はストアからユーザーを引いて返す gRPC ハンドラ。
func (s *Server) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserReply, error) {
	metrics.Count("get_user")
	name := store.Get(req.Id)
	return &userv1.GetUserReply{Name: name}, nil
}

func (s *Server) ListUsers(ctx context.Context, req *userv1.ListUsersRequest) (*userv1.ListUsersReply, error) {
	metrics.Count("list_users")
	_ = store.List()
	return &userv1.ListUsersReply{}, nil
}
