package session

import "testing"

// TestStorePersistsAcrossRestart verifies Get sees values from Set.
func TestStorePersistsAcrossRestart(t *testing.T) {
	s, err := OpenStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Set("k", "v"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get("k")
	if err != nil {
		t.Fatal(err)
	}
	if got != "v" {
		t.Fatalf("got %q want %q", got, "v")
	}
}
