import test from "node:test";
import assert from "node:assert/strict";
import {
  enrich,
  matches,
  relatedPosts,
  weeklyPicks,
  cardHtml,
  sourcesOf,
} from "../../assets/reader-core.js";
import { decodeState, beginVisit } from "../../assets/reader-state.js";
import { collectSources, articleMetadata } from "./article-metadata.mjs";
const make = (id, extra = {}) =>
  enrich({
    id,
    title: "Claude Code の開発ツール",
    category: "Anthropic",
    channel: "Claude",
    date: "2026-09-05T00:00:00Z",
    ...extra,
  });
test("search combines normalized terms, facets, month and local views", () => {
  const p = make("12345");
  assert.ok(
    matches(p, {
      q: "ＣＬＡＵＤＥ 開発",
      company: "Anthropic",
      model: "Claude Code",
      month: "2026-09",
      topic: "開発ツール",
    }),
  );
  assert.ok(!matches(p, { q: "Gemini" }));
  assert.ok(!matches(p, { company: "Google" }));
  assert.ok(!matches(p, { view: "saved" }));
  assert.ok(matches(p, { view: "saved" }, { saved: { 12345: 1 } }));
  assert.ok(!matches(p, { view: "unread" }, { read: { 12345: 1 } }));
  assert.ok(!matches(p, { view: "history" }));
  assert.ok(matches(p, { view: "history" }, { read: { 12345: 1 } }));
  assert.ok(!matches(p, { view: "new" }));
  assert.ok(
    matches(p, { view: "new" }, { previousVisit: Date.parse("2026-09-04") }),
  );
});
test("all safe sources are deduplicated; Markdown punctuation is removed", () => {
  const msg = {
    embeds: [{ url: "https://example.com/a" }],
    content:
      "[A](https://example.com/a) [B](https://example.org/wiki/A_(B))\nhttps://third.example/path。 https://discord.com/channels/1/2",
  };
  assert.deepEqual(collectSources(msg), [
    "https://example.com/a",
    "https://example.org/wiki/A_(B)",
    "https://third.example/path",
  ]);
  assert.deepEqual(
    sourcesOf({
      source_url: "javascript:bad",
      source_urls: [
        "https://example.com/a",
        "https://u:p@example.com/a",
        "https://example.com/a",
      ],
    }),
    ["https://example.com/a"],
  );
});
test("metadata extracts source text and separates cautions without inventing facts", () => {
  const meta = articleMetadata({
    content:
      "Intro\n## 変更点\n速くなった。\n## 対象ユーザー\n開発者。\n## 留意点\nプレビュー。\n## 参考文献\nhttps://example.org/",
    edited_timestamp: "2026-09-05T12:00:00Z",
  });
  assert.deepEqual(meta.summary_sections, [
    { heading: "変更点", text: "速くなった。" },
  ]);
  assert.equal(meta.caution, "プレビュー。");
  assert.equal(meta.audience, "開発者。");
  assert.equal(meta.updated_at, "2026-09-05T12:00:00Z");
  assert.deepEqual(articleMetadata({}).summary_sections, []);
});
test("related articles exclude current and prioritize overlapping models", () => {
  const p = make("12345"),
    a = make("12346"),
    b = make("12347", { title: "Claude model", channel: "Claude" }),
    c = make("12348", { title: "Cooking", category: "Food", channel: "Food" });
  assert.deepEqual(
    relatedPosts(p, [p, b, c, a]).map((x) => x.id),
    ["12346", "12347"],
  );
});
test("weekly picks are deterministic and exclude old and leaked news", () => {
  const list = [
    make("12345"),
    make("12346", { category: "リーク" }),
    make("12347", { date: "2026-08-01T00:00:00Z" }),
    make("12348", { category: "Google", channel: "Gemini" }),
  ];
  assert.deepEqual(
    weeklyPicks(list).posts.map((p) => p.id),
    ["12345", "12348"],
  );
  assert.equal(weeklyPicks(list).start, "2026-08-30");
  assert.equal(weeklyPicks(list).end, "2026-09-05");
});
test("hostile titles, image paths and IDs cannot inject HTML", () => {
  const html = cardHtml(
    make("12345", {
      title: "<img src=x onerror=alert(1)>",
      cover: "../bad.svg",
    }),
  );
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes('src="../bad'));
  assert.equal(cardHtml(make('12345" onclick="bad')), "");
});
test("local state handles invalid JSON, invalid IDs, and a fixed previous visit per session", () => {
  assert.deepEqual(decodeState("{"), { saved: {}, read: {}, lastVisit: 0 });
  const state = decodeState(
    '{"saved":{"12345":123,"__proto__":55,"oops":9},"lastVisit":100}',
  );
  assert.deepEqual(state.saved, { 12345: 123 });
  const first = beginVisit(state, null, 200);
  assert.equal(first.previousVisit, 100);
  assert.equal(
    beginVisit({ ...state, lastVisit: 200 }, first, 300).previousVisit,
    100,
  );
  assert.equal(
    beginVisit({ ...state, lastVisit: 300 }, first, 2000000).previousVisit,
    300,
  );
});
test("metadata preserves mathematical operators and code identifiers",()=>{const m=articleMetadata({content:"## 数学\nn>2、a*b、x_y、**強調**。\n**参考文献**\nhttps://example.org/"});assert.equal(m.summary_sections[0].text,"n>2、a*b、x_y、強調。");assert.equal(m.source_urls.length,1);});
