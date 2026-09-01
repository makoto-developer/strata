// 注文確定を通知する。トピック名は環境変数で与えられる。
package main

import "os"

// Emit は注文確定イベントを流す。
func Emit(bus Bus, id string) error {
	topic := os.Getenv("KAFKA_TOPIC")
	return bus.Publish(topic, id)
}
