// 集計結果を流す。トピック名を実行時に組み立てるので静的には決まらない。
package main

import "fmt"

// Emit は集計結果を流す。
func Emit(bus Bus, svc string, ev string) error {
	return bus.Publish(fmt.Sprintf("%s.%s", svc, ev), "")
}
