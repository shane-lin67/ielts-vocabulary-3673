import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const baseUrl = process.env.SYNC_TEST_URL || "http://127.0.0.1:8788/api/v1/sync-progress";
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const syncCode = Array.from(randomBytes(16), byte => alphabet[byte % alphabet.length]).join("");

async function put(body, code = syncCode) {
  const response = await fetch(baseUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${code}`,
      "Content-Type": "application/json",
      Origin: "null",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  return { response, result };
}

const invalid = await put({ progress: {}, view: null, resetAt: 0 }, "bad-code");
assert.equal(invalid.response.status, 401);

const deviceA = await put({
  progress: {
    1: { dots: 2, seenCount: 2, knownStreak: 0, lastResult: "unknown", updatedAt: 1000 },
  },
  view: {
    selectedChapter: "1",
    filterMode: "ALL",
    testDirection: "EN_TO_CN",
    autoSpeak: true,
    currentWordId: 10,
    updatedAt: 1000,
  },
  resetAt: 0,
});
assert.equal(deviceA.response.status, 200);
assert.equal(deviceA.response.headers.get("access-control-allow-origin"), "null");
assert.equal(deviceA.result.data.progress[1].dots, 2);

const deviceB = await put({
  progress: {
    2: { dots: 0, seenCount: 1, knownStreak: 1, lastResult: "known", updatedAt: 2000 },
  },
  view: {
    selectedChapter: "2",
    filterMode: "HARD",
    testDirection: "CN_TO_EN",
    autoSpeak: false,
    currentWordId: 200,
    updatedAt: 2000,
  },
  resetAt: 0,
});
assert.equal(deviceB.response.status, 200);
assert.deepEqual(Object.keys(deviceB.result.data.progress), ["1", "2"]);
assert.equal(deviceB.result.data.view.currentWordId, 200);

const equalTimestampOldView = await put({
  progress: {},
  view: {
    selectedChapter: "1",
    filterMode: "ALL",
    testDirection: "EN_TO_CN",
    autoSpeak: true,
    currentWordId: 1,
    updatedAt: 2000,
  },
  resetAt: 0,
});
assert.equal(equalTimestampOldView.result.data.view.currentWordId, 200);

const staleDeviceA = await put({
  progress: {
    1: { dots: 1, seenCount: 1, knownStreak: 1, lastResult: "known", updatedAt: 500 },
  },
  view: null,
  resetAt: 0,
});
assert.equal(staleDeviceA.result.data.progress[1].dots, 2);
assert.equal(staleDeviceA.result.data.progress[1].lastResult, "unknown");

const reset = await put({ progress: {}, view: null, resetAt: 4000 });
assert.deepEqual(reset.result.data.progress, {});

const staleAfterReset = await put({
  progress: {
    1: { dots: 9, seenCount: 9, knownStreak: 0, lastResult: "unknown", updatedAt: 3500 },
  },
  view: null,
  resetAt: 0,
});
assert.deepEqual(staleAfterReset.result.data.progress, {});

const newAfterReset = await put({
  progress: {
    1: { dots: 1, seenCount: 1, knownStreak: 0, lastResult: "unknown", updatedAt: 5000 },
  },
  view: null,
  resetAt: 4000,
});
assert.equal(newAfterReset.result.data.progress[1].dots, 1);

const idempotent = await put({
  progress: newAfterReset.result.data.progress,
  view: newAfterReset.result.data.view,
  resetAt: newAfterReset.result.data.resetAt,
});
assert.equal(idempotent.result.data.revision, newAfterReset.result.data.revision);

process.stdout.write(JSON.stringify({
  ok: true,
  revision: newAfterReset.result.data.revision,
  syncedWordIds: Object.keys(newAfterReset.result.data.progress),
  resetAt: newAfterReset.result.data.resetAt,
}, null, 2));
