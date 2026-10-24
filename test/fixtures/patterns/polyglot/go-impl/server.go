// 検索サービスの実装。
package main

import (
	"context"

	searchv1 "example.com/acme/proto/search/v1"
)

type server struct {
	searchv1.UnimplementedSearchServiceServer
}

// Query は検索を実行する。
func (s *server) Query(ctx context.Context, req *searchv1.QueryRequest) (*searchv1.QueryResponse, error) {
	return &searchv1.QueryResponse{Hits: []string{req.Q}}, nil
}

// Suggest は入力補完を返す。
func (s *server) Suggest(ctx context.Context, req *searchv1.SuggestRequest) (*searchv1.SuggestResponse, error) {
	return &searchv1.SuggestResponse{Words: []string{req.Prefix}}, nil
}
