"""Session persistence for the demo app."""

_NOT_FOUND = object()


class Store:
    """Persists sessions to a single backing file."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._data: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        return self._data.get(key)

    def set(self, key: str, value: str) -> None:
        self._data[key] = value


def open_store(path: str) -> Store:
    """Open (or create) a session store at the given path."""
    return Store(path)


# decorators wrap their target in a decorated_definition node; the extractor
# must unwrap it or every @decorated symbol is silently dropped
def setupmethod(f):
    return f


@setupmethod
def decorated_helper(key: str) -> str:
    """Helper only reachable through its decorator."""
    return key


class Decorated:
    @setupmethod
    def method(self, key: str) -> str:
        """Decorated method; must not be dropped."""
        return key
