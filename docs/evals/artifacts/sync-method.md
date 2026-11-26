# Replaying the clock and playback experiment

Run these commands from the SameMoon checkout. Both simulations compile the two production controller modules directly from the named Git objects, using the same installed TypeScript compiler. The controller never reads the revision, fixture identity or reference error.

```sh
npm ci --prefix client
node docs/evals/artifacts/simulate.cjs 49f0fc7234558e71d67e5381c18b88c58e10ab93 > /tmp/samemoon-before.json
node docs/evals/artifacts/simulate.cjs c8308cd9865779b536e6901b45102c3756e8d8cc > /tmp/samemoon-after.json
cmp /tmp/samemoon-before.json docs/evals/artifacts/sync-before.json
cmp /tmp/samemoon-after.json docs/evals/artifacts/sync-after.json

sh docs/evals/artifacts/check-sync-tests.sh 49f0fc7 c8308cd
sh docs/evals/artifacts/check-sync-tests.sh c8308cd c8308cd
```

The first unit-test command deliberately returns exit status 1 on the old controller. Both unit-test runs use the test directory at `c8308cd`. The archived logs use `--reporter=verbose`. Node and TypeScript versions are part of the simulation JSON, so a different toolchain may change the bytes. Test runner wall times include local scheduling and are excluded from the performance claims.

## Setup

Two production SyncEngine instances communicate through a virtual-time message queue. Each instance owns a ClockSync and an in-memory playback adapter. The reference timeline uses the independent scheduler. The follower starts with a 375 ms wall-clock offset, gains 40 microseconds per second on its wall clock and gains 80 microseconds per second on its playback timeline at normal speed. The two directions use a phase-shifted repeating array of one-way delays in milliseconds: 18, 64, 26, 101, 35, 22, 47, 29. The scheduler uses a 5-second virtual heartbeat interval and breaks same-instant delivery ties by insertion order.

The peers exchange heartbeats while paused for a 20-second warmup. Both estimators must report ready before playback begins. At time zero the two adapters start with the fixture's rate and signed initial phase error. The controller immediately receives the first scheduled playing heartbeat after its network delay. The loss case drops outbound messages from 1 s inclusive to 25 s exclusive, while both media clocks keep running. The six fixtures are visible, purpose-built regression cases. They have no random training/test split or independent holdout.

## Reading a trace

Each case records one row per 100 ms, including time zero and 60 s. Columns are elapsed milliseconds, signed follower-minus-leader position error in milliseconds, and follower playback rate. Numerical output is rounded to three decimals.

- **Settling time** is the first sampled instant after the last excursion outside ±300 ms, provided at least 5 s of in-band samples remain through the horizon. A null result means the run did not satisfy this criterion. The measure includes the scheduled delay to the first usable playing heartbeat, and excludes initial wall-clock calibration.
- **Overshoot** is the largest sampled excursion onto the side opposite the starting error. A follower that begins 800 ms ahead has overshot when it falls behind. A zero overshoot can coexist with a residual error inside the deadband.
- **Follower seeks** count explicit seek calls on that adapter. The initial displacement is injected directly into the simulated media timeline. Hard seeks take effect immediately in this model.
- **Invalid exchange** feeds three samples where peer processing exceeds the entire local elapsed time. The JSON records readiness and resulting estimated offset.

The timer and media model do not decode frames, incur seek/buffer stalls, run browser autoplay rules, exercise RTC, or measure Internet latency. The repeated 1× and hard-seek control fixtures let a reader check whether a claimed improvement extends to already-working behavior. Sampling every 100 ms can miss short excursions between samples. The 60-second ceiling is a censoring boundary, so an unsettled baseline cannot be assigned a precise speedup.

## Post-freeze sensitivity check

The alternate inputs were committed at `40c53ea`, after the controller was frozen at `c8308cd` and before either revision was run against them. No controller changes followed from this check. Run the same two commands with a third argument to reproduce its traces.

```sh
node docs/evals/artifacts/simulate.cjs 49f0fc7 sensitivity > /tmp/samemoon-sensitivity-before.json
node docs/evals/artifacts/simulate.cjs c8308cd sensitivity > /tmp/samemoon-sensitivity-after.json
cmp /tmp/samemoon-sensitivity-before.json docs/evals/artifacts/sensitivity-before.json
cmp /tmp/samemoon-sensitivity-after.json docs/evals/artifacts/sensitivity-after.json
```

The fixed burst schedule sends leader-to-follower messages in 170–510 ms and replies in 9–42 ms. The follower clock starts 920 ms behind the leader, with −65 ppm wall-clock drift and −115 ppm media drift. All other sampling and acceptance rules match the original six fixtures. These cases are designer-selected after seeing the original experiment; they are a sensitivity check without a blind holdout.

| Fixture and initial error | Settling, baseline → candidate | Hard seeks | Signed final error, baseline → candidate |
| --- | --- | --- | --- |
| 0.5×, +1200 ms | Unsettled → 36.2 s | 11 → 0 | +2425.515 → +195.840 ms |
| 2×, −1450 ms | Unsettled → 51.9 s | 11 → 0 | −5074.485 → −149.489 ms |
| 1.25×, −1750 ms, 43.1 s send blackout | Both unsettled | 2 → 0 | −1326.638 → −207.991 ms |
| 1×, −340 ms | Both unsettled | 0 → 0 | −346.900 → −346.900 ms |

In the blackout the candidate only enters the band at 58.6 s, leaving 1.4 s of observations. At the band edge neither revision ever reaches ±300 ms of ground truth. The midpoint clock estimator assumes comparable one-way delays. With persistent directional asymmetry its offset can be biased enough to place a real error inside the controller's estimated deadband. Every sensitivity pair has zero overshoot, including the unsettled cases. Overshoot alone does not establish convergence.
