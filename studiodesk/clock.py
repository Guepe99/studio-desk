"""Match clock: releases a match's events one at a time at match time (docs/CONTRACT.md).

`speed=1` is real time, `speed=10` ten times faster; `speed=0` (or a very large speed) means no
waiting, for tests and replay generation. Iterate with `for` or `async for`; `.now` is the `ts`
of the last released event (0.0 before the first), and the full-time `ts` once the loop ends, so
full-time facts are released too.
"""
import asyncio
import time

from . import db


class MatchClock:
    def __init__(self, match_id, speed=1.0, conn=None):
        own = conn is None
        conn = conn or db.matches()
        try:
            row = conn.execute("SELECT period1_s + period2_s FROM matches WHERE match_id = ?", (match_id,)).fetchone()
            if row is None:
                raise KeyError(f"unknown match {match_id}")
            self.end = row[0]
            self.events = [dict(r) for r in conn.execute(
                "SELECT * FROM events WHERE match_id = ? ORDER BY ts, event_id", (match_id,))]
        finally:
            if own:
                conn.close()
        self.match_id, self.speed, self.now = match_id, speed, 0.0

    def _wait(self, ts, start):
        return ts / self.speed - (time.monotonic() - start) if self.speed > 0 else 0.0

    def __iter__(self):
        start = time.monotonic()
        for e in self.events:
            if (d := self._wait(e["ts"], start)) > 0:
                time.sleep(d)
            self.now = e["ts"]
            yield e
        if (d := self._wait(self.end, start)) > 0:
            time.sleep(d)
        self.now = self.end

    async def __aiter__(self):
        start = time.monotonic()
        for e in self.events:
            if (d := self._wait(e["ts"], start)) > 0:
                await asyncio.sleep(d)
            self.now = e["ts"]
            yield e
        if (d := self._wait(self.end, start)) > 0:
            await asyncio.sleep(d)
        self.now = self.end
