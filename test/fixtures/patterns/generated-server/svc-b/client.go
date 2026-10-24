// FooService の利用側。生成クライアント越しに呼ぶ。
package app

import (
	"context"

	foopb "github.example.com/org/client-lib/foo/v1"
)

type Client struct {
	foo foopb.FooServiceClient
}

func (c *Client) Fetch(ctx context.Context, id string) (string, error) {
	res, err := c.foo.GetFoo(ctx, &foopb.GetFooReq{Id: id})
	if err != nil {
		return "", err
	}
	return res.Title, nil
}
