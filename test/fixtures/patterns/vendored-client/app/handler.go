// 店頭アプリ。カタログは vendor 済みの生成クライアント経由で呼ぶ。
package app

import (
	"context"

	catalog "example.com/thirdparty/catalogclient"
)

type Handler struct {
	catalog catalog.CatalogServiceClient
}

// Show は商品を 1 件表示する。
func (h *Handler) Show(ctx context.Context, sku string) (string, error) {
	res, err := h.catalog.GetItem(ctx, &catalog.GetItemRequest{Sku: sku})
	if err != nil {
		return "", err
	}
	return res.Title, nil
}
