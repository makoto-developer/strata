package client

import (
	"fmt"
	"net/http"
)

func FetchUser(id string) (*http.Response, error) {
	return http.Get(fmt.Sprintf("http://user-api/v1/users/%s", id))
}

func CreateUser() (*http.Response, error) {
	return http.Post("http://user-api/v1/users", "application/json", nil)
}

// 別サービス宛て。パスは user-api の仕様書と同じだが、宛先が違う
func CreateOnBilling() (*http.Response, error) {
	return http.Post("http://billing/v1/users", "application/json", nil)
}
