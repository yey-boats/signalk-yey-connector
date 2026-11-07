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

Everything below goes over one outbound connection to `cloudOrigin` (https://yey.boats by
default). Nothing listens on the boat, and the SignalK access token never leaves it.

- **Values, only for the SignalK paths your plan selects**, at the rate the plan sets.
  The default consent is position, speed and course over ground, heading, apparent wind,
  depth and notifications. The plan can never exceed the consent you gave when you paired.
- **The deny list in the plugin settings always wins.** A path you deny is dropped on
  the boat, before anything is sent, no matter what the cloud asks for.
- **A hello when the connector connects:** the connector and SignalK versions, the
  connector's limits and buffer size, the **vessel name and MMSI** from SignalK, and the
  names of the installed SignalK plugins. The cloud keeps the versions, name and MMSI with
  the boat. It does not keep the plugin list.
- **A catalogue of what this server has:** the name, units and description of each
  `vessels/self` path (up to 250), and the gear manufacturer and model from SignalK `meta`.
  This lists paths, not their values, and it is sent whatever the plan selects, so the web
  page can show what you could turn on.
- Values that could not be sent during an outage are buffered on the boat (50 MB by
  default) and replayed when the link comes back. The same consent and deny rules apply
  to the replay.

The boat credential stays in this SignalK server's own plugin options file. The cloud
keeps only a hash of it.

What the cloud does with the data: the latest value of each path is kept for answering
questions, history is kept for 7 days by default, and both are visible to you and to
crew you invite. Questions you ask in the chat, with the boat data the answer needs, go
to the AI providers named in the privacy policy: <https://yey.boats/privacy?source=plugin>.

## Self-hosting

We intend to offer a self-hosted option. There is **no date**, and we would rather say
that than promise one.

---

## Install

Not in the SignalK Appstore yet. Install the release in the SignalK server's data
directory. npm 12 (shipped with current SignalK images) refuses to install from a
URL by default, so download the file first:

```bash
cd ~/.signalk
curl -LO https://github.com/yey-boats/signalk-yey-connector/releases/download/v0.1.0/signalk-yey-connector-0.1.0.tgz
npm install ./signalk-yey-connector-0.1.0.tgz
```

Restart the server. The plugin appears under **Server → Plugin Config** as
"yey — cloud connector", and its page under **Webapps** at
`/signalk-yey-connector/`. To update, do the same with the newer release.

To try it without a boat, see `bench/polynesia/`: a SignalK server and the yey
simulator sailing near Tahiti, in Docker.

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
