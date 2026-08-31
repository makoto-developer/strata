// 生成物の方言に関係なく、呼び出し側は同じシンボルを使う。
package app

import (
	"context"

	chat "example.com/acme/clients/ts-client"
)

type App struct {
	chat chat.ChatServiceClient
}

// Post はメッセージを送る。
func (a *App) Post(ctx context.Context, body string) error {
	_, err := a.chat.Send(ctx, &chat.SendRequest{Body: body})
	return err
}
