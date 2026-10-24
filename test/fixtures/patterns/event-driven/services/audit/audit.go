// 監査ログを流す。IaC 側に設定が無いので、トピック名は解決できないままになる。
package main

import "os"

// Emit は監査イベントを流す。
func Emit(bus Bus, id string) error {
	return bus.Publish(os.Getenv("KAFKA_TOPIC"), id)
}
