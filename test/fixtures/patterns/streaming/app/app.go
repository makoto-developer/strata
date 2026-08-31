// ストリーミング RPC を使う。呼び出し口はストリームを返すだけで、以降は Recv / Send になる。
package app

import (
	"context"

	feedpb "example.com/acme/proto/feed"
)

type App struct {
	feed feedpb.FeedServiceClient
}

// Watch は配信を購読する(サーバストリーミング)。
func (a *App) Watch(ctx context.Context, id string) error {
	stream, err := a.feed.Watch(ctx, &feedpb.WatchRequest{Id: id})
	if err != nil {
		return err
	}
	for {
		if _, err := stream.Recv(); err != nil {
			return err
		}
	}
}

// Sync は双方向でやり取りする。
func (a *App) Sync(ctx context.Context) error {
	stream, err := a.feed.Sync(ctx)
	if err != nil {
		return err
	}
	return stream.Send(&feedpb.Event{Body: "hello"})
}
