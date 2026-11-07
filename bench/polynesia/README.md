# Polynesia test bench

A SignalK server with the yey connector installed, fed by the yey boat simulator
sailing in the Society Islands (it starts in the Sea of the Moon between Tahiti
and Moorea and keeps laying 8 to 15 nM passages). Use it to test the connector's
pairing and uplink against yey.boats, with a boat that cannot be confused with the
Adriatic demo boat.

Everything runs locally in Docker. Nothing here touches a real boat.

## Start

```bash
docker compose -f bench/polynesia/docker-compose.yml up -d
```

| What | Where |
|---|---|
| SignalK admin (user `admin`, password `admin`) | http://localhost:3100/admin |
| yey connector panel | http://localhost:3100/admin/#/serverConfiguration/plugins/signalk-yey-connector |
| Simulator admin UI | http://localhost:18090 |

The first start downloads the connector from the GitHub release and installs it;
later starts reuse it.

## Test the connect flow

With a connector that has the connection panel (`CONNECTOR_SRC=local`, or a release
after 0.1.0):

1. On yey.boats, Account → Connect a SignalK server, copy the link.
2. Open the connector panel above, paste the link, press **Connect**, check the boat
   details and press **Confirm**. (The simulator publishes no name, MMSI or
   dimensions; set them in SignalK under Server → Settings → Vessel first if you want
   them filled in.)
3. Ask the navigator "where is my boat?". It should answer near Tahiti.

Release 0.1.0 still uses its own page at http://localhost:3100/signalk-yey-connector/
(*Connect to yey*, or a pairing code `ABC-DEF-GHJ`).

Pairing creates a real boat on yey.boats under the account you confirm with.
Remove it afterwards with `/unpair <name>` in Telegram if you do not want to keep it.

## Options

| Variable | Default | Meaning |
|---|---|---|
| `CONNECTOR_SRC` | `release` | `release` (the GitHub release), `local` (this checkout, packed), or any npm spec |
| `CONNECTOR_VERSION` | `0.1.0` | Release to install when `CONNECTOR_SRC=release` |
| `START_LAT` / `START_LON` | `-17.55` / `-149.65` | Where the boat starts |
| `PASSAGE_MIN_NM` / `PASSAGE_MAX_NM` | `8` / `15` | Length of each random passage |
| `SIGNALK_PORT` / `SIM_WEB_PORT` | `3100` / `18090` | Host ports |

Test changes to the connector itself with `CONNECTOR_SRC=local docker compose ... up -d`;
it repacks and reinstalls on every start.

## Reset or stop

```bash
docker compose -f bench/polynesia/docker-compose.yml down      # stop, keep pairing
docker compose -f bench/polynesia/docker-compose.yml down -v   # stop and forget everything
```

## Notes

- Security is on (the simulator logs in to write). The connector reads SignalK
  in-process and needs no token or read-only access; only release 0.1.0, which reads
  over REST, gets `allow_readonly` (written on first boot when `CONNECTOR_SRC=release`
  and `CONNECTOR_VERSION=0.1.0`).
- Restarting only the SignalK container invalidates the simulator's login; restart
  `boat-sim` too.
- The simulator's day/night, temperature and battery cycles are tied to Adriatic time
  (UTC+2), so in Polynesia (UTC-10) its "day" runs half a day out of phase with the sun.
