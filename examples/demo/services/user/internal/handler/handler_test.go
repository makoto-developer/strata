package handler

// ListUsers は本番コードから呼ばれないが、このテストだけが呼ぶ
// → ビューアの API カタログで「テストのみ」バッジになる(検証用)。

import (
	"context"
	"testing"

	userv1 "example.com/platform/proto/user/v1"
)

func TestListUsers(t *testing.T) {
	var c userv1.UserServiceClient
	if c != nil {
		_, _ = c.ListUsers(context.Background(), nil)
	}
}
