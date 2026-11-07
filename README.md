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

Everything below goes over one outbound connection to the yey.boats origin named by
your connection link (https://yey.boats, or a local origin on a yey box). Nothing listens
on the boat. The plugin reads SignalK in-process, so there is no SignalK token to leak.

- **Values, only for the SignalK paths your plan selects**, at the rate the plan sets.
  The default consent is position, speed and course over ground, heading, apparent wind,
  depth and notifications. The plan can never exceed the consent you gave when you paired.
- **When you connect, the boat details you confirm:** name, MMSI, call sign, type,
  length, beam and draft, read from this server and corrected by you. They become the
  boat's record on yey.boats.
- **AIS traffic around the boat, only if you consented to `ais`.** Off by default. When
  your consent includes the item `ais` (on yey.boats: Account → your boat → "Share AIS
  traffic seen by this boat"), the connector also forwards the other vessels this server
  sees on AIS: each target's MMSI, name, position, course, speed and ship type, at most
  every 30 seconds per target and only when it changed. Your own boat is never in it.
  Put `ais` in the deny list to keep it on the boat whatever the plan says.
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

The boat credential stays in the plugin's private state file in this SignalK server's
data directory (`plugin-config-data/signalk-yey-connector/yey-connector-state.json`),
never in the plugin settings the admin UI shows. The cloud keeps only a hash of it.

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
"yey — cloud connector", with its own connection panel. To update, do the same with
the newer release.

To try it without a boat, see `bench/polynesia/`: a SignalK server and the yey
simulator sailing near Tahiti, in Docker.

## Connecting

1. On yey.boats, open **Account → Connect a SignalK server** and copy the connection
   link, for example `https://yey.boats/c/ABC-DEF-GHJ`. It works once and lives 15
   minutes.
2. In SignalK, open **Server → Plugin Config → yey — cloud connector**, paste the link
   into **Connection URL** and press **Connect**. (If the plugin is switched off,
   Connect switches it on.)
3. **Is this your boat?** The panel shows the name, MMSI, call sign, type, length, beam
   and draft this server knows. Correct anything that is wrong and press **Confirm**.
4. The panel says **Connected to yey.boats as *name***, with when data was last sent and
   the plan version. **Disconnect** forgets the connection on this server (it does not
   delete the boat on yey.boats).

**With a key.** For scripted or provisioned installs yey.boats can issue a key for one
boat (`yk1.…`). Paste the link yey.boats gives with it (`https://yey.boats/c/key`) and
the key into **Key**, and press **Connect**: there is no confirm step. A key can also be
put in the settings file (`connectionUrl` and `key`); the plugin connects with it on
start and then removes the key from the file.

**Self-hosted or a yey box:** the link is simply local (`http://yey.local/c/…`).
Nothing else differs.

Routing, the boat id and the credential are kept in the plugin's private state file,
never in its settings. Connecting from the older plugin page (*Connect to yey* / pairing
code at `/plugins/signalk-yey-connector/`) still works for now.

## Settings

The panel replaces the generated settings form. What it writes:

| Setting | Default | What it is |
|---|---|---|
| `connectionUrl` | *(empty)* | The connection link from yey.boats. |
| `key` | *(empty)* | Only for key mode; consumed on start and removed. |
| `advanced.deny` | `[]` | Paths that must never leave the boat (a path covers everything under it). Always wins over the plan. In the panel's collapsed **Advanced** section. |
| `advanced.bufferMegabytes` | `50` | How much to keep while offline. Also under **Advanced**. |

Switching the plugin off in Plugin Config stops sending.

**Upgrading from 0.1.x:** settings from the old form (`cloudOrigin`, `tenant`,
`project`, `bundleId`, `boatId`, `boatCredential`, top-level `deny` and
`bufferMegabytes`) are moved on the first start: routing, boat id and credential into
the private state file, deny and buffer under `advanced`. The settings file is then
rewritten without them. A paired boat keeps working with no action. `signalkUrl` and
`signalkToken` are no longer used, and neither is read-only access on the server.

## Requirements

Node >= 20.10 (the floor SignalK itself declares), SignalK server 2.x, and an outbound
HTTPS/WebSocket path to the yey.boats origin.

## Development

```bash
npm install
npm test     # node --test
npm run check   # syntax check + tests
npm run build:config   # rebuild public/remoteEntry.js after changing src/panel/
```

The plugin is plain CommonJS with no build step. The one exception is the Plugin Config
panel (`src/panel/`), which webpack builds into `public/` as a Module Federation
container (`signalk_yey_connector`, exposing `./PluginConfigurationPanel`, React shared
from the admin UI). `public/` is committed, because nothing is built on the boat;
`test/panel-bundle.test.js` fails if it is missing or older than `src/panel/`.

No test framework beyond Node's built-in runner. Every
piece of logic lives in `lib/` as a pure module with an injected clock, filesystem and
transport, so the plan engine can be tested with no boat, no socket and no cloud.

## Licence

Apache License 2.0, the same licence as the SignalK server. See `LICENSE` and
`NOTICE`. The licence covers this plugin only: it grants no rights to the yey.boats
service, which has its own terms, or to the yey names and logos.

---

Powered by [KDCube](https://kdcube.tech/).
