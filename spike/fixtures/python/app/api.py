"""HTTP routes for session endpoints."""
from flask import Flask, request

from .session.store import Store


def create_app(store: Store) -> Flask:
    app = Flask(__name__)

    @app.route("/session")
    def get_session():
        key = request.args.get("key", "")
        value = store.get(key)
        if value is None:
            return "", 404
        return value

    @app.route("/session", methods=["POST"])
    def set_session():
        body = request.get_json(force=True)
        store.set(body.get("key", ""), body.get("value", ""))
        return "", 204

    return app
