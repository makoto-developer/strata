package app

import (
	"context"

	apb "github.example.com/org/client-lib/a/v1"
)

type AServer struct {
	apb.UnimplementedAServiceServer
}

func (s *AServer) GetA(ctx context.Context, in *apb.GetAReq) (*apb.GetARes, error) {
	return &apb.GetARes{V: in.Id}, nil
}
