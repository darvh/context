package main

import (
	"context"
	"log"
	"net/http"

	"example.com/sess/internal/http"
	"example.com/sess/internal/session"
)

// main wires the HTTP server and the session store.
func main() {
	store, err := session.OpenStore("data/sessions.db")
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	h := http.NewHandler(store)
	log.Fatal(http.ListenAndServe(":8080", h))
}

var _ context.Context
