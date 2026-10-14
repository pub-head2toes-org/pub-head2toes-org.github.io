# Plan: (PWA) InPerson — video calls among friends

A PWA under `/fs/get/pwa/inPerson/`, served from its own host name
(`https://inperson.<domain>/`), for whoever is signed in to Northern. It is
built as `PROMPT.md` asks, on the pieces Pals already has: the push relay,
the ID Card's kept key, Pals' seal and the `/pals/` directory.

This document says what is built, how a call is set up, what it trusts, the
feasibility spike (coturn at home behind the Cloudflare tunnel, coturn on
Amazon Lightsail, Cloudflare's TURN service),
and how to bring calls into Pals.

Everything stated as a fact about the code is pinned by a test
(`tests/inPerson.test.js`, `tests/TurnApi.test.js`). What needs a real
browser, a real push or a real TURN server was tried on two devices on
2026-10-13 - see *Live check* - and what that did not cover is under *Not
verified*.

---

## Files

| File | What it is |
| --- | --- |
| `welcome.html`, `welcome.js` | The setup: push, the `/inperson/` row, and STUN/TURN, with *Check* |
| `index.html`, `inperson.js` | The app: Contacts, Call, the Self and Contact videos, the incoming call, Settings |
| `call.js` | `InPersonCall`: one call as WebRTC sees it. No DOM, no network: tested with a fake `RTCPeerConnection` |
| `model.js` | `InPersonModel`: the directories, the contacts, STUN/TURN, the signals. No DOM, storage or network |
| `views.js` | The contact rows and the call bar, as HTML text, everything escaped |
| `store.js` | `InPersonStore`: IndexedDB `inperson`, for the page and the worker |
| `sw.js` | The offline shell; opens a ring with the kept key and shows *alice is calling* |
| `version.js` | `INPERSON_VERSION` (2): the cache name, the `?v=` on every script |
| `styles.css`, `manifest.json`, `icon-*.png` | Look, install, icons |
| `../pals/seal.js` | **Pals' seal, loaded as it is**: every signal is sealed the way Pals seals a message |
| `example/` | The spike: `coturn/turnserver.conf`, `coturn/docker-compose.yml`, `lightsail/firewall.sh`, `lightsail/setup.sh`, `cloudflare/ice-servers.sh`, `northern.env.example` |
| `src/h2t/TurnApi.js` | **New, server.** `GET /turn/api/ice`: TURN credentials that expire, from coturn's secret or Cloudflare |
| `src/h2t/Server.js` | Mounts `/turn/api/`; the host guard now covers `inperson.` as it covers `pals.` |

## The pages

**`welcome.html`** — once per device, and again from Settings:

- Not signed in: to `Reg.html` and back, as Pals.
- *How calls reach the other device*:
  - **A STUN server only** — `stun:stun.cloudflare.com:3478` to start with.
    Enough when either side can be reached directly: most home networks, not
    every mobile one.
  - **My own TURN server** — its `turn:`/`turns:` addresses, a user name and a
    password (coturn with `lt-cred-mech`), plus STUN.
  - **TURN credentials from Northern** — `/turn/api/ice` hands out
    credentials that expire, from coturn's REST secret or Cloudflare,
    configured on the server (below). The device keeps no TURN password.
  - **Only through TURN** (`iceTransportPolicy: 'relay'`), to try a TURN server out.
  - **Check** gathers this device's ICE candidates with the configuration —
    no call, nothing sent but STUN and TURN — and says what it found: *TURN
    works*, *STUN works*, or *only this network's own addresses*.
  - **Save** keeps it in IndexedDB, per user.
- **Go** — as Pals' welcome page: the ID Card's key must be on the device,
  notifications allowed, the service worker registered and subscribed with
  Northern's VAPID key. The device is listed at
  `/inperson/<username>/<key>` (the shape of Pals' row), the setup kept,
  and the app opens.

**`index.html`**:

- The name and the gear (Settings: who is signed in, how calls get through,
  *Change STUN and TURN*, the version).
- **Contacts** — everybody Pals lists under `/pals/` (the list Pals adds pals
  from), and everybody set up for calls under `/inperson/`, less the user.
  Somebody who has not set InPerson up is listed in grey italics, *not set up
  for calls*, and **Call** stays disabled for them. **Refresh** reads both
  lists again.
- **Call** starts the call sequence (below).
- Two videos: **Contact** large, **Self** small in its corner, mirrored. On a
  phone the videos come first, the contacts under them.
- The call bar: *Calling bob…*, *Connecting…*, *In a call with bob*, then
  how it ended — *they declined*, *no answer*, *they hung up*… — and **Hang up**.
- **The incoming call** — *alice is calling*, **Answer** or **Decline**. It
  goes after a minute, as a missed call.
- Without the ID Card's key on the device: a notice with a link to load it,
  and Call disabled.

## A call, step by step

```
alice's page                    Northern                       bob's service worker / page
  camera on (Self)
  listen  GET /sub/inperson-<id>  (SSE)
  ring    POST /push/api/send ---> push service ---------------> sw: open with bob's key,
          sealed {t:'ring', call:id}                               notify "alice is calling"
                                                                 page: Answer
                                                                   camera on, listen on /sub/inperson-<id>
          <-------------------- PUT /sub/inperson-<id> ------------ {t:'ready'}          (sealed)
  offer   PUT ------------------------------------------------->  answer
          <-------------------------------------------------------  {t:'answer', sdp}  (sealed)
  ice     <---------------------- both ways --------------------->  ice                (sealed)
  connected: media device to device (or through TURN), DTLS-SRTP
  bye     over the WebRTC data channel, and on /sub/
```

- **The id** is 16 random bytes, base64url: the name of the call's `/sub/`
  channel. Only the two ends and Northern know it.
- **Listen first, then speak.** `/sub/` keeps nothing: a `PUT` reaches whoever
  listens at that moment. So the caller listens before ringing, and the one
  called listens before saying *ready*; the offer waits for *ready*.
- **The ring goes by push** (`/push/api/send`, with Pals' send proof); an
  offer is too large for one push. It is sealed to the other side's key with
  `PalsSeal`, as a Pals message is, so it carries the call id unseen.
- **Everything on the channel is sealed too**, from one Northern key to the
  other, with the call id inside and a fresh id per signal: a signal from
  anybody else, for another call, or seen before is dropped.
- **Only the caller offers**, so there is no glare to resolve. ICE candidates
  are trickled, and kept until the other side's description is in.
- **Timeouts.** 45 s for an answer (*no answer*); 20 s for the offer once
  answered (*the call is gone*); 30 s for ICE to connect (*the devices could
  not reach each other — a TURN server would get it through*); a ring older
  than a minute is a missed call.
- **Giving up stops the ringing.** No answer, or hung up while ringing,
  pushes `{t:'cancel'}`: bob's notification becomes *Missed call from
  alice*, and an open page closes its *is calling* and says so.
- **Busy.** A ring during a call is declined with `busy`: *they are on
  another call*.
- **Hang up** goes over the WebRTC data channel — Northern is not needed once
  connected — and on `/sub/` as well, for a call not yet connected.
- **When the camera is refused**, nothing is rung, and the call bar says why.
- **The session.** As Pals: the page goes to `Reg.html` when the cookie is
  gone, on load and when it comes back into view — but never in the middle of
  a call.

## What this design trusts

- **The media is end to end.** WebRTC encrypts it with DTLS-SRTP; the keys
  are agreed between the two browsers. A TURN server relays packets it cannot
  read.
- **And nobody can step into the middle** — not Northern, not the TURN
  server — *provided the keys are the right ones*: the SDP carries each side's
  DTLS fingerprint, and it travels sealed between the two Northern keys, so
  it cannot be swapped.
- **The weak point is where the other side's key comes from.** InPerson
  takes it from the directory, as Pals' *Add a pal* does, but pins nothing:
  a server that lied in the directory at the moment of a call could put its
  own key in bob's place. Pals pins a pal's key when they are added and lets
  two people compare fingerprints. **Moving calls into Pals closes this**
  (see the port plan). Until then: a curious server, a stolen database and the
  TURN provider learn nothing of a call's content; a server that serves false
  directory rows or a changed app could.
- **What Northern and the TURN provider learn:** who rings whom and when (the
  push, the channel), for how long, and — for a relayed call — both ends'
  addresses and how much went through.

---

## Spike: coturn

`example/coturn/turnserver.conf` and `docker-compose.yml`, with Northern
handing out credentials (`/turn/api/ice`) from coturn's REST secret.

**The credentials** — coturn's TURN REST API (`use-auth-secret`):

```
username   = <expires, seconds since 1970> ":" <who>
credential = base64( HMAC-SHA1( static-auth-secret, username ) )
```

coturn computes the same from the secret it shares with Northern, so it
stores nothing per user, and a credential stops working when it expires.
`TurnApi.js` makes them for the signed-in user, `<who>` being the first 12
characters of their key (what coturn logs), for `NORTHERN_TURN_TTL` seconds
(12 hours by default). A test checks them against HMAC-SHA1 computed apart.

**Northern's side** — `example/northern.env.example`:

```
NORTHERN_TURN=coturn
NORTHERN_TURN_SECRET=<the static-auth-secret>
NORTHERN_TURN_URLS=turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp,turns:turn.example.org:5349?transport=tcp
NORTHERN_TURN_STUN=stun:turn.example.org:3478
```

Then *TURN credentials from Northern* on `welcome.html`, and *Check* with
*Only through TURN*: it says *TURN works* when the relay answers.

**What the config does that matters:**
- `external-ip=<public>/<private>`: coturn on a Pi behind the router's NAT
  tells browsers the address they can reach.
- `min-port`/`max-port`: 40 UDP relay ports, 20 relayed calls at once. Only
  these, not the default 16 000, need forwarding.
- `denied-peer-ip` for every private, loopback and link-local range, and
  `no-multicast-peers`, `no-tcp-relay`: **a TURN server forwards to any
  address it is asked to**. Without these, anybody with credentials could
  reach Northern, the router and the rest of the home network through it.
- `user-quota`, `total-quota`: a credential cannot hold many relays.
- `turns:` on 5349 with a Let's Encrypt certificate, for networks that only
  let TLS out.

### With the Cloudflare tunnel

Northern is reached through a Cloudflare tunnel (`cloudflared`). That
changes nothing for the app — but **TURN cannot go through the tunnel**:

- A tunnel carries HTTP(S) and WebSockets to a public host name. It carries
  no UDP for the public, and raw TCP only to clients that run `cloudflared`
  themselves — a browser does not. TURN is UDP first, TCP/TLS second.
- The proxied (orange-cloud) DNS records carry HTTP only. So:
  1. **A separate host name for coturn, *DNS only* (grey cloud)**:
     `turn.example.org` → the home's public address. It is then public — the
     address the tunnel otherwise keeps hidden. With a changing address,
     keep the record current with a dynamic-DNS updater using Cloudflare's API.
  2. **Forward on the router** to the Pi: 3478 UDP and TCP, 5349 TCP,
     49160–49199 UDP. Nothing else; Northern stays behind the tunnel.
  3. **The certificate** for `turns:` by DNS challenge, since nothing on port
     80 answers for that name: `certbot certonly --dns-cloudflare
     --dns-cloudflare-credentials <cloudflare.ini> -d turn.example.org`, and
     a deploy hook that restarts coturn. A Cloudflare Origin CA certificate
     will not do: only Cloudflare trusts it.
  4. Optionally `tls-listening-port=443` (and forward 443 TCP): with the
     tunnel nothing else at home needs 443, and some networks let nothing else out.
- **Behind carrier-grade NAT** (no public address of one's own) none of this
  is possible: run coturn on a small server elsewhere - Amazon Lightsail,
  below - or use Cloudflare's TURN service.
- **The app itself through the tunnel:** the tunnel needs
  `inperson.example.org` in its ingress, to the same Northern as `pals.`.
  `/sub/` is server-sent events, which the tunnel streams; Cloudflare drops a
  connection idle for 100 seconds, after which the browser's `EventSource`
  reconnects on its own. Setting a call up takes seconds, and hanging up goes
  over the data channel, so nothing needed is lost to it.

## Spike: coturn on Amazon Lightsail

**Yes, it works**, and it removes what is awkward about coturn at home: the
home address stays behind the tunnel, nothing is forwarded on the router,
carrier-grade NAT does not matter, and the certificate can be had the plain
way. coturn is the same, with the same REST secret; Northern does not care
where it runs.

`example/lightsail/firewall.sh` (run on your computer, AWS CLI) and
`example/lightsail/setup.sh` (run on the instance) do the whole of it.

**What Lightsail gives a TURN server** (AWS's pricing and firewall pages, as
of October 2026):

- **A static IP**, included in every plan and free while it is attached. It
  must be one: coturn's `external-ip` and the DNS record both name the
  address, and an instance's ordinary public address changes when it is
  stopped and started.
- **The public address is NAT'd**: the instance itself only has its private
  address (172.26.x.x). Hence `external-ip=<static IP>/<private IP>`, as at
  home - `setup.sh` reads the private one from the instance.
- **A firewall per instance** that takes TCP and UDP rules over port
  *ranges*, IPv4 and IPv6 separately, and filters only what comes in through
  the public address. Open: 3478 UDP and TCP, 443 TCP (TURN over TLS),
  49160–49199 UDP (the relay ports), plus 22 and 80. `firewall.sh` sets
  exactly these (`put-instance-public-ports` replaces every rule).
- **Bundles with a public IPv4 address from $5 a month** (0.5 GB memory, 2
  burstable vCPUs, 20 GB disk, **1 TB transfer**). That is ample for coturn,
  which relays packets and needs little memory. The IPv6-only bundles are
  cheaper ($3.50) but no use here: most mobile and home networks still reach a
  TURN server over IPv4.

**What is different from coturn at home:**

- **TURN over TLS on 443.** Nothing else on the instance wants 443, so coturn
  takes it (`tls-listening-port=443`, allowed by a systemd
  `CAP_NET_BIND_SERVICE` drop-in): the one port nearly every network lets out.
  The URLs Northern hands out are then `turns:turn.example.org:443?transport=tcp`.
- **The certificate by HTTP challenge**: the instance answers on port 80
  itself (`certbot --standalone`). A deploy hook gives coturn a copy of the key
  it can read and restarts it on every renewal.
- **The DNS record** `turn.example.org` → the static IP, *DNS only* (grey
  cloud), as at home: Cloudflare's proxy carries HTTP only.
- **The instance's own neighbourhood is off limits** by the same
  `denied-peer-ip` list: the private ranges cover Lightsail's 172.26.0.0/16
  and other resources in the account, and 169.254.0.0/16 covers
  **169.254.169.254, the instance metadata service** - without it, anybody
  with credentials could ask it things through the relay.

**Northern's side** - only the addresses change:

```
NORTHERN_TURN=coturn
NORTHERN_TURN_SECRET=<the SECRET given to setup.sh>
NORTHERN_TURN_URLS=turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp,turns:turn.example.org:443?transport=tcp
NORTHERN_TURN_STUN=stun:turn.example.org:3478
```

**What it costs.** Lightsail counts **both directions** against the
allowance, and charges only *outbound* beyond it - from $0.09/GB, by region.
A relay counts every byte twice: in from one side, out to the other. A
relayed call at about 1.5 Mbit/s each way is some 0.7 GB an hour per
direction, so about 2.7 GB of allowance an hour: **1 TB is roughly 370 hours of
relayed calls a month** for the flat $5 - and most calls connect directly and
never touch it. Beyond that, about $0.12 an hour of relayed call, more than
Cloudflare's $0.05/GB. In Mumbai, Sydney, Jakarta, Malaysia, Hong Kong and
São Paulo, plans include half the transfer.

**Things to know:**
- **Pick the region nearest the people who call.** A relayed call goes caller
  → Lightsail → callee; a region across an ocean adds its round trip to every
  word.
- **Burstable CPU.** The small bundles run at a fraction of a core with
  credits for bursts. Relaying a handful of calls is light; many at once for
  hours could use the credits up. The memory grows with relays, not callers.
- **One region, one address** - Cloudflare answers from the nearest of many.
- **It is a server to keep**: Ubuntu updates (`unattended-upgrades` is on by
  default), coturn updates, the certificate renews itself.

## Spike: Cloudflare TURN

Cloudflare Realtime's TURN service, with Northern holding the API token:
`example/cloudflare/ice-servers.sh` is the request by hand.

- **Set up:** Cloudflare dashboard → Realtime → TURN Server → Create. It gives
  a *TURN key id* and an *API token*. Then:
  ```
  NORTHERN_TURN=cloudflare
  NORTHERN_TURN_KEY_ID=<key id>
  NORTHERN_TURN_KEY_TOKEN=<API token>
  ```
- **What Northern does** for each `/turn/api/ice`:
  `POST https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers`
  with `Authorization: Bearer <token>` and `{"ttl": 43200}`. Cloudflare
  answers `201` with `{iceServers: [...]}` — STUN, then TURN over UDP, TCP and
  TLS on 3478, 5349, 80 and 443, with a user name and credential — which is
  handed to the browser as it is, less any address on **port 53**, which
  browsers block (it would only time out). The token never leaves the server;
  the browser gets credentials that expire. A refusal or no credentials is
  `502`; the page then tries the call with the STUN servers set on the device.
- **Revoking** a credential early: `POST …/credentials/<username>/revoke`
  (in the script, commented).
- **Nothing to open at home**, and the home address stays hidden behind the
  tunnel. Cloudflare's network answers from the nearest location, on 443
  too, which gets through nearly every firewall.
- **Cost:** free with Cloudflare's SFU, otherwise **$0.05 per GB** sent from
  Cloudflare to the TURN client (Cloudflare's TURN page). Only relayed calls
  count — most calls connect directly. A relayed call at about 1.5 Mbit/s each
  way is about 0.7 GB an hour per side, some $0.07 an hour.
- **Limits** per allocation (one per credential), from the same page: more
  than 5 new addresses a second, 5–10 thousand packets a second, 50–100 Mbit/s.
  A two-person call is far below them.

### coturn at home, coturn on Lightsail, or Cloudflare

| | coturn at home | coturn on Lightsail | Cloudflare TURN |
| --- | --- | --- | --- |
| Runs on | the Pi, beside Northern | a $5/month instance | Cloudflare's network |
| To open at home | 3478, 5349, 40 UDP ports | nothing | nothing |
| Home address | public | hidden behind the tunnel | hidden behind the tunnel |
| Behind carrier-grade NAT | no | yes | yes |
| Reach from strict networks | 443 if given to it | 443 TCP/TLS | 443 TCP/TLS and UDP |
| Where it answers | home | one AWS region | the nearest of many |
| Cost | the upload of the home line | $5/month flat, ~370 relayed hours included; then from $0.09/GB | $0.05/GB relayed |
| Credentials | from Northern, coturn's REST secret | the same | from Northern, Cloudflare's API |
| Upkeep | coturn, its certificate, the router | coturn, the server, the region | the token |

Northern serves any of them through the same `/turn/api/ice`; switching is a
restart with other environment variables.

---

## Porting calls to Pals

**Done, in Pals version 16** (`../pals/PLAN.md`, *Video calls with a pal*):
steps 1-7 as below, with these differences - the signal travels as the
seal's `signal` beside a text an old Pals files instead (*Video call - this
Pals needs updating*), so `v: 2` stays; the Key button is in the call layer
itself; and since version 17 Pals has no STUN/TURN form - one switch in
Settings turns calls on, and every call takes TURN from Northern. Step 8 is still open:
InPerson stays as it is for now (decision I6).

Pals has what InPerson lacks: **pinned keys and fingerprints**. Calls belong
there. The port, in order:

1. **One subscription, one worker.** Pals rings Pals' own device: the ring and
   the cancel go to the `/pals/` row by the existing `/push/api/send`. No
   `/inperson/` rows, no second setup, no second origin, and the ID Card is
   loaded once.
2. **A signal is not a message.** `PalsSeal` gets an optional `signal` in the
   sealed inner (`{ts, body: '', signal}`), under the same `v: 2`. Pals' `sw.js`
   shows *alice is calling* (`requireInteraction`, tag per call) for a ring
   and *Missed call* for a cancel, instead of *New message*; the page's
   `drain()` hands signals to the call, never to `PalsModel.receive`. Bump
   `PALS_VERSION`: a device still on the old version would file a ring as an
   empty message until it updates.
3. **Only pals can be called, and only to the pinned key.** `PalsModel.pal()`
   gives the key; the directory gives only where to push, as for messages.
   The call shows the pal's *verified* ✓ — and the Key overlay works mid-call,
   which is exactly where two people can read their numbers to each other.
   A ring from somebody who is not a pal shows as a missed call in the Log,
   never rings.
4. **The code moves as it is.** `call.js` (as `PalsCall`), the signal half of
   `InPersonModel` (`signal`, `readSignal`, `incoming`, `channel`, the
   timeouts) and the STUN/TURN half (`cleanConfig`, `rtcConfig`,
   `candidateTypes`, `checkReport`) into a `calls.js` of Pals; the wiring of
   `inperson.js` into `pals.js`. The server needs nothing: `/sub/`,
   `/push/api/` and `/turn/api/` are host-independent, and the `pals.` guard
   already lets Pals' own files run.
5. **The UI.**
   - A **Call** button in the Messages layer when it shows a pal (not a group:
     a group call needs a mesh or an SFU — a project of its own).
   - A **Call layer** (`<dialog class="layer">`, full screen on a phone): Contact,
     Self, the call bar, Hang up — above Messages, so the conversation is one
     close away.
   - The incoming-call dialog as InPerson's.
   - **Missed calls in the Log** of that pal: *Missed call, 13:07*.
   - STUN/TURN and *Check* in Pals' **Settings** layer, not the welcome page.
6. **Session.** `checkSession()` in Pals must not leave for `Reg.html` during
   a call (InPerson's rule).
7. **Tests.** `tests/inPerson.test.js` carries over: the fakes for WebRTC,
   `/sub/` and the camera go into `tests/helpers/palsPage.js`, which then also
   needs `requestAnimationFrame` (see *Known failures*).
8. **Retire InPerson**, or keep it as a call-only face of Pals on the same
   origin; its `/inperson/` rows can then go.

What stays as it is in either: one device per user (the newest row wins), and
the ring arriving only as fast as the push service delivers.

---

## Things to know

1. **No ringtone, no CallKit.** A ring is a notification. On iOS (Home Screen
   app, 16.4 or later) the user taps it and InPerson opens on the call; the
   phone does not ring like a phone call. Push delivery takes from under a
   second to several, depending on the service and the device's sleep.
2. **One device per user**, as Pals: the newest `/inperson/` row wins.
3. **Anybody signed in can ring anybody listed**, as anybody can write to
   anybody in Pals (Pals' *Before it goes live*, item 4). A ring is shown
   with the caller's name and key tag.
4. **A `PUT` to `/sub/` needs a session cookie.** The page signs in again
   before a call; a cookie that expires *during* a call does not matter, as
   hanging up goes over the data channel.
5. **`/sub/` is one process's memory.** Northern runs one server
   (`Cluster.js`); with several behind a balancer, both ends of a call would
   have to reach the same one.
6. **The `/turn/api/ice` credentials are per request**, for any signed-in
   user, **at most `NORTHERN_TURN_RATE` a minute each** (default 6; a call
   asks once at each end). Past it Northern answers `429` with `Retry-After`,
   logs the key's head once a minute, and the page tries the call without
   TURN. The count is in the process's memory: Northern runs one. It limits
   how many credentials one user collects - each lasts
   `NORTHERN_TURN_TTL` - not the gigabytes a credential relays; Cloudflare's
   dashboard shows those.
7. **No reconnect.** When the line drops, WebRTC tries for a while
   (*reconnecting…*); a failed connection ends the call. ICE restarts would
   need the channel kept open for the whole call.
8. **The host.** `inperson.<domain>` needs a DNS record and a tunnel ingress
   rule, and the ID Card must be loaded once on that origin (welcome.html links
   to it). On any other host name the app also works, unguarded — as Pals does.

## Known failures (not this change)

The full suite has 1241 tests; 110 fail, all of them before this change too
(checked by running the same files without it): 98 in `bandage.test.js`, one
flaky in `grinder.test.js`, `Crypto.test.js`'s RSA branch (REFACTORING.md #8),
two in `browserIdentity.test.js` (Pals' `example/OpenChannel/msg.html`, and
`Reg.html` asking for `db.js?v=2`), and 7–9 in `pals.test.js`. Of those, the
ones from `requestAnimationFrame` are fixed with the port (`palsPage.js` stubs
it now); two regexes still break now and then, when a random test key has a
`+` in it.

## Live check, 2026-10-13

Two devices - N.P. on a Chromebook, Mr. No on Chrome - through the Cloudflare
tunnel on `inperson.<domain>`, with Northern on Cloudflare TURN
(`NORTHERN_TURN=cloudflare`, *TURN credentials from Northern*).

**Works:**
- setup on both devices: the ID Card's key, push, the `/inperson/` row;
- the ring: a real push, the *is calling* notification, Answer;
- `/sub/` through the tunnel: the signals set the call up;
- `/turn/api/ice` with a real Cloudflare key, and **a call through
  Cloudflare's relay** with *Only through TURN* (the active candidate pair in
  `chrome://webrtc-internals` was `relay`);
- **the same call directly** with *Only through TURN* cleared - TURN then is
  only the fallback, and costs nothing;
- the camera and both videos.

**Found, and fixed (version 2):** `call.js` kept `setTimeout` and
`clearTimeout` on a plain object and called them as its methods. Chrome throws
*Illegal invocation* for that, so a call stopped at *Calling bob…*: the
answer timer never started, the undo hit the same error, and the ring was never
pushed - with no message. The vm tests passed because their fake timers do not
care what `this` is. They are called through arrow functions now, and a test
with timers as strict as Chrome's fails on the old line.

## Not verified

Headless Chromium cannot load pages here (see memory), and the live check did
not cover:

- iOS (Home Screen app), Android, and a desktop browser other than Chrome;
- a ring with the app closed on a sleeping phone, and how long it takes;
- Decline, a ring left to run out (*no answer*, *Missed call*), and busy;
- a call between different networks - a phone on mobile data and a laptop at
  home - with and without TURN;
- `/sub/`'s 100 s idle reconnect through the tunnel during a long ring;
- coturn on the Pi with the example config, and `example/lightsail/*.sh` on a
  real Lightsail instance.

## Decisions that are yours

| | Decision | Recommended |
| --- | --- | --- |
| **I1** | InPerson on its own host (built), or under `pals.` | Its own host now; the Pals port makes it moot |
| **I2** | TURN: coturn at home, coturn on Lightsail, or Cloudflare | Cloudflare first — no server to keep, cents per relayed hour, and tried live. Lightsail when the TURN server should be your own: a flat $5, nothing opened at home. coturn at home only with a public address and no wish to hide it |
| **I3** | Port calls to Pals | Done - Pals version 16: pinned keys and fingerprints close InPerson's weak point |
| **I4** | Contacts: everybody listed (built, as the prompt asks), or pals only | Everybody now; pals only in Pals |
| **I5** | A rate limit on `/turn/api/ice` | Done: 6 per user per minute (`NORTHERN_TURN_RATE`) |
| **I6** | Retire InPerson now that Pals calls (port step 8) | Not yet: once calls in Pals have been tried on real devices |
