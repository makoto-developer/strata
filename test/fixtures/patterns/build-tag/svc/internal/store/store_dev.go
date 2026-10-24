//go:build dev

package store

type Store struct{}

func (s *Store) Get(id string) string { return "memory" }
