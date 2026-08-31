// 注文サービス。OrderService を実装しつつ、利用者確認と課金を別サービスに委ねる。
//
// 生成クライアントは別リポジトリで tag を打って配布されており、
// import パスは proto の go_package とも proto パッケージ名とも一致しない。
package main

import (
	"context"

	billingv1 "example.com/acme-grpc-clients/gen/billing/v1"
	notificationv1 "example.com/acme-grpc-clients/gen/notification/v1"
	userclient "example.com/acme-grpc-clients/gen/user/v1"
	orderv1 "example.com/platform/proto/acme/order/v1"
)

type server struct {
	orderv1.UnimplementedOrderServiceServer
	users    userclient.UserServiceClient
	billing  billingv1.BillingServiceClient
	notifier notificationv1.NotificationServiceClient
}

// PlaceOrder は注文を確定する。
func (s *server) PlaceOrder(ctx context.Context, req *orderv1.PlaceOrderRequest) (*orderv1.PlaceOrderResponse, error) {
	if _, err := s.users.GetUser(ctx, &userclient.GetUserRequest{Id: req.UserId}); err != nil {
		return nil, err
	}
	if _, err := s.billing.Charge(ctx, &billingv1.ChargeRequest{UserId: req.UserId}); err != nil {
		return nil, err
	}
	// 対応する proto も生成物もワークスペースに無い(未解決として残るべき呼び出し)
	if _, err := s.notifier.SendReceipt(ctx, &notificationv1.SendReceiptRequest{UserId: req.UserId}); err != nil {
		return nil, err
	}
	return &orderv1.PlaceOrderResponse{OrderId: "ord-1"}, nil
}
