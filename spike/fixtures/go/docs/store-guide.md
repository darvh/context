# Session store guide

## Overview

The store is opened with OpenStore and read with Get and written with Set.

## Files

The implementation lives in internal/session/store.go.

## Testing

TestStorePersistsAcrossRestart covers persistence across restarts.
