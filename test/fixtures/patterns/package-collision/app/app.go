// 呼んでいるのは提携先の UserService。社内の acme.identity.v1.UserService ではない。
package app

import (
	"context"

	partner "example.com/partner/partnerclient"
)

type App struct {
	users partner.UserServiceClient
}

// Lookup は提携先に利用者を問い合わせる。
func (a *App) Lookup(ctx context.Context, id string) error {
	_, err := a.users.GetUser(ctx, &partner.GetUserRequest{Id: id})
	return err
}
