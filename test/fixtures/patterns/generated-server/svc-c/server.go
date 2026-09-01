// 同じ contract をもう 1 つのサービスが実装する(共有 contract の別実装)。
package app

import (
	"context"

	foopb "github.example.com/org/client-lib/foo/v1"
)

type AltFooServer struct {
	foopb.UnimplementedFooServiceServer
}

func (s *AltFooServer) GetFoo(ctx context.Context, in *foopb.GetFooReq) (*foopb.GetFooRes, error) {
	return &foopb.GetFooRes{Title: "alt"}, nil
}
