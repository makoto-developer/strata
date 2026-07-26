// gateway の HTTP 表面(REST + webhook 受信)。
// Strata の HTTP 検出(ルート定義・ハンドラ実装・webhook)のフィクスチャ。
package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Server struct{}

func Routes() http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	api := r.Group("/api")
	api.Get("/users/{id}", s.handleGetUser)
	api.Post("/orders", s.handleCreateOrder)
	r.Post("/webhooks/payment", s.handlePaymentWebhook)
	return r
}

func (s *Server) handleGetUser(w http.ResponseWriter, req *http.Request) {
	_ = req
	_, _ = w.Write([]byte("{}"))
}

func (s *Server) handleCreateOrder(w http.ResponseWriter, req *http.Request) {
	_ = req
	_, _ = w.Write([]byte("{}"))
}

// handlePaymentWebhook は決済プロバイダからの通知を受ける(外部 → 自システムの入口)。
func (s *Server) handlePaymentWebhook(w http.ResponseWriter, req *http.Request) {
	_ = req
	w.WriteHeader(http.StatusOK)
}
