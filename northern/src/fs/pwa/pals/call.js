'use strict';

/**
 * One call, as WebRTC sees it: the peer connection, the order its steps go
 * in, and when it is over. No DOM, no network - what it sends goes through
 * `send`, what arrives comes in through `receive`, and the page puts the
 * streams on screen - so it is tested with a fake RTCPeerConnection.
 *
 * The caller always makes the offer; the one called always answers it:
 *
 *   caller                                 callee
 *   (rings by push, listens on the channel)
 *                                          answers: listens, sends `ready`
 *   on ready: offer -------------------->  on offer: answer
 *   on answer: set it    <---------------
 *   ice candidates both ways, kept until the other side's description is set
 *   connected: the media flows device to device, or through TURN
 *   bye, over the data channel when it is open, or the /sub/ channel
 *
 * `options`:
 *   role       'caller' or 'callee'
 *   call       the call's id
 *   config     the RTCConfiguration (PalsCalls.rtcConfig)
 *   local      the camera and microphone, a MediaStream
 *   RTCPeerConnection
 *   send(t, extra)     sends a signal to the other side; returns a promise
 *   on.state(state)    'calling', 'connecting', 'connected', 'reconnecting'
 *   on.remote(stream)  the other side's camera and microphone
 *   on.ended(reason)   once, when it is over, with why in words
 *   timers     { setTimeout, clearTimeout }, for the tests
 */
const PalsCall = (function () {

    const api = {};

    api.create = function (options) {
        const o = options;
        // Called through wrappers: a browser throws "Illegal invocation" when its
        // setTimeout is called as a method of anything but the window.
        const timers = o.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
        const on = o.on || {};
        let pc = null;
        let dc = null;
        let state = o.role === 'caller' ? 'calling' : 'connecting';
        let ended = '';
        let timer = null;
        // Candidates that came before the other side's description.
        const early = [];

        const call = {};

        function setState(next) {
            if (ended || state === next) {
                return;
            }
            state = next;
            if (on.state) {
                on.state(next);
            }
        }

        function wait(ms, reason) {
            timers.clearTimeout(timer);
            timer = timers.setTimeout(() => end(reason), ms);
        }

        function end(reason) {
            if (ended) {
                return;
            }
            ended = reason || 'the call ended';
            state = 'ended';
            timers.clearTimeout(timer);
            if (pc) {
                pc.ontrack = null;
                pc.onicecandidate = null;
                pc.onconnectionstatechange = null;
                try {
                    pc.close();
                } catch (e) {
                    // already closed
                }
            }
            if (on.ended) {
                on.ended(ended);
            }
        }

        const send = (t, extra) => Promise.resolve(o.send(t, extra)).catch(() => {});

        function useChannel(channel) {
            dc = channel;
            dc.onmessage = function (event) {
                if (event.data === 'bye') {
                    end('they hung up');
                }
            };
        }

        function makePeer() {
            pc = new o.RTCPeerConnection(o.config);
            if (o.local) {
                o.local.getTracks().forEach(track => pc.addTrack(track, o.local));
            }
            pc.onicecandidate = function (event) {
                if (event.candidate) {
                    send('ice', { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
                }
            };
            pc.ontrack = function (event) {
                if (on.remote) {
                    on.remote(event.streams && event.streams[0] ? event.streams[0] : null, event.track);
                }
            };
            pc.onconnectionstatechange = function () {
                const s = pc.connectionState;
                if (s === 'connected') {
                    timers.clearTimeout(timer);
                    setState('connected');
                } else if (s === 'disconnected') {
                    setState('reconnecting');
                } else if (s === 'failed') {
                    end('the connection failed - a TURN server would get it through');
                }
            };
            pc.ondatachannel = event => useChannel(event.channel);
            // Neither side reached the other in time: no route between them.
            wait(30 * 1000, 'the devices could not reach each other - a TURN server would get it through');
        }

        function flush() {
            early.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
        }

        /** Starts it: the caller waits to be answered; the one called says it is ready. */
        call.start = function () {
            if (o.role === 'caller') {
                wait(PalsCalls.ANSWER_MS, 'no answer');
                return Promise.resolve();
            }
            wait(PalsCalls.OFFER_MS, 'the call is gone - they hung up');
            return send('ready');
        };

        /** A signal from the other side, checked by PalsCalls.readSignal already. */
        call.receive = function (signal) {
            if (ended) {
                return Promise.resolve();
            }
            const s = signal;
            if (s.t === 'bye') {
                end('they hung up');
                return Promise.resolve();
            }
            if (o.role === 'caller' && s.t === 'decline') {
                end(s.busy ? 'they are on another call' : 'they declined');
                return Promise.resolve();
            }
            if (o.role === 'caller' && s.t === 'ready' && !pc) {
                setState('connecting');
                makePeer();
                useChannel(pc.createDataChannel('pals-call'));
                return pc.createOffer()
                    .then(offer => pc.setLocalDescription(offer))
                    .then(() => send('offer', { sdp: pc.localDescription.sdp }))
                    .catch(e => end('the call could not be set up: ' + e.message));
            }
            if (o.role === 'callee' && s.t === 'offer' && !pc) {
                makePeer();
                return pc.setRemoteDescription({ type: 'offer', sdp: s.sdp })
                    .then(() => { flush(); return pc.createAnswer(); })
                    .then(answer => pc.setLocalDescription(answer))
                    .then(() => send('answer', { sdp: pc.localDescription.sdp }))
                    .catch(e => end('the call could not be set up: ' + e.message));
            }
            if (o.role === 'caller' && s.t === 'answer' && pc && !pc.remoteDescription) {
                return pc.setRemoteDescription({ type: 'answer', sdp: s.sdp })
                    .then(flush)
                    .catch(e => end('the call could not be set up: ' + e.message));
            }
            if (s.t === 'ice') {
                if (pc && pc.remoteDescription) {
                    return pc.addIceCandidate(s.candidate).catch(() => {});
                }
                early.push(s.candidate);
            }
            return Promise.resolve();
        };

        /** The user hangs up: the other side is told, over the data channel and the /sub/ channel both. */
        call.hangUp = function () {
            if (ended) {
                return Promise.resolve();
            }
            if (dc && dc.readyState === 'open') {
                try {
                    dc.send('bye');
                } catch (e) {
                    // the channel went first
                }
            }
            const told = send('bye');
            end(state === 'calling' ? 'cancelled' : 'hung up');
            return told;
        };

        call.state = () => state;
        call.ended = () => ended;
        call.peer = () => pc;

        return call;
    };

    return api;
})();
