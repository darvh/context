from app.session.store import open_store, Store


def test_store_persists_across_get_set():
    s = open_store(":memory:")
    s.set("k", "v")
    assert s.get("k") == "v"


def test_store_missing_key_returns_none():
    s = Store(":memory:")
    assert s.get("missing") is None
