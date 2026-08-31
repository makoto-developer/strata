// 手書きの interface とモック。名前は生成物に似ているが gRPC ではない。
package app

import "context"

// UserServiceClient は社内の別実装(HTTP)を包む手書き interface。
type UserServiceClient interface {
	GetUser(ctx context.Context, id string) (string, error)
}

type mockUserServiceClient struct{}

func (m *mockUserServiceClient) GetUser(ctx context.Context, id string) (string, error) {
	return id, nil
}

type App struct {
	users UserServiceClient
}

// Show は利用者名を返す。
func (a *App) Show(ctx context.Context, id string) (string, error) {
	return a.users.GetUser(ctx, id)
}
