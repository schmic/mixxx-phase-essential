"use strict";

var PhaseEssential = {};

PhaseEssential.nominalRadiansPerSecond = 2 * Math.PI * (33 + 1 / 3) / 60;
PhaseEssential.maximumScratchSpeed = 3;
PhaseEssential.reportTimeoutMs = 500;
PhaseEssential.deckState = [{ enabled: false }, { enabled: false }];
PhaseEssential.lastReportAt = 0;
PhaseEssential.watchdog = 0;

PhaseEssential.init = function(id, debugging) {
    PhaseEssential.deckState = [{ enabled: false }, { enabled: false }];
    PhaseEssential.lastReportAt = 0;
    PhaseEssential.debugging = debugging;
    PhaseEssential.watchdog = engine.beginTimer(100, PhaseEssential.checkTimeout);
    if (debugging) {
        print("Phase Essential HID mapping loaded: " + id + "; run go-phase wake after each USB reconnect");
    }
};

PhaseEssential.shutdown = function() {
    if (PhaseEssential.watchdog) {
        engine.stopTimer(PhaseEssential.watchdog);
        PhaseEssential.watchdog = 0;
    }
    for (var deck = 0; deck < 2; ++deck) {
        PhaseEssential.releaseDeck(deck);
    }
};

PhaseEssential.releaseDeck = function(deck) {
    if (!PhaseEssential.deckState[deck].enabled) {
        return;
    }
    var group = "[Channel" + (deck + 1) + "]";
    engine.setValue(group, "scratch2", 0);
    engine.setValue(group, "scratch2_enable", 0);
    PhaseEssential.deckState[deck].enabled = false;
};

PhaseEssential.checkTimeout = function() {
    if (PhaseEssential.lastReportAt && Date.now() - PhaseEssential.lastReportAt > PhaseEssential.reportTimeoutMs) {
        for (var deck = 0; deck < 2; ++deck) {
            PhaseEssential.releaseDeck(deck);
        }
        PhaseEssential.lastReportAt = 0;
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
        { position: PhaseEssential.float32LE(data, 1), velocity: PhaseEssential.float32LE(data, 5) },
        { position: PhaseEssential.float32LE(data, 32), velocity: PhaseEssential.float32LE(data, 36) }
    ];
};

PhaseEssential.scratchSpeed = function(velocity) {
    // Phase reports negative angular velocity for forward playback.
    var speed = -velocity / PhaseEssential.nominalRadiansPerSecond;
    return Math.max(-PhaseEssential.maximumScratchSpeed,
        Math.min(PhaseEssential.maximumScratchSpeed, speed));
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
    PhaseEssential.lastReportAt = Date.now();
    for (var deck = 0; deck < 2; ++deck) {
        var remote = remotes[deck];
        if (!isFinite(remote.velocity) || !isFinite(remote.position)) {
            PhaseEssential.releaseDeck(deck);
            continue;
        }
        var group = "[Channel" + (deck + 1) + "]";
        if (!PhaseEssential.deckState[deck].enabled) {
            // Zeroed report fields can also mean a remote is absent or charging.
            // Do not take over an idle deck before any motion is seen.
            if (Math.abs(remote.velocity) < 0.02) {
                continue;
            }
            engine.setValue(group, "scratch2_enable", 1);
            PhaseEssential.deckState[deck].enabled = true;
        }
        engine.setValue(group, "scratch2", PhaseEssential.scratchSpeed(remote.velocity));
    }
};
