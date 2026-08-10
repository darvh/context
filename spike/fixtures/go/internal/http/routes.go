package http

import (
	"net/http"

	"example.com/sess/internal/session"
)

// NewHandler builds the HTTP mux backed by a session store.
func NewHandler(store *session.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get("key")
		v, err := store.Get(key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.Write([]byte(v))
	})
	return mux
}
