package store

import (
	"example.com/platform/services/user/internal/metrics"
)

func Get(id string) string {
	metrics.Count("store_get")
	return "user-" + id
}

func List() []string {
	metrics.Count("store_list")
	return nil
}
