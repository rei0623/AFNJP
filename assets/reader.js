import { cardHtml, matches } from "./reader-core.js";
import { STORAGE_KEY, decodeState, beginVisit } from "./reader-state.js";
const data = JSON.parse(
  document.getElementById("reader-data")?.textContent || '{"posts":[]}',
);
const posts = data.posts || [],
  form = document.getElementById("reader-filters"),
  results = document.getElementById("archive-results");
const status = document.getElementById("reader-status");
let timer;
const say = (text) => {
  if (status) {
    status.textContent = text;
    clearTimeout(timer);
    timer = setTimeout(() => {
      status.textContent = "";
    }, 4500);
  }
};
let state = decodeState(null),
  available = true;
try {
  state = decodeState(localStorage.getItem(STORAGE_KEY));
} catch {
  available = false;
}
let session;
try {
  session = JSON.parse(sessionStorage.getItem("afnjp-reader-session"));
} catch {}
const visit = beginVisit(state, session);
state.previousVisit = visit.previousVisit;
state.lastVisit = Date.now();
try {
  sessionStorage.setItem("afnjp-reader-session", JSON.stringify(visit));
} catch {}
function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        saved: state.saved,
        read: state.read,
        lastVisit: state.lastVisit,
      }),
    );
    return true;
  } catch {
    available = false;
    say(
      "保存領域を利用できません。このページを閉じると保存・履歴は失われます。",
    );
    return false;
  }
}
const current = document.body.dataset.articleId;
if (current) state.read[current] = Date.now();
persist();
function paint() {
  document.querySelectorAll("[data-save-id]").forEach((button) => {
    const on = Boolean(state.saved[button.dataset.saveId]);
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "保存済み ✓" : "あとで読む ＋";
  });
  document.querySelectorAll("[data-read-id]").forEach((el) => {
    el.textContent = state.read[el.dataset.readId] ? "閲覧済み" : "";
  });
}
const keys = ["q", "company", "model", "topic", "month", "view"];
function fromUrl() {
  if (!form) return;
  const params = new URLSearchParams(location.search);
  for (const key of keys) {
    const el = form.elements.namedItem(key);
    el.value = params.get(key) || "";
    if (el.tagName === "SELECT" && el.selectedIndex < 0) el.value = "";
  }
}
function render() {
  if (!form || !results) return;
  const filters = Object.fromEntries(
    keys.map((key) => [key, form.elements.namedItem(key).value]),
  );
  let found = posts.filter((p) => matches(p, filters, state));
  if (filters.view === "history")
    found.sort((a, b) => state.read[b.id] - state.read[a.id]);
  results.innerHTML = found.map((p) => cardHtml(p, { state })).join("");
  document.getElementById("result-count").textContent =
    `${found.length} / ${posts.length}件`;
  document.getElementById("empty-results").hidden = found.length > 0;
  document.getElementById("visit-note").textContent = !available
    ? "保存・履歴はこのページを開いている間だけ利用できます。"
    : filters.view === "new"
      ? state.previousVisit
        ? `前回の訪問（${new Date(state.previousVisit).toLocaleString("ja-JP")}）以降に追加された記事です。`
        : "初めての訪問です。次回から、このブラウザで前回以降の新着を確認できます。"
      : "";
}
function urlFromForm() {
  const url = new URL(location.href);
  for (const key of keys) {
    const value = form.elements.namedItem(key).value;
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, "", url);
  render();
}
if (form) {
  form.hidden = false;
  fromUrl();
  render();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    urlFromForm();
  });
  let debounce;
  form.addEventListener("input", (e) => {
    clearTimeout(debounce);
    if (e.target.name === "q") debounce = setTimeout(urlFromForm, 150);
    else urlFromForm();
  });
  form.addEventListener("change", () => {
    clearTimeout(debounce);
    urlFromForm();
  });
  form.addEventListener("reset", () => {
    clearTimeout(debounce);
    setTimeout(urlFromForm, 0);
  });
  addEventListener("popstate", () => {
    fromUrl();
    render();
  });
}
document.addEventListener("click", async (e) => {
  const save = e.target.closest("button[data-save-id]");
  if (save) {
    const id = save.dataset.saveId;
    if (state.saved[id]) delete state.saved[id];
    else state.saved[id] = Date.now();
    const ok = persist();
    paint();
    if (form && form.elements.view.value === "saved") {
      render();
      form.elements.view.focus();
    }
    if (ok)
      say(
        state.saved[id] ? "あとで読むに保存しました。" : "保存を解除しました。",
      );
    return;
  }
  if (e.target.closest("[data-copy],[data-share]")) {
    const url =
      document.querySelector("link[rel=canonical]")?.href || location.href;
    try {
      if (e.target.closest("[data-share]") && navigator.share)
        await navigator.share({ title: document.title, url });
      else {
        await navigator.clipboard.writeText(url);
        say("記事のリンクをコピーしました。");
      }
    } catch (err) {
      if (err.name !== "AbortError")
        say(
          "リンクをコピーできませんでした。アドレスバーからコピーしてください。",
        );
    }
  }
});
addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY) return;
  const fresh = decodeState(e.newValue);
  state.saved = fresh.saved;
  state.read = fresh.read;
  paint();
  render();
});
addEventListener("pageshow", (e) => {
  if (e.persisted) {
    try {
      const fresh = decodeState(localStorage.getItem(STORAGE_KEY));
      state.saved = fresh.saved;
      state.read = fresh.read;
    } catch {}
    paint();
    render();
  }
});
document.getElementById("chFind")?.addEventListener("input", (e) => {
  const q = e.target.value.toLocaleLowerCase();
  document.querySelectorAll(".group").forEach((group) => {
    let count = 0;
    group.querySelectorAll(".ch").forEach((ch) => {
      ch.hidden = !ch.textContent.toLocaleLowerCase().includes(q);
      if (!ch.hidden) count++;
    });
    group.hidden = !count;
  });
});
document.documentElement.classList.add("reader-ready");
paint();
