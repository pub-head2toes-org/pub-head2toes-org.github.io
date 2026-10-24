'use strict';

/**
 * UPDATE_10 spike: what sealing every encoded frame of a call would cost.
 *
 * It does to made-up frames what an RTCRtpScriptTransform would do to real
 * ones: AES-128-GCM with a counter IV, the codec's first bytes left in the
 * clear and bound as AAD, and a new buffer per frame - one frame at a time,
 * as a transform stream hands them over. A call's seconds are run as fast as
 * they go; the time taken over the time simulated is the share of one core.
 *
 *   node frames.js            on this machine
 *   frames.html               in a browser, in a worker as a transform runs
 */

const SCENARIOS = [
    // name, video kbit/s, how many streams are sealed and how many opened
    { name: 'one to one, 360p', kbps: 600, up: 1, down: 1 },
    { name: 'one to one, 720p', kbps: 1500, up: 1, down: 1 },
    { name: 'four in a mesh, 360p', kbps: 600, up: 3, down: 3 },
    { name: 'four in a mesh, 720p', kbps: 1500, up: 3, down: 3 }
];
const SECONDS = 10;
const FPS = 30;
const AUDIO_PER_S = 50;      // Opus, 20 ms frames
const AUDIO_BYTES = 80;      // 32 kbit/s
const KEY_EVERY = 3 * FPS;   // a key frame every 3 s, ten times a delta frame
const IV = 12;
const TAG = 16;
// VP8 sends its payload header in the clear: 10 bytes on a key frame, 3 on a
// delta frame; Opus its TOC byte.
const CLEAR = { key: 10, delta: 3, audio: 1 };

/** One second of one sender's frames: sizes and how many bytes stay clear. */
function second(kbps, index) {
    const frames = [];
    // Average bytes per video frame, with key frames ten times the rest.
    const perGroup = kbps * 1000 / 8 * KEY_EVERY / FPS;
    const delta = Math.round(perGroup / (KEY_EVERY - 1 + 10));
    for (let i = 0; i < FPS; i++) {
        const key = (index * FPS + i) % KEY_EVERY === 0;
        frames.push({ size: key ? delta * 10 : delta, clear: key ? CLEAR.key : CLEAR.delta });
    }
    for (let i = 0; i < AUDIO_PER_S; i++) {
        frames.push({ size: AUDIO_BYTES, clear: CLEAR.audio });
    }
    return frames;
}

function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Seals a frame as a sender transform would: clear header | ciphertext+tag | IV. */
function seal(subtle, key, counter, data, clear) {
    const iv = new Uint8Array(IV);
    new DataView(iv.buffer).setUint32(8, counter);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: data.subarray(0, clear) }, key, data.subarray(clear))
        .then(function (sealed) {
            const out = new Uint8Array(clear + sealed.byteLength + IV);
            out.set(data.subarray(0, clear), 0);
            out.set(new Uint8Array(sealed), clear);
            out.set(iv, clear + sealed.byteLength);
            return out;
        });
}

/** Opens what `seal` made, as a receiver transform would. */
function open(subtle, key, data, clear) {
    const iv = data.subarray(data.length - IV);
    return subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: data.subarray(0, clear) }, key,
        data.subarray(clear, data.length - IV))
        .then(function (plain) {
            const out = new Uint8Array(clear + plain.byteLength);
            out.set(data.subarray(0, clear), 0);
            out.set(new Uint8Array(plain), clear);
            return out;
        });
}

/** One scenario: every frame of SECONDS seconds, sealed `up` times and opened `down` times. */
async function run(subtle, s) {
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
    const plain = new Uint8Array(256 * 1024);
    let counter = 0;
    let sealedBytes = 0;
    let payload = 0;
    let frames = 0;
    let worst = 0;
    const started = now();
    for (let sec = 0; sec < SECONDS; sec++) {
        for (const f of second(s.kbps, sec)) {
            const data = plain.subarray(0, f.size);
            for (let u = 0; u < s.up; u++) {
                const t = now();
                const out = await seal(subtle, key, counter++, data, f.clear);
                worst = Math.max(worst, now() - t);
                sealedBytes += out.length;
                payload += f.size;
                frames += 1;
                if (u < s.down) {
                    // What a pal sent this way is opened here as often as there are pals.
                    const t2 = now();
                    await open(subtle, key, out, f.clear);
                    worst = Math.max(worst, now() - t2);
                    frames += 1;
                }
            }
        }
    }
    const took = now() - started;
    return {
        name: s.name,
        frames: frames,
        perFrameUs: Math.round(took * 1000 / frames),
        worstMs: Math.round(worst * 100) / 100,
        core: Math.round(took / (SECONDS * 1000) * 1000) / 10,
        overheadKbps: Math.round((sealedBytes - payload) * 8 / SECONDS / s.up / 1000 * 10) / 10
    };
}

async function runAll(subtle, report) {
    for (const s of SCENARIOS) {
        report(await run(subtle, s));
    }
}

function line(r) {
    return r.name + ': ' + r.frames + ' frames, ' + r.perFrameUs + ' µs a frame (worst ' + r.worstMs +
        ' ms), ' + r.core + '% of one core, +' + r.overheadKbps + ' kbit/s per stream';
}

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    // Node: node frames.js
    runAll(globalThis.crypto.subtle, r => console.log(line(r)));
} else if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    // In the worker frames.html starts.
    runAll(self.crypto.subtle, r => self.postMessage(line(r))).then(() => self.postMessage('done'));
}
