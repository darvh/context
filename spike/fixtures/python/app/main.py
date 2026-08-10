"""Application entry point: wires the session store into a web app."""
import os

from .api import create_app
from .session.store import open_store


def main() -> None:
    db_path = os.environ.get("SESSION_DB", "data/sessions.db")
    store = open_store(db_path)
    app = create_app(store)
    app.run(port=8080)


if __name__ == "__main__":
    main()
