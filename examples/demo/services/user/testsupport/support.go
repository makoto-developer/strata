// Package testsupport は統合テスト向けのヘルパー(本番コードではない)。
// 構造ビューの「テストを除外」フィルタの検証用フィクスチャでもある。
package testsupport

// StartFakeServer はテスト用のインメモリサーバを起動する。
func StartFakeServer() string {
	return "127.0.0.1:0"
}
