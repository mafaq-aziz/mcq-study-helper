"use strict";

let tabId = null;
let questions = [];
let answers = {};
let config = {};
let contentAlive = false;
let pageUrl = "";
let busy = false;

const $ = (id) => document.getElementById(id);

async function init() {
  $("autoSolve").addEventListener("change", onAutoToggle);
  $("outlineOn").addEventListener("change", onOutlineToggle);
  $("soloMode").addEventListener("change", onSoloToggle);
  $("autoSubmit").addEventListener("change", async () => {
    await chrome.storage.local.set({
      autoSubmitOnComplete: $("autoSubmit").checked,
    });
  });
  $("solve").addEventListener("click", () => solve(false));
  $("refresh").addEventListener("click", () => refresh(true));
  $("clear").addEventListener("click", clearAnswers);
  $("density").addEventListener("input", () => applyDensity(Number($("density").value)));
  $("density").addEventListener("change", () => {
    chrome.storage.local.set({ panelDensity: Number($("density").value) });
  });
  chrome.storage.session.onChanged.addListener(onSessionChange);
  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(() => refresh(false));
    chrome.tabs.onUpdated.addListener((tabId2, info) => {
      if (info.status === "complete") refresh(false);
    });
  }
  const stored = await chrome.storage.local.get("panelDensity");
  const fs = Number(stored.panelDensity);
  applyDensity(Number.isFinite(fs) && fs >= 2 && fs <= 13 ? fs : 12);
  try {
    const s = await chrome.storage.local.get({
      soloMode: true,
      autoSubmitOnComplete: true,
    });
    $("soloMode").checked = s.soloMode !== false;
    $("autoSubmit").checked = s.autoSubmitOnComplete !== false;
  } catch (e) {}
  await refresh(false);
  setInterval(() => refresh(false), 2000);
}

function applyDensity(fs) {
  document.body.style.setProperty("--fs", fs + "px");
  document.body.classList.toggle("min-fs", fs <= 8);
  $("density").value = fs;
  $("densityVal").textContent = fs + "px";
}

async function resolveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const newId = tab && tab.id != null ? tab.id : null;
    if (newId !== tabId) {
      tabId = newId;
      questions = [];
      answers = {};
      config = {};
    }
  } catch (e) {}
  return tabId;
}

function onSessionChange(changes, area) {
  if (area !== "session" || tabId == null) return;
  const qKey = `q_${tabId}`;
  const aKey = `a_${tabId}`;
  let changed = false;
  if (changes[qKey]) {
    questions = (changes[qKey].newValue) || [];
    changed = true;
  }
  if (changes[aKey]) {
    answers = (changes[aKey].newValue) || {};
    changed = true;
  }
  if (changed) render();
}

async function refresh(showStatus) {
  await resolveTab();
  if (tabId == null) return;
  if (showStatus) setStatus("Scanning…");
  const res = await chrome.runtime.sendMessage({ type: "GET_STATE", tabId });
  if (!res) return;
  questions = res.questions || [];
  answers = res.answers || {};
  config = res.config || {};
  contentAlive = Boolean(res.contentAlive);
  pageUrl = res.url || "";
  $("autoSolve").checked = Boolean(config.autoSolve);
  $("outlineOn").checked = config.outlineOn !== false;
  if (showStatus) {
    if (!contentAlive) setStatus("Content script not active", "err");
    else if (questions.length) setStatus("Page scanned", "ok");
    else setStatus("Scanned — no MCQs found", "err");
  }
  render();
}

async function solve(force) {
  if (tabId == null || busy) return;
  if (!config.hasKey) {
    setStatus("Set your API key in options", "err");
    $("footer").innerHTML = '<a href="#" id="openOpts">Open options</a>';
    $("openOpts").addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  busy = true;
  $("solve").disabled = true;
  setStatus("Solving…");
  const res = await chrome.runtime.sendMessage({ type: "SOLVE", tabId, force });
  busy = false;
  $("solve").disabled = false;
  if (!res || !res.ok) {
    setStatus((res && res.error) || "Solve failed", "err");
  } else {
    setStatus(`Solved ${res.solved}/${res.total}`, "ok");
  }
  await refresh(false);
}

async function clearAnswers() {
  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_ANSWERS", tabId });
  await refresh(false);
  setStatus("Answers cleared");
}

async function onAutoToggle() {
  const val = $("autoSolve").checked;
  await chrome.storage.local.set({ autoSolve: val });
  config.autoSolve = val;
}

async function onOutlineToggle() {
  const val = $("outlineOn").checked;
  config.outlineOn = val;
  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: "SET_OUTLINES", tabId, on: val });
}

async function onSoloToggle() {
  const val = $("soloMode").checked;
  await chrome.storage.local.set({ soloMode: val });
}

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text || "";
  el.className = cls || "";
}

function isMulti(v) {
  return Array.isArray(v);
}

function indicesOf(v) {
  return isMulti(v) ? v.map(Number) : [Number(v)];
}

function diagHint() {
  if (contentAlive) return "";
  if (pageUrl.startsWith("file://")) {
    return "Local file: enable “Allow access to file URLs” on the extension's details page, then reload this tab.";
  }
  if (/^(chrome|edge|https:\/\/chromewebstore)/i.test(pageUrl)) {
    return "This browser page can't be scanned. Open a normal web page.";
  }
  return "Reload the page (content scripts don't survive extension reloads).";
}

function render() {
  const list = $("list");
  const solvedCount = questions.filter((q) => answers[q.hash] && !answers[q.hash].error).length;
  $("counts").textContent = `${questions.length} question${questions.length === 1 ? "" : "s"} · ${solvedCount} solved`;

  const hint = diagHint();
  $("footer").innerHTML = "";
  if (hint) {
    const div = document.createElement("div");
    div.textContent = hint;
    div.style.color = "var(--err)";
    div.style.fontSize = "12px";
    $("footer").appendChild(div);
  }
  if (config.model) {
    const m = document.createElement("div");
    m.textContent = `solving with ${config.model} (${config.provider})`;
    m.style.color = "var(--muted)";
    m.style.fontSize = "11px";
    m.style.marginTop = "4px";
    $("footer").appendChild(m);
  }

  if (!questions.length) {
    list.innerHTML = '<div class="empty">' +
      (hint
        ? "Detector not loaded on this tab."
        : "No MCQs detected on this page yet.<br />Open a quiz page, then hit ↻.") +
      "</div>";
    return;
  }

  list.innerHTML = "";
  for (const q of questions) {
    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "q-head";
    head.innerHTML = `<span class="q-num">${q.index}.</span><span class="q-text"></span>`;
    head.querySelector(".q-text").textContent = q.text;
    if (q.type === "checkbox") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "multi";
      head.appendChild(badge);
    }
    card.appendChild(head);

    const a = answers[q.hash];
    const ul = document.createElement("ul");
    ul.className = "opts";
    const correctSet = new Set(a && !a.error ? indicesOf(a.answerIndex) : []);
    q.options.forEach((o) => {
      const li = document.createElement("li");
      if (correctSet.has(o.index)) li.classList.add("correct");
      li.innerHTML = `<span class="mark">${correctSet.has(o.index) ? "✓" : "·"}</span><span class="otext"></span>`;
      li.querySelector(".otext").textContent = `${String.fromCharCode(65 + o.index)}. ${o.text}`;
      ul.appendChild(li);
    });
    card.appendChild(ul);

    if (a && a.error) {
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = a.error;
      card.appendChild(err);
    } else if (a && a.explanation) {
      const ex = document.createElement("div");
      ex.className = "explain";
      ex.textContent = a.explanation;
      if (a.fromCache) {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = "cached";
        ex.appendChild(b);
      }
      card.appendChild(ex);
    } else if (busy) {
      const p = document.createElement("div");
      p.className = "pending";
      p.textContent = "Solving…";
      card.appendChild(p);
    }

    list.appendChild(card);
  }
}

init();
