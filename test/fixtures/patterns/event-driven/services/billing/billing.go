// 課金完了を通知する。KAFKA_TOPIC の値は order とは別(サービス単位のスコープ)。
package main

import "os"

// Emit は課金完了イベントを流す。
func Emit(bus Bus, id string) error {
	return bus.Publish(os.Getenv("KAFKA_TOPIC"), id)
}
