package app

import (
	"context"

	apb "github.example.com/org/client-lib/a/v1"
	bpb "github.example.com/org/client-lib/b/v1"
)

type BServer struct {
	bpb.UnimplementedBServiceServer
	uc *Usecase
}

func (s *BServer) GetB(ctx context.Context, in *bpb.GetBReq) (*bpb.GetBRes, error) {
	v, err := s.uc.Run(ctx, in.Id)
	return &bpb.GetBRes{V: v}, err
}

type Usecase struct {
	a apb.AServiceClient
}

func (u *Usecase) Run(ctx context.Context, id string) (string, error) {
	res, err := u.a.GetA(ctx, &apb.GetAReq{Id: id})
	if err != nil {
		return "", err
	}
	return res.V, nil
}
