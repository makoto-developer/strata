// 注文確定を受けてメールを送る。
package main

import "os"

// Start は購読を開始する。
func Start(bus Bus) error {
	return bus.Subscribe(os.Getenv("KAFKA_TOPIC"), handle)
}

func handle(id string) error { return nil }
