// 利用者の永続化。
package main

import "context"

type Row struct {
	ID   string
	Name string
}

type Repo struct{}

func (r *Repo) Find(ctx context.Context, id string) (Row, error) {
	return Row{ID: id, Name: "sample"}, nil
}

func (r *Repo) List(ctx context.Context, limit int) ([]Row, error) {
	return []Row{{ID: "1", Name: "sample"}}, nil
}
