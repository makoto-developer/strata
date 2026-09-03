// UserService を呼ぶ側。同じ package に、RPC 名と同名だが無関係なメソッドを置いてある。
package api

import (
	"context"

	userv1 "example.com/platform/proto/user/v1"
)

type Server struct {
	users userv1.UserServiceClient
}

// 本物の呼び出し
func (s *Server) Load(ctx context.Context, id string) (string, error) {
	res, err := s.users.GetUser(ctx, &userv1.GetUserReq{Id: id})
	if err != nil {
		return "", err
	}
	return res.Name, nil
}

// 無関係なメモリキャッシュ。RPC 名と同じメソッド名を持つだけで、
// UserService.GetUser の実装でも呼び出しでもない。実装として繋いではいけない
type LocalCache struct{ m map[string]string }

func (c *LocalCache) GetUser(id string) string { return c.m[id] }
