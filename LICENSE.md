# Licence — not yet settled

`signalk-yey-connector` is **UNLICENSED** and `private` for now. No licence is
granted to anyone, and `package.json` reflects that.

This is deliberate rather than an oversight. The rest of the YEY Boats org ships
under PolyForm-Noncommercial-1.0.0, but this plugin sits on the paid path: it is
the uplink between a customer's boat and a subscription service. Whether
PolyForm-Noncommercial is the right licence for that, or whether it needs
different terms, is an open question for the operator and is recorded as an open
item in the Y2 design.

Until that is decided:

- Do not publish this package to the public npm registry.
- Do not list it in the SignalK Appstore.

Both of those are one-way doors — a published npm version cannot be truly
unpublished, and an Appstore listing puts the plugin on boats we cannot update.
Publishing is also gated on the capacity work (Y7) for independent reasons.

When the terms are settled, replace this file with the licence text and update
the `license` and `private` fields in `package.json` together, in one commit, so
the two can never disagree.
