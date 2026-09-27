"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const controls = new Map([
    ["[Channel1],track_loaded", 1],
    ["[Channel2],track_loaded", 1],
    ["[Channel1],play", 1],
    ["[Channel2],play", 1],
    ["[Channel1],rate_ratio", 1],
    ["[Channel2],rate_ratio", 1],
]);
const connections = new Map();
const writes = [];
let now = 1000;
let watchdog;
const engine = {
    getValue(group, control) {
        return controls.get(`${group},${control}`) || 0;
    },
    setValue(group, control, value) {
        writes.push([group, control, value]);
        controls.set(`${group},${control}`, value);
    },
    makeConnection(group, control, callback) {
        const key = `${group},${control}`;
        connections.set(key, callback);
        return { disconnect() { connections.delete(key); } };
    },
    beginTimer(interval, callback) {
        watchdog = callback;
        return 1;
    },
    stopTimer() {},
};
const context = { engine, Date: { now: () => now }, isFinite, Math, print() {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "Phase-Essential-hid.js"), "utf8"), context);
const phase = context.PhaseEssential;
phase.init("test", false);

function report(aPosition, aVelocity, aTimestamp, bPosition = 0, bVelocity = 0, bTimestamp = 0) {
    const frame = Buffer.alloc(64);
    frame[0] = 3;
    frame.writeFloatLE(aPosition, 1);
    frame.writeFloatLE(aVelocity, 5);
    frame.writeUInt32LE(aTimestamp, 14);
    frame.writeFloatLE(bPosition, 32);
    frame.writeFloatLE(bVelocity, 36);
    frame.writeUInt32LE(bTimestamp, 45);
    phase.incomingData(frame, frame.length);
}
function get(control, deck = 1) {
    return engine.getValue(`[Channel${deck}]`, control);
}
function closeTo(actual, expected, tolerance = 0.001) {
    assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`);
}
function advance(velocity, durationMs = 2) {
    now += durationMs;
    report(-90, velocity, ++timestamp);
}

const nominal = phase.nominalRadiansPerSecond;
let timestamp = 1;
report(-90, -nominal, timestamp);
assert.equal(get("scratch2_enable"), 1);
closeTo(get("scratch2"), 1);
assert.equal(get("play"), 1);
assert.equal(get("scratch2_enable", 2), 0, "absent B leaves deck 2 alone");

report(-90, nominal, timestamp);
closeTo(get("scratch2"), 1, 0.001);
assert.equal(writes.filter(([, control]) => control === "scratch2").length, 2,
    "repeated radio timestamp must not change transport");

advance(-nominal * 1.08);
closeTo(get("scratch2"), 1.08);
closeTo(get("rate_ratio"), 1); // UI path has not reached its 50 ms update.
for (let i = 0; i < 500; ++i) advance(-nominal * 1.08);
assert.ok(get("rate_ratio") > 1.07 && get("rate_ratio") < 1.081,
    "forward +8% pitch updates the Mixxx BPM control");
assert.equal(get("play"), 1, "display updates do not toggle playback");

advance(-nominal * 0.8);
closeTo(get("scratch2"), 0.8);
assert.ok(get("rate_ratio") > 1.07, "audio responds before smoothed display");
for (let i = 0; i < 500; ++i) advance(-nominal * 0.8);
assert.ok(get("rate_ratio") > 0.79 && get("rate_ratio") < 0.81);

const displayedPitch = get("rate_ratio");
advance(nominal);
closeTo(get("scratch2"), -1);
for (let i = 0; i < 300; ++i) advance(0);
closeTo(get("scratch2"), 0);
closeTo(get("rate_ratio"), displayedPitch, 0.001);
assert.equal(get("play"), 1, "scratch holds do not toggle play");
advance(nominal * 0.03);
closeTo(get("scratch2"), -0.03);
advance(-nominal * 0.03);
closeTo(get("scratch2"), 0.03);
let fastReverseTravel = 0;
for (let i = 0; i < 150; ++i) {
    advance(nominal * 6);
    fastReverseTravel += get("scratch2") * nominal * 0.002 / (2 * Math.PI);
}
closeTo(fastReverseTravel, -1, 0.001); // One quick reverse revolution in 0.3 s.
advance(-nominal * 6);
closeTo(get("scratch2"), 6, 0.001);
advance(-nominal * 15);
closeTo(get("scratch2"), 12, 0.001);

now += 2;
report(-90, -nominal, ++timestamp, 12, 0, 55);
assert.equal(get("scratch2_enable", 2), 1, "stationary remote B activates without motion threshold");
closeTo(get("scratch2", 2), 0);
now += 2;
report(-90, -nominal, ++timestamp, 12, nominal * 0.5, 56);
closeTo(get("scratch2", 2), -0.5);
now += 2;
report(-90, -nominal, ++timestamp);
assert.equal(get("scratch2_enable", 2), 0, "absent B releases only deck 2");
assert.equal(get("scratch2_enable"), 1);

connections.get("[Channel1],track_loaded")();
assert.equal(get("scratch2_enable"), 0);
assert.equal(get("play"), 0, "release prevents ordinary playback from taking over");
assert.equal(get("rate_ratio"), 1);
advance(-nominal);
assert.equal(get("scratch2_enable"), 1, "new track can accept fresh Phase samples");

now += 250;
watchdog();
assert.equal(get("scratch2_enable"), 0, "stale radio samples release the deck");
assert.equal(get("scratch2"), 0);
assert.equal(get("rate_ratio"), 1);

phase.shutdown();
assert.equal(connections.size, 0);
console.log("Phase HID scratch2 transport, BPM feedback, stop, reverse, and loss checks passed");
