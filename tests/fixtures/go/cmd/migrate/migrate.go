package migrate

import "fmt"

// Migrate exports rows to the archive format.
func Migrate(exportPath string) error {
	return fmt.Errorf("not implemented")
}

// Backfill imports archived rows back into a fresh store.
func Backfill(importPath string) error {
	return fmt.Errorf("not implemented")
}

// Run migrates then backfills; unsafe on a live store.
func Run(exportPath, importPath string) error {
	return nil
}
