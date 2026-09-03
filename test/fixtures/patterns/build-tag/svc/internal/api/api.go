package api

import "example.com/platform/svc/internal/store"

type Handler struct{ s *store.Store }

func (h *Handler) Load(id string) string { return h.s.Get(id) }
