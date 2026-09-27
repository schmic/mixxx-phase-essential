# Phase Essential → Mixxx mapping: behavior and open work

## Scope and goal

Design a two-deck controller mapping from the Phase receiver's motion reports to Mixxx. Assume report 3 is already arriving; receiver activation and the handshake are outside this task. This document describes the intended behavior and the tests needed to choose a transport method. It does not prescribe a finished implementation.

One Phase remote sits on each rotating record. The remote has no way to know which groove or song location is under a stylus. Its **position is rotational orientation/travel**, not a Mixxx track position. Placing or lifting the remote must never seek to a location in the audio file. Track loading, cues, and seeking remain Mixxx operations.

## Known input and assumptions

Each fresh receiver sample gives remote A and B a position, signed angular velocity, and timestamp. Captures documented in [`../PHASE_MANAGER_ANALYSIS.md`](../PHASE_MANAGER_ANALYSIS.md#mixxx-hid-mapping-prototype) found:

| Signal | Observed meaning | Mapping use |
| --- | --- | --- |
| Position | Continuous radians over several revolutions; decreases during normal forward rotation | Relative platter travel and reversals |
| Velocity | Radians/second; negative during normal forward rotation, positive in reverse | Motion plausibility, stopped state, and physical pitch indication |
| Timestamp | Advances with new radio samples, including while stationary; HID frames can repeat a sample | Freshness and ordering; no assumed time unit |

Report 3 is 64 bytes. The current decoder uses little-endian float32 position/velocity at offsets 1/5 for A and 32/36 for B, and uint32 timestamps at 14 and 45. A's fields were confirmed in live motion captures; **B's timestamp offset still needs an independent moving-B capture**. A timestamp of zero represented an inactive B in the captured session. Do not infer a valid motion sample merely from repeated HID frames.

The observed normal speed is approximately `-3.49066 rad/s` at 33⅓ rpm; +8% turntable pitch produced approximately `-3.76974 rad/s`. Treat these as calibration observations, not a fixed speed command. A 45 rpm reference must be selected deliberately if that is the intended normal speed.

## Ways HID motion can drive a Mixxx deck (ELI5)

The USB HID mapping is the **translator**. It reads Phase's numbers and writes Mixxx controls. It does not send a special “this is vinyl” message to the audio engine. Imagine the track as a strip of tape and the record as a wheel: the question is which Mixxx control tells the tape how to move when the wheel turns.

All choices below start with the same input rule: accept only fresh Phase samples. Speed-driven choices use velocity; distance-driven choices compare successive angles and treat that difference as signed wheel travel. Phase's absolute angle is never an absolute place in the song.

| Possibility | What the mapping tells Mixxx | What it feels like | Main limitation |
| --- | --- | --- | --- |
| **1. Play/pause + pitch** (`play`, `rate` or `rate_ratio`) | “Run at this speed” or “stop” using Phase velocity. | A turntable speed knob. | Does not lock the song to the wheel's traveled distance. Slow scratches and reversals need extra controls; speed errors accumulate into drift. |
| **2. Jog** (`jog`) | “Nudge forward/back a little” from each angle change while Mixxx normally plays. | Pushing a spinning platter with a finger. | Its bend springs back. Normal playback can continue underneath, so it cannot faithfully hold a stopped record. |
| **3. Wheel** (`wheel`) | “Add this lasting speed offset” based on Phase motion. | Holding the pitch bend in one direction. | Unlike `jog`, the offset persists until undone; the mapping must continuously manage it. It still does not track total wheel travel. |
| **4. Speed scratch** (`scratch2_enable`, `scratch2`) | “For now, move the tape at this signed speed.” Convert Phase velocity to a forward/zero/reverse speed ratio. | A motor whose speed follows the record. The original mapping felt great to the user. | It knows speed but has no memory of how far the wheel actually traveled; drift can build. The original mapping did not show physical pitch/BPM in the UI. |
| **5. Relative tick scratch** (`engine.scratchEnable`, `engine.scratchTick`) | “The wheel moved this many tiny steps.” Convert each angle difference into signed ticks; Mixxx's filter turns them into playback speed. | A high-resolution jog wheel attached to the record. | Filter timing may lose or overshoot distance, especially during slow scratches; long-run drift and sound need testing. This was the preceding prototype. |
| **6. Position scratch** (`scratch_position_enable`, `scratch_position`) | “The wheel's *relative travel since we started* is here.” Accumulate or scale Phase angle changes and feed a continuous scratch position. | A ruler attached to the wheel, so Mixxx can compare requested travel with actual audio travel. | The existing controller was designed around waveform/mouse scratching; previous Phase trials had metallic steady-speed audio. “Position” here still means relative wheel travel, not song location. |
| **7. Switch or combine methods** | For example, use speed scratch for steady rotation and position scratch for hand movement, or add slow position correction to speed scratch. | An automatic transmission changing gears. | The changeover can stutter or jump. Prior Phase trials with switching and low-rate correction did. |
| **8. Add a Mixxx engine input** | Extend Mixxx so a mapping can provide timestamped wheel angle/travel directly. | Building a proper socket for this kind of record sensor. | Requires Mixxx engine/API development; an HID mapping alone cannot select it today. |

### Can option 1 simply send velocity on every update?

**Yes, for a basic forward-playing turntable.** On each *fresh radio sample* (not every repeated USB frame), normalize Phase's signed velocity against the chosen normal record speed. At 33⅓ rpm, normal forward Phase velocity is about `-3.49 rad/s`, so `speed_ratio = -velocity / 3.49`: normal rotation gives `1.0`, +8% pitch gives about `1.08`, and hand braking gives a value below `1.0`. While moving forward, write that ratio to Mixxx `rate_ratio` and keep `play = 1`. Mixxx uses `rate_ratio` for its pitch slider/BPM calculation and its ordinary playback tempo. `rate` is a slider value, so it is less direct for this conversion. See Mixxx's [rate controller](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/ratecontrol.cpp) and [BPM controller](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/bpmcontrol.cpp).

It is **not enough by itself for full vinyl behavior**:

- **Stop:** a speed ratio near zero is not a reliable way to hold an ordinary Mixxx deck. Pause after a genuine sustained stop, then resume on movement; test whether the play transition is audible. Do not send `play` on/off for every tiny velocity fluctuation.
- **Reverse and scratches:** ordinary `rate_ratio` is a pitch/tempo setting, not a signed wheel-transport command. Switching to a scratch path only after detecting hand motion would require an unreliable guess and could make noise or jumps. Use a continuous signed transport path if scratches are part of the goal.
- **Position drift:** speed says “how fast now,” while Phase angle says “how far the record actually turned.” If Mixxx runs 0.5% faster than the wheel for 100 revolutions, it ends up half a revolution ahead. Repeated velocity writes cannot notice or undo that error without comparing positions.
- **Timing and noise:** receiver frames repeat samples. Write only on new timestamps; smooth noisy velocity enough for clean audio without delaying hand braking. Handle lost samples by holding/stopping the deck rather than letting its last speed run forever.

This is a useful **small experiment** if the goal is start/stop and turntable pitch with no tight scratch tracking: play a long record side, vary pitch, stop, and compare the track's final location with Phase's accumulated angle. If the goal is that the audio follows every hand motion and returns to exactly the same point after a backward/forward scratch, option 1 needs position feedback or a different motion path.

### There is no scratch-start event

Phase reports rotation, not whether a hand has touched the record. A change in speed might be turntable pitch, a hand brake, or the beginning of a scratch. Waiting for “enough” rotation to declare scratch mode would lose the start of the gesture and add latency. **The motion path should already own the deck before the gesture begins.** Do not use a speed or distance threshold to switch from ordinary play into scratching.

For the simplest continuous *velocity-driven* experiment, attach an active remote to a deck once, leave Mixxx `scratch2_enable = 1`, and on each fresh sample set `scratch2 = -velocity / nominal_forward_angular_speed`. Normal forward rotation gives about `+1`, stopped gives `0`, and reverse gives a negative value. Keep the same path active through all three; `play` can remain on while `scratch2 = 0` holds audio, subject to an actual stop/audio test. A lost radio signal is different from a stopped record: a watchdog must force zero/hold when fresh samples cease. Mixxx's [rate controller](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/ratecontrol.cpp) uses `scratch2` as the deck's signed speed when enabled, including when the platter is still; it also has a separate `scratch2_indicates_scratching` control for the key-lock/scratch indication. That indication is optional policy, not a sensor event and not needed to start motion control.

The preceding *position-driven* prototype similarly kept `scratchEnable` active and fed every fresh angle change to `scratchTick`; it also needed no scratch-start detection. These two continuous paths differ in whether the engine receives **speed** or **distance traveled**. Compare their latency, audio quality, and drift on a real deck if needed. Neither path can infer hand contact from Phase alone.

### Preserve the good `scratch2` feel and add pitch display

The user reports that the original continuous velocity-only `scratch2` mapping felt great. Its concrete shortcoming was that the Mixxx interface did not show turntable pitch/BPM changes. Treat that mapping as the **first candidate to restore**, then add a separate, slower UI update:

1. Send fresh signed velocity straight to `scratch2` for audible motion, including forward, zero, and reverse. Do not wait for a scratch-start event, switch modes, or add a position correction to solve a display problem.
2. For forward rotation, derive a positive `physical_ratio = -velocity / nominal_forward_angular_speed`. Smooth or rate-limit this value for the display, then write it to `rate_ratio`. Mixxx's [rate controller](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/ratecontrol.cpp) uses `scratch2` in place of ordinary tempo while enabled; its [BPM controller](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/bpmcontrol.cpp) derives engine BPM from `rate_ratio`. Verify the skin's visible BPM and pitch slider follow this value.
3. At zero or reverse speed, keep the last meaningful forward pitch display or another clearly chosen display policy. Never send a negative or near-zero `rate_ratio` merely to describe a scratch. Reset the display appropriately on track change or remote loss.
4. Test whether `rate_ratio` updates affect sound, key lock, sync, or transitions despite `scratch2` having speed authority. The display update must preserve the original responsive audio feel. Measure drift separately; do not presume position correction is required solely because a velocity path can drift in theory.

The prior `scratch2` version that stuttered included approximately 15 Hz `playposition` observation and capped position correction. The positive feel report applies to the earlier speed-only version. Keep these results separate when choosing the next experiment.

These are **alternative ways to command audio motion**, not controls to drive all at once. A useful mapping may also set supporting controls: `play` to manage a settled stop, `rate_ratio` to show physical pitch/BPM, and a scratch-state indicator to help Mixxx decide whether key lock applies. Those controls need to agree with the selected motion path. In Mixxx's current rate controller, `scratch2` takes over speed while it is enabled, and `scratch_position` takes precedence when enabled; ordinary pitch affects playback when those modes are released. That is why pitch display and the transition back to normal playback must be checked with sound, not just the BPM number. See Mixxx's [control definitions](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/mixxx-controls.d.ts), [scripting API](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/engine-api.d.ts), and [rate controller](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/ratecontrol.cpp).

Two tempting paths answer a different question:

- **Write `playposition` on every report:** this tells Mixxx to *jump to a song location*. Even if we integrate Phase rotation first, repeated seeks are not a smooth scratch transport. It remains appropriate for an explicit cue or seek action.
- **Enable Mixxx vinyl control:** its relative mode is made for a timecode signal decoded from an audio input. The HID mapping can switch that mode, but it cannot hand raw Phase angle samples to Mixxx's timecode decoder through the existing mapping API. A true HID vinyl-control engine path would require Mixxx engine work beyond this mapping.

**Current implementation:** `Phase-Essential-hid.js` now sends each fresh signed velocity sample directly to `scratch2` while keeping `scratch2_enable` active for the remote. A separate smoothed `rate_ratio` update supplies pitch/BPM feedback. The HID decoder and per-deck timeout remain in place; position does not correct playback. Mock report checks cover this split, but the combined result needs live Mixxx testing. Compare the earlier relative tick and position scratch paths only if a measured problem remains. If no existing control path meets the measured motion and audio goals, the dedicated engine input in option 8 becomes a further possibility.

User feedback after trying this combined path: slow and short movements work, and a slow reverse revolution returns without drift, but a quick reverse revolution leaves about 20 degrees of error. A 3× mapping speed cap could cause that: one record revolution in less than 0.6 seconds exceeds 3× at 33⅓ rpm. The mapping cap was raised to 12×; test the same spin again. If drift remains, collect fresh Phase position, velocity, timestamp, and Mixxx play-position travel over that gesture to locate where distance is lost before adding correction.

## Distance-driven reference model

If testing a position-driven alternative, maintain independent state for each deck. On the first valid sample, store the Phase angle as an **origin** and keep the current Mixxx play location. On each later fresh sample, calculate `Δθ = previous_position - current_position`. Thus forward motion has positive `Δθ`, reverse motion has negative `Δθ`, and one physical revolution corresponds to `2π` radians of signed travel. If the device ever supplies an angle wrapped to one revolution, unwrap it before calculating travel; the present captures instead show a continuous value. Never map the absolute Phase angle or its origin to Mixxx `playposition`.

Convert signed angular travel to a relative deck command. A candidate using Mixxx's jog/scratch API is `ticks = Δθ × intervals_per_revolution / (2π)`, preserving fractional tick remainder so slow motion does not disappear. Initialize Mixxx's scratch controller once per active remote and keep it engaged through normal rotation, hand braking, reversals, and brief holds. The mapping must give **one transport controller authority over audible motion**; velocity is corroborating data and must not independently advance audio a second time. Mixxx documents [`scratchEnable` / `scratchTick`](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/engine-api.d.ts) as a filtered relative jog interface, so its response and drift need live measurement rather than an assumption of exact tracking.

For a position-driven method, use velocity to check the sign and approximate magnitude of position change over the sample interval, to detect genuine motion or a settled platter, and to estimate a displayed pitch ratio when useful: `physical_ratio = -velocity / nominal_forward_angular_speed`. The velocity-only option above can drive basic playback, but it can accumulate track drift and cannot reproduce short reversals as reliably as observed angle changes. The timestamp identifies fresh samples and may help calculate elapsed device time **only after its units and wrap behavior are measured**. Use a local monotonic clock for sample-loss timeouts; a receiver timestamp that advances while stationary does not imply rotation.

## Deck behavior

1. Remote A controls deck 1 and remote B controls deck 2, with separate timestamps, timers, and transport state. A distance-driven method also keeps separate origins and fractional travel. An absent remote must not alter the other deck.
2. Accept only complete, finite report-3 values with a new valid timestamp. Ignore repeats. Establish a fresh angle origin when a deck is first attached, when a new track loads, or after a radio/position reset; do not turn the first sample into a large movement.
3. Follow platter movement continuously at 33⅓ rpm and at pitch-adjusted speeds. Forward hand drag slows playback; backward drag or scratch reverses it. A short stop between scratch strokes must hold position without repeatedly toggling Mixxx `play` or restarting the scratch filter.
4. At a sustained stop, audio must settle at the held location. If Mixxx requires pausing its play control to guarantee silence, do so only after a measured hold interval and resume on renewed motion. Do not let this pause create an audio jump or fade on every short scratch stop.
5. On missing or implausible samples, avoid extrapolating indefinitely. Stop/hold the affected deck, release its motion controller if needed, and rebase on the next valid sample. A large angle jump, track change, or disconnect must never become a giant scratch tick. A normal fast scratch must not be mistaken for a reset solely because its delta is large; qualify jumps with elapsed time and velocity.
6. Track position changes only through relative physical travel or an explicit Mixxx cue/seek action. A Mixxx seek while the platter is active must preserve the current physical orientation as the new relative reference so the next sample does not pull the track back.
7. Show turntable pitch/BPM if practical, without changing the track's stored BPM or beatgrid. If writing `rate_ratio`, first verify that it changes the intended display and does not multiply the scratch transport speed or fight Mixxx sync. Reverse and zero velocity should not force the BPM display to a nonsensical value.

## Decisions to validate on a running deck

The current [`Phase-Essential-hid.js`](Phase-Essential-hid.js) uses continuous velocity-driven `scratch2`, a smoothed 50 ms `rate_ratio` display update, and a 200 ms freshness timeout. Earlier trials in the analysis saw metallic audio with continuous `scratch_position` feedback, drift and scratch stutter with a `scratch2` variant that added low-rate position correction, and stutter when switching between speed and position modes. The original velocity-only `scratch2` mapping felt great but lacked UI pitch/BPM feedback; the combined version has offline checks but no confirmed live audio result. The preceding tick path used 65,536 ticks/revolution and Mixxx's `scratchEnable` / `scratchTick` filter; a [Mixxx discussion of scratch controllers](https://github.com/mixxxdj/mixxx/issues/14070) identifies possible `scratchTick` drift and slow-scratch overshoot.

Measure and decide:

- Confirm B's timestamp offset, both timestamp wrap/ordering behavior, effective fresh radio sample rate, and whether position ever wraps or resets during normal use.
- Verify the speed-only `scratch2` feel remains with the parallel `rate_ratio` update, and that forward pitch changes update the visible BPM and pitch slider. Check that UI smoothing does not slow or alter audio motion.
- Compare expected audio travel (`Δθ / 2π` revolutions at the chosen nominal RPM) against Mixxx travel over long forward runs, slow scratches, repeated reversals, and fast spins. Check both audible artifacts and accumulated offset after returning the record to its starting orientation.
- Tune filter response, tick resolution, stop delay, and loss timeout with actual audio. Check whether very slow motion is audible, whether a held platter is silent, and whether quick reversals preserve attack without stutter.
- Verify pitch display and actual audio speed at normal pitch, +8%, sustained hand braking, reverse motion, and when Mixxx sync is enabled. Resolve any double application of pitch before treating BPM feedback as complete.
- Verify recovery after remote removal/reconnection, track load, explicit cue/seek, timestamp rollover, and a rejected position jump. The unaffected deck should continue normally.

## Completion criteria

The mapping is ready when both decks independently follow signed record travel without needle-drop behavior; a still record stays at the current audio location; normal pitch and hand movement feel continuous; short scratch holds and reversals sound clean; reconnects and seeks cause no jumps; and measured long-run drift is acceptably small for a full performance. Record the chosen thresholds, live measurements, and any remaining limitations in the analysis before changing this task from theory to implementation.
