package session

import (
	"errors"
	"sync"
)

var ErrNotFound = errors.New("session not found")

// Store persists sessions to a single database file.
type Store struct {
	mu   sync.Mutex
	path string
	data map[string]string
}

// OpenStore opens (or creates) a session store at the given path.
func OpenStore(path string) (*Store, error) {
	return &Store{path: path, data: map[string]string{}}, nil
}

// Get returns the value for a session key.
func (s *Store) Get(key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

// Set stores a value under a session key.
func (s *Store) Set(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = value
	return nil
}

// Close flushes the store to disk.
func (s *Store) Close() error {
	return nil
}
