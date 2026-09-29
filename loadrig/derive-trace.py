"""Derive a load-rig trace OFFLINE from the simulator's own delta builder.

The real trace comes from loadrig/capture.js against a local signalk-server fed
by the simulator (operator-run). This is the no-server fallback: it calls the
simulator's ``_build_vessel_delta`` - the exact function that produces what the
simulator publishes - once per simulated second, with a boat sailing a steady
course and the environment wandering slightly, and writes the same trace shape
capture.js writes. What it cannot reproduce is what signalk-server itself adds
(its own paths, source bookkeeping, delta coalescing), which is why a captured
trace is preferred when one exists.

    ../simulator/.venv/bin/python loadrig/derive-trace.py --seconds 60 \
        --out loadrig/trace.json

Needs the simulator repo importable (its venv, or PYTHONPATH=<simulator>/src).
Deterministic: no clock, no randomness beyond a fixed-seed PRNG.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from yey.boats.simulator.engine.navigator import NavState
from yey.boats.simulator.engine.schedule import SimState
from yey.boats.simulator.engine.weather import DEFAULT_WEATHER
from yey.boats.simulator.engine.signalk_writer import (
    SELF_MMSI, _build_vessel_delta, _metadata_items)


def _stubs():
    # Same shapes the simulator's own tests stub (tests/test_screen_value_emission.py),
    # with concrete values so every emitted value is JSON.
    elec = SimpleNamespace(loads={}, voltage=12.8, current_a=5.0, soc=0.9, solar_w=100.0,
                           alternator_w=0.0, genset_w=0.0, net_w=36.0, inverter_state="invert",
                           genset_state="stopped", genset_rpm=0.0)
    sys_ = SimpleNamespace(bilge_pump=False, water_pump=False, fw_tank_0=0.5, fw_tank_1=0.5,
                           fuel_tank_0=0.5, fuel_tank_1=0.5, bw_tank_0=0.5, bw_tank_1=0.5,
                           bw_tank_2=0.5)
    lights = SimpleNamespace(port_light=False, starboard_light=False, stern_light=False,
                             masthead_light=False, anchor_light=False, deck_light=False,
                             saloon_dimmer=0.0, forward_cabin_dimmer=0.0,
                             port_aft_cabin_dimmer=0.0, stbd_aft_cabin_dimmer=0.0,
                             instrument_dimmer=0.0)
    # The simulator's own no-forecast fallback weather, a real WeatherPoint.
    wx = DEFAULT_WEATHER
    temps = {"engine_k": 350.0, "genset_k": 300.0, "boiler_k": 340.0, "saloon_k": 295.0,
             "fwd_cabin_k": 293.0, "port_aft_k": 292.0, "stbd_aft_k": 292.0}
    return elec, sys_, lights, wx, temps


def _nest(tree: dict, path: str, leaf: dict) -> None:
    node = tree
    parts = path.split(".")
    for key in parts[:-1]:
        node = node.setdefault(key, {})
    node[parts[-1]] = leaf


def derive(seconds: int, seed: int = 7) -> dict:
    rng = random.Random(seed)
    elec, sys_, lights, wx, temps = _stubs()
    t0 = datetime(2026, 6, 18, 12, 0, 0, tzinfo=UTC)
    lat, lon = 45.0, 13.6              # off Istria, the simulator's home water
    hdg, sog, tws, twd, depth = 135.0, 5.5, 12.0, 300.0, 40.0
    next_wp = ("Pula", 44.87, 13.84)
    prev_wp = ("Rovinj", 45.08, 13.63)
    deltas = []
    last_values: dict[str, object] = {}
    for s in range(seconds):
        hdg += rng.uniform(-1.5, 1.5)
        sog = max(0.0, sog + rng.uniform(-0.1, 0.1))
        tws = max(0.0, tws + rng.uniform(-0.3, 0.3))
        twd = (twd + rng.uniform(-2, 2)) % 360
        depth = max(3.0, depth + rng.uniform(-0.5, 0.5))
        dist_nm = sog / 3600
        lat += dist_nm / 60 * math.cos(math.radians(hdg))
        lon += dist_nm / 60 * math.sin(math.radians(hdg)) / math.cos(math.radians(lat))
        twa = ((twd - hdg + 180) % 360) - 180
        nav = NavState(lat=lat, lon=lon, hdg_deg=hdg, cog_deg=hdg, sog_kts=sog, stw_kts=sog,
                       twa_deg=twa, tws_kts=tws, twd_deg=twd, awa_deg=twa * 0.8,
                       aws_kts=tws * 1.2, heel_deg=abs(twa) / 10, depth_m=depth)
        delta = _build_vessel_delta(nav, elec, sys_, lights, wx, SimState.SAILING,
                                    t0 + timedelta(seconds=s), temps,
                                    next_wp=next_wp, prev_wp=prev_wp)
        for v in delta["updates"][0]["values"]:
            deltas.append({"t": s * 1000, "path": v["path"], "value": v["value"]})
            last_values[v["path"]] = v["value"]

    self_tree: dict = {"name": "Sara", "mmsi": SELF_MMSI}
    meta = {}
    meta_by_path = dict(_metadata_items())
    for path, value in last_values.items():
        leaf = {"value": value}
        if path in meta_by_path:
            leaf["meta"] = meta_by_path[path]
            meta[path] = {k: v for k, v in meta_by_path[path].items()
                          if k in ("units", "description")}
        _nest(self_tree, path, leaf)

    return {
        "provenance": ("derived offline by loadrig/derive-trace.py from the simulator's "
                       "_build_vessel_delta; not a signalk-server capture"),
        "capturedAt": t0.isoformat(),
        "baseUrl": "",
        "seconds": seconds,
        "server": {"version": "2.33.0", "plugins": []},
        "vessel": {"name": "Sara", "mmsi": SELF_MMSI},
        "self": self_tree,
        "meta": meta,
        "deltas": deltas,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="loadrig/trace.json")
    args = ap.parse_args()
    trace = derive(args.seconds, args.seed)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(trace, fh, separators=(",", ":"))
    print(json.dumps({"path": args.out, "deltas": len(trace["deltas"]),
                      "paths": len({d["path"] for d in trace["deltas"]})}))


if __name__ == "__main__":
    main()
