// テスト用のにせ実装。_test.go でも tests/ 配下でもないので、命名だけでは除外されない。
package testsupport

import (
	"context"

	userv1 "example.com/platform/proto/user/v1"
)

type FakeUserService struct {
	userv1.UnimplementedUserServiceServer
}

func (f *FakeUserService) GetUser(ctx context.Context, req *userv1.GetUserReq) (*userv1.GetUserRes, error) {
	return &userv1.GetUserRes{Name: "fake"}, nil
}
