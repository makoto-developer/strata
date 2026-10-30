// FooService の実装。proto は別リポジトリにあり、手元には生成クライアントしかない。
package app

import (
	"context"

	foopb "github.example.com/org/client-lib/foo/v1"
)

// 1 つの型で 2 つの service を実装する(埋め込みが複数)。
type FooServer struct {
	foopb.UnimplementedFooServiceServer
	foopb.UnimplementedBarServiceServer
}

func (s *FooServer) GetFoo(ctx context.Context, in *foopb.GetFooReq) (*foopb.GetFooRes, error) {
	return &foopb.GetFooRes{Title: in.Id}, nil
}

func (s *FooServer) Ping(ctx context.Context, in *foopb.PingReq) (*foopb.PingRes, error) {
	return &foopb.PingRes{Ok: "ok"}, nil
}
