// 利用者サービスの gRPC 実装。UserService の実体はここにしかない。
package main

import (
	"context"

	userv1 "example.com/platform/proto/acme/user/v1"
)

type server struct {
	userv1.UnimplementedUserServiceServer
	repo *Repo
}

// GetUser は利用者を 1 件返す。
func (s *server) GetUser(ctx context.Context, req *userv1.GetUserRequest) (*userv1.GetUserResponse, error) {
	row, err := s.repo.Find(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	return &userv1.GetUserResponse{Id: row.ID, Name: row.Name}, nil
}

// ListUsers は利用者を列挙する。
func (s *server) ListUsers(ctx context.Context, req *userv1.ListUsersRequest) (*userv1.ListUsersResponse, error) {
	rows, err := s.repo.List(ctx, int(req.Limit))
	if err != nil {
		return nil, err
	}
	out := make([]*userv1.GetUserResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, &userv1.GetUserResponse{Id: row.ID, Name: row.Name})
	}
	return &userv1.ListUsersResponse{Users: out}, nil
}
