package app

import (
	"context"

	bpb "github.example.com/org/client-lib/b/v1"
)

type Caller struct {
	b bpb.BServiceClient
}

func (c *Caller) Fetch(ctx context.Context, id string) (string, error) {
	res, err := c.b.GetB(ctx, &bpb.GetBReq{Id: id})
	if err != nil {
		return "", err
	}
	return res.V, nil
}
