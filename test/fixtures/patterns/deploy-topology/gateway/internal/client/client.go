package client

import "net/http"

// 宛先はホスト名でしか区別できない。パスは 2 サービスで同じ
func CheckOrders() (*http.Response, error) {
	return http.Get("http://order-api.prod.svc.cluster.local/health")
}
