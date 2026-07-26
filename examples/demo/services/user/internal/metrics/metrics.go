package metrics

import (
	"example.com/platform/services/user/internal/store"
)

var total int

// Count は計測イベントを記録する。
func Count(name string) {
	total++
	_ = name
}

// Snapshot は保存件数も含めた統計を返す(store への逆依存 = 意図的な循環)。
func Snapshot() []string {
	return store.List()
}
