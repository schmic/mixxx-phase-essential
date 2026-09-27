# Phase Essential HID mapping for Mixxx

`Phase-Essential.hid.xml` and `Phase-Essential-hid.js` map receiver HID interface 1 (`00f1:01f1`) to Mixxx decks 1 and 2. Install or symlink both under `~/.mixxx/controllers/`, then select the Phase Essential mapping in Mixxx's controller preferences.

The mapping expects 64-byte input report 3. Remote A position/velocity are at byte offsets 1/5 and remote B at 32/36 (little-endian float32); A's timestamp is at 14, and B's expected timestamp is at 45. Forward Phase velocity is negative. Each fresh radio sample drives Mixxx `scratch2` directly with signed normalized velocity: forward, stopped, and reverse use the same continuously enabled transport path. There is no scratch-start detection, position correction, or play toggle on a short hold. In parallel, smoothed forward velocity updates `rate_ratio` about every 50 ms so the pitch slider and displayed BPM follow turntable pitch without changing the track's stored beatgrid. During a stop or reverse scratch, the display holds the last useful forward ratio. An absent or stale remote releases its deck and pauses it so ordinary playback cannot run away. This does not enable Mixxx's audio-based vinyl control or provide needle-drop positioning. Audio feel, UI behavior, and long-term drift still require live testing with this combined mapping.

Fast backspins could hit the previous mapping-imposed 3× speed cap (one revolution in 0.6 seconds at 33⅓ rpm). The cap is now 12× so a quick reverse spin can reach the engine without losing travel at that limit. Mixxx's published `scratch2` range is `-3..3`; its local rate-controller code does not clamp the value there, but sound and drift beyond 3× need a live test.

Report-3 offsets originated in [Mixxx issue #12886](https://github.com/mixxxdj/mixxx/issues/12886#issuecomment-4076951100). Live HID captures with an MK7 confirmed forward/reverse signs, continuous position, 33⅓ and +8% velocity, and advancing timestamps even when stopped. `nominalRadiansPerSecond` in the JavaScript defaults to 33⅓ rpm; change it to `2 * Math.PI * 45 / 60` if 45 rpm should be the track's normal speed. A physical switch to 45 rpm with the default setting instead displays 135% of the track BPM, as expected for a 33⅓-rpm reference.

Linux users need the hidraw ACL from `72-phase.rules` installed under `/etc/udev/rules.d/`, followed by udev rule reload and receiver reconnect. 

## Wake automatically on receiver connection

Install the user service and udev rule:

```sh
install -Dm644 phase-wake.service ~/.config/systemd/user/phase-wake.service
systemctl --user daemon-reload
sudo install -Dm644 72-phase.rules /etc/udev/rules.d/72-phase.rules
sudo udevadm control --reload-rules
```

Reconnect the receiver while your user session is running. When its HID interface appears, the rule grants hidraw access and asks your user manager to run `phase-wake.service` once. No `systemctl --user enable` is needed: the device triggers the service on each connection. Check the result with `journalctl --user -u phase-wake.service -b`.

The service runs `%h/bin/phase wake`; edit `ExecStart` if your checkout is elsewhere. It only performs the HID handshake; Mixxx still needs the mapping above to read the motion reports.
