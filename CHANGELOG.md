# Changelog

All notable changes to signalk-yey-connector. Versions follow
[semver](https://semver.org/); the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A release is cut by
pushing a `v<version>` tag (see [Releasing](README.md#releasing)): the
section for that version below becomes the GitHub release notes.

## [Unreleased]

### Security
- Credential state and buffer lanes are written owner-only (0600); a stale
  temporary file is removed before the credential is written (#29).
- Connection links: only yey.boats origins are accepted unless
  `allow_custom_origin` is set; redirects off the origin are refused and
  plain-http local links are labelled (#31, fixes #25).
- Remote steering: one policy module on the boat (`lib/steering-policy.js`),
  published through `capabilities`; every put must carry `boat_id` and
  `deadline_ms`, values are range-checked and refused (never clamped), and
  request ids are persisted so a replay is dropped across restarts (#34,
  fixes #21, part of #28).
- Steering policy follow-ups: the request rate is admitted before the replay
  id is recorded, deadlines at most 15 s ahead, `boat_id` must be a string, a
  put that fails after its timeout is audited, and
  `steering.autopilot.actions.advanceWaypoint` (value `1`, as the SignalK
  autopilot plugin handles it) is allowed (#36, fixes #35).

### Added
- Remote steering audit log (`yey-steering-audit.jsonl`, 0600, rotated) and
  optional auto-off after N hours (`remote_steering_auto_off_hours`) (#32,
  fixes #22).
- Audit follow-ups: refusals in their own file (`yey-steering-refusals.jsonl`)
  so they can never rotate an accepted record out; the auto-off options save
  keeps the key when the credential is not on disk; auto-off fires with a
  read-only data dir; a pending `suppressed` count is written on plugin stop
  (#37, fixes #33).
- Tag-triggered release workflow, this changelog and `scripts/release.sh`
  replacing the one-off release scripts (#38, fixes #26).

### Docs
- README: hard-reload the admin page after install, including Safari (#19).

## [0.4.0] - 2026-11-08

Remote steering from yey.boats: autopilot only, and off until you turn it on,
on the boat.

- **On-board switch.** New option *Allow remote steering from yey.boats
  (autopilot only)* (`remote_steering`), off by default, in the connection
  panel and under **Advanced**. The cloud cannot turn it on.
- **What it allows.** Only the autopilot paths (`steering.autopilot.state`,
  `.target.headingTrue`, `.target.windAngleApparent`, `.actions.*`). Each
  request is checked against the local deny list, must be a single value, and
  is limited to 12 per minute. It runs as a normal SignalK PUT on this server,
  so an autopilot plugin must answer it.
- **Refusals the app explains:** `remote_steering_off`, `no_handler` and
  `signalk_refused`.
- **`capabilities`** op: yey.boats can read whether the switch is on.
- **Trail.** Every accepted or refused request shows in the plugin status and
  the debug log.
- Docs: onboarding video script (#17).

PRs #18, #20.

## [0.3.0] - 2026-11-08

Connect by link only, and rename the boat on either side.

- **Rename from the panel.** The boat name syncs with yey.boats in both
  directions; the most recent change wins (#15).
- **Link only.** The Key field is gone: paste the yey.boats link or the code;
  pasted text and browser autofill around the link are cleaned up.
- **Install docs** in the README: download from the GitHub release, then
  install into `~/.signalk` (#14).

PR #16.

## [0.2.0] - 2026-11-07

Connect by link, approve on the boat, and let yey.boats ask the boat.

- **Connect by link** from yey.boats → Account → *Connect a SignalK server*;
  a server-issued key works too (#6).
- **Approve before anything is sent:** what will be sent, what is never sent,
  what is kept and for how long, with separate approvals for the data plan,
  the terms and the privacy notice.
- **On-request queries** from yey.boats (value, metadata, history, catalog)
  over the same link; the local deny list always wins; writes and controls
  are always refused.
- **AIS traffic** can be shared, only when the owner turns it on and approves.
- **Late instruments are picked up:** new paths trigger re-discovery and a
  new plan (#7).
- Shows in SignalK's Connection activity.
- The standalone page and `/pair` routes are gone; existing settings are
  migrated.
- Polynesia test bench; npm 12 install fix (#5).

PR #12.

## [0.1.0] - 2026-11-07

First public release, Apache-2.0: a plan-driven, outbound-only uplink from a
SignalK server to yey.boats, paired with a code from
https://yey.boats/setup?source=plugin. End-to-end tests against the simulator
and a cross-repo plan contract test.

[Unreleased]: https://github.com/yey-boats/signalk-yey-connector/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/yey-boats/signalk-yey-connector/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yey-boats/signalk-yey-connector/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yey-boats/signalk-yey-connector/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yey-boats/signalk-yey-connector/releases/tag/v0.1.0
