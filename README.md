# Phase Essential HID mapping for Mixxx

`Phase-Essential.hid.xml` and `Phase-Essential-hid.js` map receiver HID interface 1 (`00f1:01f1`) to Mixxx decks 1 and 2. Install or symlink both under `~/.mixxx/controllers/`, then select the Phase Essential mapping in Mixxx's controller preferences.

The mapping expects 64-byte input report 3. Remote A position/velocity are at byte offsets 1/5 and remote B at 32/36 (little-endian float32); A's timestamp is at 14, and B's expected timestamp is at 45. It feeds continuous, signed Phase rotation into Mixxx's `scratch_position` controller, which compares platter travel against actual song-position travel to correct drift (including during loops and seeks). Forward velocity is negative. Mixxx `rate_ratio` follows smoothed forward speed, so the displayed BPM follows the MK7 pitch and sustained hand braking without altering the track's stored beatgrid. Stop, lost reports, and shutdown pause the deck; an absent remote does not take over its deck. This does not enable Mixxx's separate audio-based vinyl control or provide needle-drop positioning.

Report-3 offsets originated in [Mixxx issue #12886](https://github.com/mixxxdj/mixxx/issues/12886#issuecomment-4076951100). Live HID captures with an MK7 confirmed forward/reverse signs, continuous position, 33⅓ and +8% velocity, and advancing timestamps even when stopped. `nominalRadiansPerSecond` in the JavaScript defaults to 33⅓ rpm; change it to `2 * Math.PI * 45 / 60` if 45 rpm should be the track's normal speed. A physical switch to 45 rpm with the default setting instead displays 135% of the track BPM, as expected for a 33⅓-rpm reference.

Linux users need the hidraw ACL from `72-phase.rules` installed under `/etc/udev/rules.d/`, followed by udev rule reload and receiver reconnect. 

Run `node test-phase-mapping.js` to check packet decoding, direction, displayed BPM, stop, track reload, and lost-report behavior without hardware.

## Wake automatically on receiver connection

Install the user service and udev rule:

```sh
install -Dm644 phase-wake.service ~/.config/systemd/user/phase-wake.service
sudo install -Dm644 72-phase.rules /etc/udev/rules.d/72-phase.rules
systemctl --user daemon-reload
sudo udevadm control --reload-rules
```

Reconnect the receiver while your user session is running. When its HID interface appears, the rule grants hidraw access and asks your user manager to run `phase-wake.service` once. No `systemctl --user enable` is needed: the device triggers the service on each connection. Check the result with `journalctl --user -u phase-wake.service -b`.

The service runs `%h/Workspace/phase/go-phase/go-phase wake`; edit `ExecStart` if your checkout is elsewhere. It only performs the HID handshake; Mixxx still needs the mapping above to read the motion reports.
