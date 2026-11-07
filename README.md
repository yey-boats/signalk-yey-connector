# signalk-yey-connector

A SignalK server plugin that connects your boat to [yey.boats](https://yey.boats).
It sends the values a subscription plan asks for, over a connection the boat opens
itself, and answers to a plan you manage on the web rather than to code you have to
redeploy.

## What it costs

$0.99 per month plus VAT for the base plan. Bring your own Claude API key (BYOK) and
there are no token purchases at all — you pay Anthropic directly.
Details: <https://yey.boats/pricing?source=plugin>.

## What leaves the boat

- **Only the SignalK paths your plan selects**, at the rate the plan sets. The plan
  cannot exceed the consent you gave when you paired.
- **The deny list in the plugin settings always wins.** A path you deny is dropped on
  the boat, before anything is sent, no matter what the cloud asks for.
- **A capability document at connect time**: which paths this server has, their units
  and their gear (manufacturer/model from SignalK `meta`), plus the connector version
  and its limits. That is what lets the web page show you what you could turn on.
- **Nothing inbound.** The connection is outbound-only — there is no port to forward
  and nothing listens on the boat's public side. Your router does not change.
- Values that could not be sent during an outage are buffered locally and replayed
  when the link comes back; the same consent and deny rules apply to the replay.

The boat credential stays in this SignalK server's own plugin options file. The cloud
keeps only a hash of it.

Details: <https://yey.boats/privacy?source=plugin>.

## Self-hosting

We intend to offer a self-hosted option. There is **no date**, and we would rather say
that than promise one.

---

## Install

The plugin is licensed under Apache-2.0. It is not on the SignalK Appstore or npm
yet. Until it is, install from a release tarball or a checkout:

```bash
cd ~/.signalk                         # the server's data directory
npm install <path-or-URL-to>/signalk-yey-connector-<version>.tgz
# or, from a checkout:
#   git clone https://github.com/yey-boats/signalk-yey-connector node_modules/signalk-yey-connector
#   (cd node_modules/signalk-yey-connector && npm install --omit=dev)
```

Restart the server. The plugin appears under **Server → Plugin Config** as
"yey — cloud connector", and its page under **Webapps** at
`/signalk-yey-connector/`.

## Pairing

Two directions, both ending in the same place:

- **From the boat**: open the plugin's page and press *Connect to yey*. Confirm on
  yey.boats (or in the Telegram bot) and the boat finishes pairing on its own.
- **From the web**: create the boat on yey.boats, then paste the pairing code into the
  plugin page.

Pairing writes the boat id and the boat credential into the plugin's settings. Keep the
credential secret; it is the boat's only proof of identity.

## Settings

| Setting | Default | What it is |
|---|---|---|
| `enabled` | `true` | Master switch. Off means nothing is sent. |
| `cloudOrigin` | `https://yey.boats` | Where the cloud lives. |
| `tenant` / `project` / `bundleId` | `home` / `demo` / `signalk@2026-06-05` | Which cloud app answers. Leave them alone unless told otherwise. |
| `signalkUrl` | `http://localhost:3000` | This server, as the plugin should reach it. |
| `signalkToken` | *(empty)* | Only needed if this server has security enabled. |
| `boatId` / `boatCredential` | *(empty)* | Filled in by pairing. |
| `deny` | `[]` | Paths that must never leave the boat. Always wins over the plan. |
| `bufferMegabytes` | `50` | How much to keep while offline. |

## Requirements

Node >= 20.10 (the floor SignalK itself declares), a reachable SignalK server, and an
outbound HTTPS/WebSocket path to `cloudOrigin`.

## Development

```bash
npm install
npm test     # node --test
npm run check   # syntax check + tests
```

Plain CommonJS, no build step, no test framework beyond Node's built-in runner. Every
piece of logic lives in `lib/` as a pure module with an injected clock, filesystem and
transport, so the plan engine can be tested with no boat, no socket and no cloud.

## Licence

Apache License 2.0, the same licence as the SignalK server. See `LICENSE` and
`NOTICE`. The licence covers this plugin only: it grants no rights to the yey.boats
service, which has its own terms, or to the yey names and logos.

---

Powered by [KDCube](https://kdcube.tech/).
