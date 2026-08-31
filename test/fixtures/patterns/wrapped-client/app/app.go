// 通知は自前 Facade 越しに呼ぶ。呼び出し側に gRPC のシンボルは現れない。
package app

import "context"

type Notifier interface {
	Send(ctx context.Context, body string) error
}

type Service struct {
	notifier Notifier
}

// Announce は利用者へ通知する。
func (s *Service) Announce(ctx context.Context, body string) error {
	return s.notifier.Send(ctx, body)
}
