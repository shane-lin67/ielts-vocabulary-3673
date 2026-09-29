import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const flashcardsUrl = new URL("../public/flashcards.html", import.meta.url);

test("cloud-applied navigation stays silent while local navigation can auto-speak", async () => {
  const html = await readFile(flashcardsUrl, "utf8");

  assert.match(html, /const navigationSourceRef = useRef\("initial"\)/);
  assert.match(html, /navigationSourceRef\.current = "remote";[\s\S]*?setWords\(/);
  assert.match(
    html,
    /if \(navigationSourceRef\.current === "remote"\) \{[\s\S]*?return;[\s\S]*?document\.visibilityState !== "visible" \|\| !document\.hasFocus\(\)/,
  );
  assert.match(html, /if \(currentCard && currentCard\.id === activeWordId\)/);
  assert.doesNotMatch(html, /if \(!currentCard \|\| currentCard\.id === activeWordId\)/);
  assert.match(html, /const advanceToNext = \(\) => \{\s*navigationSourceRef\.current = "local";/);
});
