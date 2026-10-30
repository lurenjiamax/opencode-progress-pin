"""Zero-dependency progress producers for OpenCode Progress Pin.

    from opencode_progress import progress
    for item in progress(items, desc="Indexing", unit="files"):
        process(item)

    with progress(total=100, desc="Download", unit="MB") as bar:
        bar.update(5)

Writes atomic snapshots to OPENCODE_PROGRESS_FILE, or @@progress JSON lines
to stderr outside a managed task. No network or OpenCode credentials needed.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import uuid
from collections.abc import Iterable, Iterator, Sized
from pathlib import Path
from typing import Generic, TypeVar

T = TypeVar("T")


def report(**values: object) -> None:
    """Report an absolute current/total/percent, message, phase, unit or status."""
    for key in ("current", "total", "percent"):
        value = values.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                  or not math.isfinite(value) or value < 0
                                  or (key == "percent" and value > 100)):
            raise ValueError(f"Invalid {key}")
    payload = {**values, "_sequence": uuid.uuid4().hex}
    target = os.environ.get("OPENCODE_PROGRESS_FILE")
    if not target:
        sys.stderr.write("@@progress " + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stderr.flush()
        return
    file = Path(target)
    pending = file.with_name(file.name + f".{os.getpid()}.{uuid.uuid4().hex}.pending")
    try:
        with pending.open("x", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        pending.chmod(0o600)
        os.replace(pending, file)
    finally:
        pending.unlink(missing_ok=True)


class progress(Generic[T]):
    """tqdm-like iterable/context manager. Total is inferred only from Sized inputs.

    Counts advance after the consumer finishes each iteration. Early breaks keep
    their real count; process exit, not this iterator, determines task success.
    """
    def __init__(self, iterable: Iterable[T] | None = None, *, total: float | None = None,
                 desc: str = "", unit: str = "it", mininterval: float = 0.2) -> None:
        self.iterable = iterable
        self.total = total if total is not None else (len(iterable) if isinstance(iterable, Sized) else None)
        self.n = 0.0
        self.desc = desc
        self.unit = unit
        self.mininterval = max(0.0, mininterval)
        self._last = 0.0
        self.refresh()

    def refresh(self) -> None:
        report(current=self.n, total=self.total, phase=self.desc, unit=self.unit)
        self._last = time.monotonic()

    def update(self, n: float = 1) -> None:
        self.n += n
        if time.monotonic() - self._last >= self.mininterval:
            self.refresh()

    def set_description(self, desc: str) -> None:
        self.desc = desc
        self.refresh()

    def set_postfix_str(self, message: str) -> None:
        report(current=self.n, total=self.total, phase=self.desc, unit=self.unit, message=message)

    def close(self) -> None:
        self.refresh()

    def __iter__(self) -> Iterator[T]:
        if self.iterable is None:
            raise TypeError("No iterable; use update() with a context manager")
        try:
            for item in self.iterable:
                yield item
                self.update()
        finally:
            self.close()

    def __enter__(self) -> progress[T]:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Report progress from a shell or custom collector")
    parser.add_argument("--current", type=float)
    parser.add_argument("--total", type=float)
    parser.add_argument("--percent", type=float)
    parser.add_argument("--message")
    parser.add_argument("--phase")
    parser.add_argument("--unit")
    parser.add_argument("--indeterminate", action="store_true")
    args = vars(parser.parse_args())
    unknown = args.pop("indeterminate")
    values = {key: value for key, value in args.items() if value is not None}
    if unknown:
        values.update(total=None, percent=None)
    report(**values)
