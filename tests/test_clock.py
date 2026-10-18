import asyncio
import time

from studiodesk.clock import MatchClock


def test_releases_events_in_order_without_waiting(match_db):
    _, conn = match_db
    clock = MatchClock("M001", speed=0, conn=conn)
    assert clock.now == 0.0
    seen = []
    for e in clock:
        assert clock.now == e["ts"]
        seen.append(e["ts"])
    assert seen == sorted(seen) and len(seen) == len(clock.events) > 10


def test_speed_paces_release(match_db):
    _, conn = match_db
    clock = MatchClock("M001", speed=1000, conn=conn)  # 360 s of match in about 0.36 s
    start = time.monotonic()
    list(clock)
    assert time.monotonic() - start >= clock.events[-1]["ts"] / 1000 - 0.01


def test_async_iteration(match_db):
    _, conn = match_db

    async def run():
        return [e["event_id"] async for e in MatchClock("M001", speed=0, conn=conn)]

    assert len(asyncio.run(run())) == len(MatchClock("M001", 0, conn).events)


def test_reaches_full_time_after_the_last_event(match_db):
    _, conn = match_db
    clock = MatchClock("M001", speed=0, conn=conn)
    list(clock)
    assert clock.now == clock.end == 360.0 > clock.events[-1]["ts"]
