package handler

import (
	"context"

	orderv1 "example.com/platform/proto/order/v1"
	userv1 "example.com/platform/proto/user/v1"
)

type Gateway struct {
	users  userv1.UserServiceClient
	orders orderv1.OrderServiceClient
}

func Serve() {
	g := &Gateway{}
	g.route(context.Background())
}

func (g *Gateway) route(ctx context.Context) {
	g.handleUser(ctx)
	g.handleOrders(ctx)
}

func (g *Gateway) handleUser(ctx context.Context) {
	req := &userv1.GetUserRequest{Id: "1"}
	g.users.GetUser(ctx, req)
}

func (g *Gateway) handleOrders(ctx context.Context) {
	g.orders.ListOrders(ctx, &orderv1.ListOrdersRequest{UserId: "1"})
}
