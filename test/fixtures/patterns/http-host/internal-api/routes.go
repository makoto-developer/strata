// 社内 API。パスは よくある GET /users/{id}。
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/users/{id}", getUser)
	http.ListenAndServe(":8080", r)
}

func getUser(w http.ResponseWriter, r *http.Request) {}
