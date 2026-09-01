// v2 の生成クライアントを使う。v1 にも同名の UserService.GetUser がある。
package app

import (
	"context"

	userv2 "example.com/acme/clients/gen/user/v2"
)

type App struct {
	users userv2.UserServiceClient
}

// Show は利用者を表示する。
func (a *App) Show(ctx context.Context, id string) error {
	_, err := a.users.GetUser(ctx, &userv2.GetUserRequest{Id: id})
	return err
}
