"use strict";

var PhaseEssential = {};

PhaseEssential.nominalRadiansPerSecond = 2 * Math.PI * (33 + 1 / 3) / 60;
PhaseEssential.reportTimeoutMs = 200;
PhaseEssential.stopDelayMs = 80;
PhaseEssential.bpmUpdateMs = 50;
PhaseEssential.bpmSmoothingMs = 250;
PhaseEssential.deckState = [];
PhaseEssential.trackConnections = [];
PhaseEssential.watchdog = 0;

PhaseEssential.newDeckState = function() {
    return { enabled: false, timestamp: null, lastFreshAt: 0, lastPosition: 0,
        lastMotionAt: 0, lastBpmAt: 0, bpmRate: 1, origin: 0, sampleRate: 0 };
};

PhaseEssential.init = function(id, debugging) {
    PhaseEssential.deckState = [PhaseEssential.newDeckState(), PhaseEssential.newDeckState()];
    PhaseEssential.trackConnections = [];
    PhaseEssential.debugging = debugging;
    for (var deck = 0; deck < 2; ++deck) {
        PhaseEssential.trackConnections.push(engine.makeConnection(
            "[Channel" + (deck + 1) + "]", "track_loaded", PhaseEssential.trackChanged(deck)));
    }
    PhaseEssential.watchdog = engine.beginTimer(50, PhaseEssential.checkTimeout);
    if (debugging) {
        print("Phase Essential HID mapping loaded: " + id + "; run go-phase wake after each USB reconnect");
    }
};

PhaseEssential.trackChanged = function(deck) {
    return function() {
        PhaseEssential.releaseDeck(deck);
    };
};

PhaseEssential.shutdown = function() {
    if (PhaseEssential.watchdog) {
        engine.stopTimer(PhaseEssential.watchdog);
        PhaseEssential.watchdog = 0;
    }
    for (var deck = 0; deck < 2; ++deck) {
        PhaseEssential.releaseDeck(deck);
    }
    for (var i = 0; i < PhaseEssential.trackConnections.length; ++i) {
        if (PhaseEssential.trackConnections[i]) {
            PhaseEssential.trackConnections[i].disconnect();
        }
    }
    PhaseEssential.trackConnections = [];
};

PhaseEssential.releaseDeck = function(deck) {
    if (!PhaseEssential.deckState[deck].enabled) {
        return;
    }
    var group = "[Channel" + (deck + 1) + "]";
    // Pause before releasing position control, or the deck resumes at its last pitch.
    engine.setValue(group, "play", 0);
    engine.setValue(group, "scratch_position_enable", 0);
    engine.setValue(group, "rate_ratio", 1);
    PhaseEssential.deckState[deck] = PhaseEssential.newDeckState();
};

PhaseEssential.checkTimeout = function() {
    var now = Date.now();
    for (var deck = 0; deck < 2; ++deck) {
        var state = PhaseEssential.deckState[deck];
        if (state.enabled && now - state.lastFreshAt > PhaseEssential.reportTimeoutMs) {
            PhaseEssential.releaseDeck(deck);
        }
    }
};

PhaseEssential.float32LE = function(data, offset) {
    // Avoid DataView requirements in older Mixxx scripting engines.
    var bits = (data[offset] & 255) |
        ((data[offset + 1] & 255) << 8) |
        ((data[offset + 2] & 255) << 16) |
        ((data[offset + 3] & 255) << 24);
    var sign = bits < 0 ? -1 : 1;
    var exponent = (bits >>> 23) & 255;
    var fraction = bits & 0x7fffff;
    if (exponent === 255) {
        return fraction ? NaN : sign * Infinity;
    }
    if (exponent === 0) {
        return sign * fraction * Math.pow(2, -149);
    }
    return sign * (1 + fraction / 0x800000) * Math.pow(2, exponent - 127);
};

PhaseEssential.decodePositionReport = function(data, length) {
    if (length !== 64 || (data[0] & 255) !== 3) {
        return null;
    }
    return [
        { position: PhaseEssential.float32LE(data, 1), velocity: PhaseEssential.float32LE(data, 5),
            timestamp: PhaseEssential.uint32LE(data, 14) },
        { position: PhaseEssential.float32LE(data, 32), velocity: PhaseEssential.float32LE(data, 36),
            timestamp: PhaseEssential.uint32LE(data, 45) }
    ];
};

PhaseEssential.uint32LE = function(data, offset) {
    return ((data[offset] & 255) | ((data[offset + 1] & 255) << 8) |
        ((data[offset + 2] & 255) << 16) | ((data[offset + 3] & 255) << 24)) >>> 0;
};

PhaseEssential.updateBpm = function(group, state, speed, now) {
    if (now - state.lastBpmAt < PhaseEssential.bpmUpdateMs) {
        return;
    }
    var elapsed = now - state.lastBpmAt;
    state.lastBpmAt = now;
    // Forward speed only; reverse and a stopped record have no useful BPM.
    var target = speed > 0.05 && speed < 1.9 ? speed : 1;
    var alpha = 1 - Math.exp(-elapsed / PhaseEssential.bpmSmoothingMs);
    state.bpmRate += alpha * (target - state.bpmRate);
    engine.setValue(group, "rate_ratio", state.bpmRate);
};

PhaseEssential.updateDeck = function(deck, remote, now) {
    var state = PhaseEssential.deckState[deck];
    if (!remote.timestamp || !isFinite(remote.velocity) || !isFinite(remote.position)) {
        PhaseEssential.releaseDeck(deck);
        return;
    }
    if (remote.timestamp === state.timestamp) {
        return; // Receiver repeats radio samples between HID reports.
    }
    var group = "[Channel" + (deck + 1) + "]";
    var sampleRate = engine.getValue(group, "track_samplerate");
    if (!engine.getValue(group, "track_loaded") || !isFinite(sampleRate) || sampleRate <= 0) {
        PhaseEssential.releaseDeck(deck);
        return;
    }
    if (state.enabled && (sampleRate !== state.sampleRate ||
            Math.abs(remote.position - state.lastPosition) > 2)) {
        // A new track format or a radio position reset needs a fresh origin.
        PhaseEssential.releaseDeck(deck);
        return;
    }
    if (!state.enabled) {
        state.enabled = true;
        state.origin = remote.position;
        state.sampleRate = sampleRate;
        state.lastBpmAt = now;
        engine.setValue(group, "scratch_position", 0);
        engine.setValue(group, "scratch_position_enable", 1);
    }
    state.timestamp = remote.timestamp;
    state.lastFreshAt = now;
    if (remote.position !== state.lastPosition) {
        // Mixxx scratch_position uses stereo track samples. Forward Phase angle
        // decreases, so negate distance; Mixxx feeds back actual playhead travel.
        engine.setValue(group, "scratch_position",
            (state.origin - remote.position) * 2 * sampleRate / PhaseEssential.nominalRadiansPerSecond);
        state.lastPosition = remote.position;
    }
    var speed = -remote.velocity / PhaseEssential.nominalRadiansPerSecond;
    if (Math.abs(speed) > 0.02) {
        state.lastMotionAt = now;
        if (!engine.getValue(group, "play")) {
            engine.setValue(group, "play", 1);
        }
    } else if (now - state.lastMotionAt > PhaseEssential.stopDelayMs &&
            engine.getValue(group, "play")) {
        engine.setValue(group, "play", 0);
    }
    PhaseEssential.updateBpm(group, state, speed, now);
};

PhaseEssential.incomingData = function(data, length) {
    if (length < 1) {
        return;
    }
    var reportId = data[0] & 255;
    if (reportId === 2) {
        if (PhaseEssential.debugging && length >= 8) {
            var name = "";
            for (var i = 2; i < 8; ++i) {
                name += String.fromCharCode(data[i] & 255);
            }
            print("Phase HID integration response: status=" + (data[1] & 255) + " name=" + name);
        }
        return;
    }
    if (reportId !== 3) {
        return;
    }
    var remotes = PhaseEssential.decodePositionReport(data, length);
    if (!remotes) {
        return;
    }
    var now = Date.now();
    for (var deck = 0; deck < 2; ++deck) {
        PhaseEssential.updateDeck(deck, remotes[deck], now);
    }
};
