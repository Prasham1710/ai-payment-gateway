"""Optional offline model: P(success | provider, method, amount, hour), trained by train.py."""

import logging
import threading
from pathlib import Path

import joblib

from app.features import encode

log = logging.getLogger(__name__)


class SuccessModel:
    """Holds the current model artifact; safe to reload while serving."""

    def __init__(self, path: str | None):
        self._path = Path(path) if path else None
        self._artifact: dict | None = None
        self._lock = threading.Lock()
        self.reload()

    @property
    def version(self) -> str | None:
        artifact = self._artifact
        return artifact["version"] if artifact else None

    @property
    def metrics(self) -> dict | None:
        artifact = self._artifact
        return artifact.get("metrics") if artifact else None

    def reload(self) -> bool:
        """Loads the artifact if the file exists. Returns whether a model is now active."""
        if self._path is None or not self._path.exists():
            with self._lock:
                self._artifact = None
            return False
        artifact = joblib.load(self._path)
        with self._lock:
            self._artifact = artifact
        log.info("Loaded routing model %s", artifact["version"])
        return True

    def predict(self, provider: str, method: str, amount_paise: int, hour: int) -> float | None:
        """Success probability, or None when no model is loaded or it has never seen this provider."""
        artifact = self._artifact
        if artifact is None or provider not in artifact["providers"]:
            return None
        row = encode(provider, method, amount_paise, hour, artifact["providers"])
        return float(artifact["model"].predict_proba([row])[0][1])
