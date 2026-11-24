import assert from "node:assert/strict";
import test from "node:test";

import { buildTimeline } from "./index.js";

test("own goals count for the side FotMob credits", () => {
  const timeline = buildTimeline([{
    type: "Goal",
    time: 27,
    isHome: true,
    ownGoal: true,
    nameStr: "Own-goal scorer",
    newScore: [0, 1],
  }]);

  assert.deepEqual(timeline[0].score, [0, 1]);
  assert.equal(timeline[0].home, true);
  assert.equal(timeline[0].own, true);
});

test("goal and half-time scores use FotMob's authoritative score", () => {
  const timeline = buildTimeline([
    { type: "Goal", time: 27, isHome: true, newScore: [1, 0] },
    { type: "Goal", time: 40, isHome: false, newScore: [1, 1] },
    { type: "Goal", time: 57, isHome: true, newScore: [2, 1] },
    { type: "Half", time: 45, halfStrShort: "HT", homeScore: 1, awayScore: 1 },
  ]);

  assert.deepEqual(
    timeline.filter((event) => event.t === "gol").map((event) => event.score),
    [[1, 0], [1, 1], [2, 1]],
  );
  assert.deepEqual(timeline.find((event) => event.t === "devre").score, [1, 1]);
});

test("goal score fallback does not invert an own goal", () => {
  const timeline = buildTimeline([
    { type: "Goal", time: 27, isHome: true, ownGoal: true },
    { type: "Goal", time: 40, isHome: false },
  ]);

  assert.deepEqual(timeline.map((event) => event.score), [[1, 0], [1, 1]]);
});
