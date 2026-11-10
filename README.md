# signalk-yey-connector

A SignalK server plugin that connects your boat to [yey.boats](https://yey.boats).
It sends the values a subscription plan asks for, over a connection the boat opens
itself, and answers to a plan you manage on the web rather than to code you have to
redeploy.

## See it working (5 min, with sound)

[![Watch: connect a SignalK boat to yey.boats, end to end](https://yey.boats/media/yey-onboarding.jpg)](https://yey.boats/setup#video)

A new boat from start to finish: add it on yey.boats, install this plugin, paste the link,
approve what it shares, then chat about the boat. Narrated, with captions.
[Watch on yey.boats](https://yey.boats/setup#video) · [MP4](https://yey.boats/media/yey-onboarding.mp4)

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
  depth and notifications. The plan can never exceed the consent you gave in the panel.
- **Nothing is sent before you approve it, here on the boat.** When you connect, the panel
  shows what will be sent, what is never sent (your deny list), what yey.boats keeps and for
  how long, and links to the privacy policy and the terms, with three separate boxes, all
  unticked: approve the data plan, agree to the terms (at the version shown), and confirm you
  have read the privacy policy. yey.boats records the acceptance (no IP address).
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
- **Answers to questions yey.boats asks, one value at a time.** Over the same outbound
  connection the cloud may ask for the current value, metadata or (if this server has a
  history provider) the history of a single path, when the navigator needs it to answer
  you. The boat answers only paths inside your consent that the plan either sends or marks
  *on request*, never a denied path, never a write or control (those are refused, except
  autopilot commands when you have turned on [remote steering](#remote-steering)), at most
  30 a minute, each answer capped at 64 KB.
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

The connector is **not in the SignalK Appstore yet**: the Appstore lists npm packages,
and this one is not published to npm. Until it is, install the release tarball from
GitHub.

1. Download `signalk-yey-connector-<version>.tgz` from the
   [latest release](https://github.com/yey-boats/signalk-yey-connector/releases/latest)
   onto the machine that runs SignalK. Download the file first: npm 12 (shipped with
   current SignalK images) refuses to install from a URL (`allow-remote=none`).
2. Install it from the file, in the SignalK config directory:

   ```bash
   cd ~/.signalk
   curl -fLO https://github.com/yey-boats/signalk-yey-connector/releases/download/v0.4.0/signalk-yey-connector-0.4.0.tgz
   npm install ./signalk-yey-connector-0.4.0.tgz
   ```

   (Already downloaded it elsewhere? `npm install /path/to/signalk-yey-connector-<version>.tgz`.)
3. Restart SignalK (**Restart** in the admin UI, or `sudo systemctl restart signalk`),
   then **hard-reload the admin page** in your browser: Ctrl+Shift+R (Chrome, Edge,
   Firefox), Cmd+Shift+R on a Mac, or Cmd+Option+R in Safari. A normal reload can keep
   the old, cached plugin page; until you hard-reload, the panel may say "Module
   signalk-yey-connector is not available" or show an older version's settings.

The plugin then appears under **Server → Plugin Config** as "yey — cloud connector",
with its own connection panel. To update, do the same with the newer release.

**SignalK in Docker.** From the folder with the downloaded file (replace `signalk`
with your container's name):

```bash
docker cp signalk-yey-connector-0.4.0.tgz signalk:/tmp/
docker exec -w /home/node/.signalk signalk npm install /tmp/signalk-yey-connector-0.4.0.tgz
docker restart signalk
```

Installing from the Appstore will work once the connector is published to npm.

To try it without a boat, see `bench/polynesia/`: a SignalK server and the yey
simulator sailing near Tahiti, in Docker.

## Connecting

1. On yey.boats, open **Add a boat** (or **Account → Connect a SignalK server** for a boat
   you already have) and copy the connection link, for example
   `https://yey.boats/c/ABC-DEF-GHJ`. It works once and lives 15 minutes.
2. In SignalK, open **Server → Plugin Config → yey — cloud connector**, paste the link
   (or just the code, `ABC-DEF-GHJ`) into **Connection link** and press **Connect**. (If
   the plugin is switched off, Connect switches it on.)
3. **Is this your boat?** The panel shows the name, MMSI, call sign, type, length, beam
   and draft this server knows. Correct anything that is wrong and press **Next**.
4. **What this server will share.** Read the summary, tick the three boxes and press
   **Agree and connect**. Nothing is paired or sent until you do. While the terms on
   yey.boats are a draft, your acceptance is recorded as a draft acceptance and you will be
   asked again, with time to do so, when the final terms are published.
5. The panel says **Connected to yey.boats as *name***, with when data was last sent and
   the plan version. **Disconnect** forgets the connection on this server (it does not
   delete the boat on yey.boats).

**The boat's name.** Until you name it, the boat takes the name SignalK knows it by.
**Rename** next to *Connected to yey.boats as …* changes it here and on yey.boats; renaming
the boat on yey.boats (Account, or the boat menu) changes it here too, at the next
heartbeat. The most recent rename wins. (The name rides on the hello: the connector sends
`hello.display_name = {value, set_at}` only after a rename here, and every hello reply from
yey.boats carries `boat = {display_name, display_name_set_at, server_time}`. A yey.boats
that predates this ignores the first and omits the second, and the panel then says a
rename here stays here.)

**Pasting.** The link field ignores anything in front of `https://` — a password manager
that filled the SignalK login into it (`adminhttps://…`) does no harm — and takes a bare
code on `https://yey.boats`.

**Provisioned installs (a key).** The panel no longer asks for a key: yey.boats connects
by link. A key already in the settings file (`connectionUrl` and `key`) still connects
on start (relying on the acceptance given when the key was issued) and is then removed
from the file.

**Connected before consent existed?** The plugin keeps sending, and the panel shows
**Review and approve**. If yey.boats ever pauses a boat for want of approval, the panel says
so, the plugin stops gathering, and approving there resumes it.

**Self-hosted or a yey box:** the link is simply local (`http://yey.local/c/…`).
Nothing else differs.

Routing, the boat id and the credential are kept in the plugin's private state file,
never in its settings. The older standalone page at `/plugins/signalk-yey-connector/`
and its pairing-code calls are gone: the panel is the one way to connect.

## Settings

The panel replaces the generated settings form. What it writes:

| Setting | Default | What it is |
|---|---|---|
| `connectionUrl` | *(empty)* | The connection link from yey.boats. |
| `key` | *(not in the panel)* | Provisioned installs only: put in the file by hand, consumed on start and removed. |
| `advanced.deny` | `[]` | Paths that must never leave the boat (a path covers everything under it). Always wins over the plan. In the panel's collapsed **Advanced** section. |
| `advanced.bufferMegabytes` | `50` | How much to keep while offline. Also under **Advanced**. |
| `remote_steering` | `false` | Allow remote steering from yey.boats, autopilot only. See [Remote steering](#remote-steering). Also under **Advanced**. |
| `remote_steering_auto_off_hours` | `0` | Switch remote steering off this many hours after it was turned on; 0 = never. Also under **Advanced**. |

Switching the plugin off in Plugin Config stops sending.

**Upgrading from 0.1.x:** settings from the old form (`cloudOrigin`, `tenant`,
`project`, `bundleId`, `boatId`, `boatCredential`, top-level `deny` and
`bufferMegabytes`) are moved on the first start: routing, boat id and credential into
the private state file, deny and buffer under `advanced`. The settings file is then
rewritten without them. A paired boat keeps working with no action. `signalkUrl` and
`signalkToken` are no longer used, and neither is read-only access on the server.

## Remote steering

Off by default. When it is on, the yey.boats dashboard can send autopilot commands to
this boat. The connector hands them to this SignalK server as an ordinary SignalK PUT,
and your own autopilot plugin carries them out.

- **Both switches are needed.** This plugin's own setting (**Advanced** → *Allow remote
  steering from yey.boats*, option `remote_steering`) AND remote steering turned on in
  the yey.boats app, which asks for a code sent to your Telegram. The cloud cannot change
  the setting on the boat.
- **Autopilot paths only:** `steering.autopilot.state`,
  `steering.autopilot.target.headingTrue`, `steering.autopilot.target.windAngleApparent`
  and `steering.autopilot.actions.<action>` (for example `adjustHeading`, `tack`). The
  value must be a plain boolean, number or short string. Anything else is refused.
- **Your deny list still wins:** add `steering.autopilot` under **Advanced** → *Never send
  these paths* to refuse every command whatever the switches say.
- At most 12 commands a minute. Every command, carried out or refused, is written to the
  server log (debug) and shown as the plugin status, for example
  `Remote steering: steering.autopilot.state=auto accepted 12:03`.
- **Audit log.** Every command is also appended to `yey-steering-audit.jsonl` in the
  plugin's data folder (owner-only, mode 0600): time, request id, path, value and the
  outcome (`accepted`, `refused` with the reason, `timeout`, `dropped`, and `auto_off`).
  It rotates at 256 KB, keeping three old files (`.1`–`.3`). The panel shows the last
  ten under **Advanced**.
- **Auto-off (optional).** Set *Switch remote steering off after (hours)* (option
  `remote_steering_auto_off_hours`, default 0 = never) and the plugin unticks the switch
  that many hours after it was turned on. The time survives restarts. The plugin status
  and the panel say when it will switch off or when it did.
- **To turn it off:** untick the setting under **Advanced** and press **Save** (the
  plugin restarts and refuses all commands), or switch it off in the yey.boats app, or
  switch the plugin off.

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
