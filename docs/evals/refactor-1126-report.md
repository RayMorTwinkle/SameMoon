# SameMoon · Playback recovery and room signaling

**2026-11-26.** Baseline `backup1126` at `49f0fc7`. The evaluated controller on `refactor/1126` is `c8308cd`; the final evaluated room manager is `a1019ed`. Each trace also records the SHA-256 of the actual source. The baseline was read through Git objects and isolated archives. The release branch and production deployment have separate entry points.

In the six primary simulations, the old follower settled in four cases and the new follower in all six. At 1.5×, the old controller sought ten times in a minute. The new one made no hard seeks and settled in 6.8 simulated seconds. A separate stress set with strong directional delay asymmetry settled in **two of four** after the change. [Primary inputs and method](artifacts/sync-method.md) · [Baseline traces](artifacts/sync-before.json) · [Candidate traces](artifacts/sync-after.json)

## Results

“Settled” means the independent playback heads stay within ±300 ms from that sample through 60 s, with at least 5 s of observations remaining. Samples are 100 ms apart. “Overshoot” is the maximum excursion to the other side of the initial error. An unsettled case is censored at the observation horizon. No numeric time is assigned to it.

| Primary fixture · follower's initial error | Settle before → after (s) | Overshoot before → after (ms) | Hard seeks before → after |
| --- | ---: | ---: | ---: |
| 1×, −700 ms | 8.1 → 8.1 | 0 → 0 | 0 → 0 |
| 1.5×, +800 ms | unsettled → 6.8 | 4175.148 → 0 | 10 → 0 |
| 0.75×, −650 ms | unsettled → 9.4 | 2838.879 → 0 | 5 → 0 |
| 1×, −400 ms, eight messages withheld | 36.1 → 2.1 | 849.750 → 8.527 | 0 → 0 |
| 1×, −3200 ms | 0.1 → 0.1 | 8.497 → 8.497 | 1 → 1 |
| 1×, +90 ms | 0 → 0 | 0 → 0 | 0 → 0 |

Both engines had already calibrated while paused for 20 s. The loss fixture permits the first playing heartbeat, then suppresses sends in the interval [1 s, 25 s). The follower can enter the band during the interruption. This experiment measures recovery from an initial playback displacement. It does not clock cold start, transport reconnection or the time to acknowledge a viewer's new command. [Simulation source](artifacts/simulate.cjs)

### A counterexample after freezing the controller

A second profile runs the same committed implementations with a different clock bias, different media drift and burst delays of 170–510 ms outward and 9–42 ms on the return path. The six primary cases and these four cases have different inputs and are reported separately.

| Stress fixture | Settle before → after (s) | Hard seeks before → after |
| --- | ---: | ---: |
| 0.5× ahead, +1200 ms | unsettled → 36.2 | 11 → 0 |
| 2× behind, −1450 ms | unsettled → 51.9 | 11 → 0 |
| 1.25× behind, −1750 ms, 43.1 s blackout | unsettled → unsettled | 2 → 0 |
| 1× near threshold, −340 ms | unsettled → unsettled | 0 → 0 |

The blackout candidate first stayed in band at 58.6 s, leaving only 1.4 s of evidence. In the near-threshold case, the final signed error was −346.900 ms in both revisions. A midpoint clock estimate can be biased by sustained one-way queuing. All four stress fixtures had zero overshoot in both revisions. The unsettled results show why that metric alone is insufficient. [Baseline](artifacts/sensitivity-before.json) · [Candidate](artifacts/sensitivity-after.json)

## Bad cases and attribution

| Observable failure | Cause in the old implementation | Change and observed behavior |
| --- | --- | --- |
| Repeated seeks at 1.5× and 0.75× | The follower chased at absolute 0.95×/1.05× and restored 1×. Packet-age projection also used the receiver's instantaneous rate. | Preserve the selected rate, project using the sender's rate, and apply a temporary ±5% correction relative to the selection. Both cases settle without a hard seek. |
| Error changes sign during a heartbeat gap | The temporary speed remained active until another observation arrived. | Arm a local timer for the smaller of the predicted intersection time and two heartbeat periods. A user speed change supersedes the timer. Overshoot in the primary gap fell from 849.750 to 8.527 ms. |
| Three physically impossible exchanges produce a calibrated clock | Peer processing exceeded the local round trip. The old low-RTT sort preferred the negative RTT samples. | Reject nonfinite times, reversed intervals and negative RTT before adding them. The same three inputs changed from ready with +590 ms offset to unready with 0 ms offset. Valid samples still calibrate the clock. |
| Restored local room says playing with a missing file | The session handler clears the reloading viewer's file handle; room recovery checked online sockets only. | Derive local-sync readiness from both online members and matching name/size. A returning client receives selecting, reselects the file and matches again in a real loopback WebSocket exchange. |
| An online viewer remains in reconnecting after peer expiry | Removing one member updated the room state only when the room became empty. | Derive waiting/reconnecting from the remaining member. Five paired room-state assertions changed from 2/5 to 5/5, including unchanged controls for matched files and the arrival of a replacement guest. |

The service adds a standalone local static-serving entry point around the same Fastify application. The production entry, WebSocket envelope, TURN route, environment names and ServerX deployment layout retain their existing interfaces. Reconnect timers continue working while the process serves clients and release their process-liveness reference during shutdown. [Room harness](artifacts/room-recovery.mjs) · [Before](artifacts/room-before.json) · [After](artifacts/room-after.json) · [Wire-level regression](../../server/test/local-reload.test.mjs)

## For Product Managers

A viewer who pauses for a conversation expects the timeline to stay put. A viewer who chooses 1.5× expects it to remain their speed after a correction. The product trade-off is between a small, briefly audible speed adjustment and a visible seek which may require decoding and buffering again. The retained deadband avoids needless adjustments. The large-error control still gets one immediate seek; the ordinary 1× recovery time is unchanged.

Hard-seek count and time spent outside tolerance are proxies for interruption. We did not measure abandonment, audio perception, satisfaction or live-user latency. In the actual room UI, a guest can paste full-width digits and press Enter, both participants can match a local file, and their play, pause and speed changes cross the signaling channel. Reloading explicitly requests the missing file. [Browser check](artifacts/browser-playback-after.txt) · [Room lifecycle fixtures](artifacts/room-after.json)

## For AI / Agent Developers

The split between observation, decision and effect matters here even though the product runs a deterministic controller. ClockSync owns observations and maintains a cached offset. SyncEngine owns command ordering, temporary rate and its deadline. PlaybackAdapter effects and the transport sit at the boundaries. Deriving deadlines from an injected clock makes packet loss and timer cancellation testable without sleeping. The room manager separately distinguishes membership, connectivity and media readiness. A new static host uses the existing room app so the local Docker image exercises the deployed signaling behavior.

The new loop adds no inference calls, remote dependencies or higher heartbeat frequency. Reusing the cached estimate avoids re-sorting samples on every read; CPU, server load and hosting cost were not benchmarked. Guardrails include rejecting invalid clock exchanges, ignoring stale lower-sequence snapshots, cancelling superseded timers, and preventing a programmatic change from becoming a new viewer command. Shutdown, duplicate start and manual override have direct test cases. There is no evidence here for an LLM cost or throughput claim. [Controller](../../client/src/services/sync/SyncEngine.ts) · [Behavior tests](../../client/test/DriftControl.test.ts)

## For Post-Training / Evaluation Engineers

The fixture taxonomy separates selected speed and error sign, missing observations, one large displacement, an in-band control, impossible clock observations and signaling lifecycle. Each side runs the production classes loaded from its Git object. Both sides use the same transpiler, input fixtures and independent scheduler. The primary follower starts with +375 ms of clock offset, +40 ppm of wall-clock drift and +80 ppm of media drift. The source-only comparison fixes a repeating directional jitter schedule. Evaluating against the scheduler's ground truth avoids grading a controller by its own offset estimate.

The core fixtures were visible during development. The second fixture set was committed after the controller freeze and before running that set. It is an author-designed sensitivity test, not a blind sample from Internet traffic. Repeatability here does not imply external validity. Traces contain the signed residual and follower speed at each sample, enabling checks for sign reversals, a long uncertified tail and controllers that never correct. No significance test or aggregate fleet percentile is justified. Instantaneous simulated seek, synchronous adapter events, 100 ms sampling and an already-warm clock all constrain interpretation. Neither cold calibration, background browser throttling, real decoder stalls, NAT traversal nor paid TURN availability is measured. [Sensitivity setup and replay commands](artifacts/sync-method.md)

## Reproduce and verify

Use Node 24 and install the checked-in dependencies in their actual project directories. The archived host runs used Node v24.15.0. Build, suite and lint text logs omit trailing whitespace. The JSON files preserve the raw simulator output. For both controller revisions, follow the commands in the linked method. The following independently replays the room fixtures while leaving branch references unchanged.

```sh
before=$(mktemp -d)
after=$(mktemp -d)
git archive 49f0fc7 server/src | tar -x -C "$before"
git archive a1019ed server/src | tar -x -C "$after"
node docs/evals/artifacts/room-recovery.mjs "$before" > "$before/room.json"
node docs/evals/artifacts/room-recovery.mjs "$after" > "$after/room.json"
cmp "$before/room.json" docs/evals/artifacts/room-before.json
cmp "$after/room.json" docs/evals/artifacts/room-after.json
```

| Check | Baseline | Candidate |
| --- | --- | --- |
| Same 13 client fixtures on both controllers | 8 passed, 5 failed | 13 passed. [Before](artifacts/paired-tests-before.txt) · [After](artifacts/paired-tests-after.txt) |
| Suites as shipped, clean locked dependencies | Client 5/8. Server default 1/1, plus 34/34 TypeScript tests when invoked separately | Client 13/13. Server default runs both Node tests and all 34 TypeScript cases, 36/36 passed. [Client before](artifacts/client-tests-before.txt) · [Client after](artifacts/client-tests-after.txt) · [Server before](artifacts/server-tests-before.txt) · [Server after](artifacts/server-tests-after.txt) |
| Client production build | Passed | Passed; both builds emit a large-chunk advisory. [Before](artifacts/client-build-before.txt) · [After](artifacts/client-build-after.txt) |
| Full client ESLint | 25 errors, 1 warning | 24 errors, 1 warning. Changed client source and tests pass targeted lint. Existing findings remain in transfer/RTC, room UI, hooks and notification code. [Before](artifacts/lint-before.txt) · [After](artifacts/lint-after.txt) · [Changed files](artifacts/lint-touched-after.txt) |
| Fresh tree, no node_modules, `npm run dev` | Failed to find concurrently | Installs pinned dependencies, serves the browser and opens a room through Vite. Ports 3000/3001 were occupied during this check, so Vite selected 3002. [Before](artifacts/dev-start-before.txt) · [Startup excerpt](artifacts/dev-start-after-excerpt.txt) · [Loopback smoke](artifacts/dev-smoke-after.txt) |

Three assertions in the original client suite depended on incorrect test setups (synchronous delivery for simultaneous commands, and targeting the leader for follower-only correction). The historical suites have different denominators; only the 13 common fixtures in the first row form a paired unit comparison.

For Docker, run `docker compose -f compose.local.yml up --build` and then `node docs/evals/artifacts/local-smoke.mjs http://127.0.0.1:3000`. The validation used host port 19360 and container port 3000, serving the SPA, both room deep links, health, WebSocket hello/pong and room creation. Two Chromium tabs then selected the same generated WebM, entered the player, completed the ready handshake, and propagated play, pause and custom rate over loopback. The two-tab check is a functional check with a real decoder; it supplies no WAN drift statistic. [Smoke script](artifacts/local-smoke.mjs) · [Container result](artifacts/container-smoke-after.txt) · [Browser state](artifacts/browser-playback-after.txt)

## SKIPPED_BLACKBOX

| Preserved surface | Reason |
| --- | --- |
| `nginx.conf`, `docker-compose.yml`, `client/vite.config.ts`, `deploy.sh`, `docs/更新服务器SameMoon.sh`, `server/test-remote.sh` | Proxy, TLS, remote deployment and remote checks. The new local image serves a single origin on its own port. |
| `server/.env.example`, `server/src/app.ts`, `server/src/index.ts`, `server/src/ws/protocol.ts` | Existing credential handling, TURN provider integration, production routes and wire contracts. Room state changes were made inside RoomManager; existing TURN and relay call sites were preserved. |
| `client/src/services/webrtc/`, `client/src/services/playback/`, `client/src/hooks/useWebSocket.tsx`, `client/src/components/Player/PlayerPage.tsx`, `client/src/components/Room/{RoomPage,FileTransferPanel}.tsx` | Existing P2P negotiation, file transport, screen capture, platform media adaptation and session integration. The normal file-selection UI and playback adapter were exercised through their existing entry points. |
| `ServerX/same-moon/` | Read-only deployment context for port mapping, runtime paths and variable names. Validation ran on loopback. Production traffic and credentialed relays were outside this run. |

The repository has no project-level LICENSE. The locked UI dependency declares CC-BY-NC-4.0. No licensing decision was made on the author's behalf. Publishing GitHub Pages from `/docs` and integrating the separate RayHome case into its shared build entries belong to release orchestration.
