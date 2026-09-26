# Phase Essential HID mapping prototype for Mixxx

`Phase Essential.hid.xml` and `Phase-Essential-hid.js` map receiver HID interface 1 (`00f1:01f1`) to Mixxx decks 1 and 2.

The mapping expects 64-byte input report 3. It decodes remote A position/velocity at byte offsets 1/5, remote B at 32/36 (little-endian float32), and applies `-velocity / (2π × 33⅓ / 60)` to `[Channel1]`/`[Channel2]` `scratch2`. It enables scratch takeover on first nonzero velocity, sets zero speed when stopped, and releases takeover after 500 ms without report 3 or on shutdown. Positions are decoded but not used to set song position. It never writes HID reports, changes pitch fader, or turns on Mixxx's separate audio-based vinyl control.

Report-3 byte layout and physical direction are based on [Mixxx issue #12886](https://github.com/mixxxdj/mixxx/issues/12886#issuecomment-4076951100).

Linux users need the hidraw ACL from `72-phase.rules` installed under `/etc/udev/rules.d/`, followed by udev rule reload and receiver reconnect. 
