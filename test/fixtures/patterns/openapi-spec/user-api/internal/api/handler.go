package api

import "net/http"

type Handler struct{}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{id}", h.GetUser)
	mux.HandleFunc("/v1/orders", h.ListOrders)
}

func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request)    {}
func (h *Handler) ListOrders(w http.ResponseWriter, r *http.Request) {}
