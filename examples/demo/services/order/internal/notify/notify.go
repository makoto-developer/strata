// order-service から外部システムへの HTTP 送信(webhook 送信 + 内部 REST 呼び出し)。
// Strata の HTTP クライアント検出のフィクスチャ。
package notify

import (
	"bytes"
	"context"
	"net/http"
)

// NotifySlack は外部 SaaS への webhook 送信(自システム → 外部の出口)。
func NotifySlack(ctx context.Context, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://hooks.example-chat.com/services/T000/B000/xxxx", bytes.NewReader(body))
	if err != nil {
		return err
	}
	_, err = http.DefaultClient.Do(req)
	return err
}

// FetchUser は gateway の REST エンドポイントを叩く(サービス間 HTTP 呼び出し)。
func FetchUser(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://gateway:8080/api/users/"+id, nil)
	if err != nil {
		return err
	}
	_, err = http.DefaultClient.Do(req)
	return err
}
