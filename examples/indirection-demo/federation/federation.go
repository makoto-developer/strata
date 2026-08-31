// 複数サービスの API を 1 つの入口にまとめる層(注文はそのまま下流へ転送する)。
package main

import (
	"context"

	orderv1 "example.com/platform/proto/acme/order/v1"
)

type Federation struct {
	orderv1.UnimplementedOrderServiceServer
	orders orderv1.OrderServiceClient
}

// PlaceOrder は下流の注文サービスへ転送する。
func (f *Federation) PlaceOrder(ctx context.Context, req *orderv1.PlaceOrderRequest) (*orderv1.PlaceOrderResponse, error) {
	return f.orders.PlaceOrder(ctx, req)
}
