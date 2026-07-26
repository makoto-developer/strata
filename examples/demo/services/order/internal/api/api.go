package api

import (
	"context"

	orderv1 "example.com/platform/proto/order/v1"
	userv1 "example.com/platform/proto/user/v1"
)

type Server struct {
	users userv1.UserServiceClient
}

func Serve() {
	s := &Server{}
	s.warmup(context.Background())
}

func (s *Server) warmup(ctx context.Context) {
	s.users.GetUser(ctx, &userv1.GetUserRequest{Id: "1"})
}

func (s *Server) ListOrders(ctx context.Context, req *orderv1.ListOrdersRequest) (*orderv1.ListOrdersReply, error) {
	s.users.GetUser(ctx, &userv1.GetUserRequest{Id: req.UserId})
	return &orderv1.ListOrdersReply{}, nil
}
