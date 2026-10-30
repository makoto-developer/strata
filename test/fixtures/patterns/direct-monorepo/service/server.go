// 在庫サービス。proto が同じリポジトリにあり、生成物を挟まない素朴な構成。
package main

import (
	"context"

	inventorypb "example.com/mono/proto"
)

type server struct {
	inventorypb.UnimplementedInventoryServiceServer
}

// Reserve は在庫を確保する。
func (s *server) Reserve(ctx context.Context, req *inventorypb.ReserveRequest) (*inventorypb.ReserveResponse, error) {
	return &inventorypb.ReserveResponse{Ok: true}, nil
}
