"use strict";

var PhaseEssential = {};

PhaseEssential.nominalRadiansPerSecond = 2 * Math.PI * (33 + 1 / 3) / 60;
// Allow fast hand spins. 3x (one revolution in 0.6 s) clipped quick backspins.
PhaseEssential.maximumScratchSpeed = 12;
PhaseEssential.reportTimeoutMs = 200;
PhaseEssential.stopDelayMs = 2000;
// Ignore tiny velocity noise for play-state detection only; audio stays unfiltered.
PhaseEssential.movementThreshold = 0.001;
PhaseEssential.bpmUpdateMs = 50;
PhaseEssential.bpmSmoothingMs = 250;
PhaseEssential.deckState = [];
PhaseEssential.connections = [];
PhaseEssential.watchdog = 0;

PhaseEssential.newDeckState = function() {
    return { enabled: false, timestamp: null, lastFreshAt: 0, stationarySince: null,
        lastBpmAt: 0, bpmRate: 1 };
};

PhaseEssential.init = function(id, debugging) {
    PhaseEssential.deckState = [PhaseEssential.newDeckState(), PhaseEssential.newDeckState()];
    PhaseEssential.connections = [];
    PhaseEssential.debugging = debugging;
    for (var deck = 0; deck < 2; ++deck) {
        PhaseEssential.connections.push(engine.makeConnection(
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
    for (var i = 0; i < PhaseEssential.connections.length; ++i) {
        if (PhaseEssential.connections[i]) {
            PhaseEssential.connections[i].disconnect();
        }
    }
    PhaseEssential.connections = [];
};

PhaseEssential.releaseDeck = function(deck) {
    if (!PhaseEssential.deckState[deck].enabled) {
        return;
    }
    var group = "[Channel" + (deck + 1) + "]";
    // Pause before releasing scratch2, or ordinary playback resumes at its last pitch.
    engine.setValue(group, "play", 0);
    engine.setValue(group, "scratch2", 0);
    engine.setValue(group, "scratch2_enable", 0);
    engine.setValue(group, "rate_ratio", 1);
    PhaseEssential.deckState[deck] = PhaseEssential.newDeckState();
};

PhaseEssential.checkTimeout = function() {
    var now = Date.now();
    for (var deck = 0; deck < 2; ++deck) {
        var state = PhaseEssential.deckState[deck];
        if (state.enabled && now - state.lastFreshAt > PhaseEssential.reportTimeoutMs) {
            PhaseEssential.releaseDeck(deck);
        } else if (state.enabled && state.stationarySince !== null &&
                now - state.stationarySince >= PhaseEssential.stopDelayMs) {
            var group = "[Channel" + (deck + 1) + "]";
            if (engine.getValue(group, "play")) {
                engine.setValue(group, "play", 0);
            }
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

PhaseEssential.scratchSpeed = function(velocity) {
    // The transport sees raw signed Phase speed; UI smoothing never touches audio.
    var speed = -velocity / PhaseEssential.nominalRadiansPerSecond;
    return Math.max(-PhaseEssential.maximumScratchSpeed,
        Math.min(PhaseEssential.maximumScratchSpeed, speed));
};

PhaseEssential.updateBpm = function(group, state, speed, now) {
    if (now - state.lastBpmAt < PhaseEssential.bpmUpdateMs) {
        return;
    }
    var elapsed = now - state.lastBpmAt;
    state.lastBpmAt = now;
    // Hold the last meaningful forward pitch through stops and reverse scratches.
    if (speed <= 0.05 || speed >= 1.9) {
        return;
    }
    var alpha = 1 - Math.exp(-elapsed / PhaseEssential.bpmSmoothingMs);
    state.bpmRate += alpha * (speed - state.bpmRate);
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
    if (!engine.getValue(group, "track_loaded")) {
        PhaseEssential.releaseDeck(deck);
        return;
    }
    if (!state.enabled) {
        state.enabled = true;
        state.lastBpmAt = now;
        engine.setValue(group, "scratch2", 0);
        engine.setValue(group, "scratch2_enable", 1);
    }
    state.timestamp = remote.timestamp;
    state.lastFreshAt = now;
    var speed = PhaseEssential.scratchSpeed(remote.velocity);
    engine.setValue(group, "scratch2", speed);
    if (Math.abs(speed) > PhaseEssential.movementThreshold) {
        state.stationarySince = null;
        if (!engine.getValue(group, "play")) {
            engine.setValue(group, "play", 1);
        }
    } else if (state.stationarySince === null) {
        state.stationarySince = now;
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
