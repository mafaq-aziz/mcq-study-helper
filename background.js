"use strict";

const DEFAULTS = {
  provider: "groq",
  apiKey: "YOUR_GROQ_API_KEY_HERE",
  model: "openai/gpt-oss-120b",
  baseUrl: "",
  autoSolve: true,
  maxBatch: 15,
  cacheEnabled: true,
  outlineOn: true,
};

const CACHE_TTL_MS = 48 * 60 * 60 * 1000;
const CACHE_VER = 2;
const AR_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function hasArabicText(q) {
  return AR_SCRIPT_RE.test(
    (q.text || "") +
      " " +
      (q.options || []).map((o) => o.text || "").join(" ")
  );
}
const pending = new Set();
const autoTimers = new Map();

async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const merged = { ...DEFAULTS, ...stored };
  if (!merged.apiKey) merged.apiKey = DEFAULTS.apiKey;
  if (
    merged.provider === "groq" &&
    !String(merged.apiKey).startsWith("gsk_") &&
    String(DEFAULTS.apiKey).startsWith("gsk_")
  ) {
    merged.apiKey = DEFAULTS.apiKey;
  }
  return merged;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
  ensureAllTabs();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => ensureAllTabs());
}

let allTabsDone = false;
ensureAllTabs();
setTimeout(() => {
  allTabsDone = false;
  ensureAllTabs();
}, 3000);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") ensureInjected(tabId);
});

function tabUrlOk(url) {
  if (!url) return true;
  return /^(https?|file):/.test(url);
}

const injectCooldown = new Map();

async function ensureInjected(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT" });
    return true;
  } catch (e) {}
  const last = injectCooldown.get(tabId) || 0;
  if (Date.now() - last < 4000) return false;
  injectCooldown.set(tabId, Date.now());
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e2) {
    return false;
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
  } catch (e3) {}
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT" });
    return true;
  } catch (e4) {
    return false;
  }
}

async function ensureAllTabs() {
  if (allTabsDone) return;
  allTabsDone = true;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    allTabsDone = false;
    return;
  }
  for (const tab of tabs) {
    if (tab.id == null || !tabUrlOk(tab.url)) continue;
    ensureInjected(tab.id);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "QUESTIONS_UPDATE") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    handleQuestions(tabId, msg.questions || []);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "SOLVE_SUBJECT") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ error: "no tab" }); return; }
    (async () => {
      try {
        const stored = await chrome.storage.session.get(`a_${tabId}`);
        const ans = stored[`a_${tabId}`] || {};
        const cfg = await getConfig();
        const results = await solveChunk(msg.questions, cfg);
        for (const r of results) applyRow(r, ans, cfg);
        await chrome.storage.session.set({ [`a_${tabId}`]: ans });
        pushOutlines(tabId);
        sendResponse({ results });
      } catch (e) { sendResponse({ error: String(e) || "solve failed" }); }
    })();
    return true;
  }
  if (msg.type === "GET_STATE") {
    getState(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "SOLVE") {
    solveTab(msg.tabId, Boolean(msg.force)).then(sendResponse);
    return true;
  }
  if (msg.type === "CLEAR_ANSWERS") {
    chrome.storage.session
      .remove(`a_${msg.tabId}`)
      .then(() => {
        try {
          chrome.tabs.sendMessage(msg.tabId, { type: "CLEAR_OUTLINES" });
        } catch (e) {}
        sendResponse({ ok: true });
      });
    return true;
  }
  if (msg.type === "SET_OUTLINES") {
    chrome.storage.local
      .set({ outlineOn: Boolean(msg.on) })
      .then(() => pushOutlines(msg.tabId))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "TEST_API") {
    testApi(msg.config).then(sendResponse);
    return true;
  }
  if (msg.type === "CONFIG_CHANGED") {
    onConfigChanged().then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function onConfigChanged() {
  const all = await chrome.storage.session.get(null);
  const patch = {};
  const remove = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith("a_")) continue;
    const cleaned = {};
    let changed = false;
    for (const [h, a] of Object.entries(all[key] || {})) {
      if (a && a.error) {
        changed = true;
        continue;
      }
      cleaned[h] = a;
    }
    if (changed) {
      if (Object.keys(cleaned).length) patch[key] = cleaned;
      else remove.push(key);
    }
  }
  if (Object.keys(patch).length) await chrome.storage.session.set(patch);
  if (remove.length) await chrome.storage.session.remove(remove);

  const cfg = await getConfig();
  if (cfg.autoSolve) {
    const all2 = await chrome.storage.session.get(null);
    for (const key of Object.keys(all2)) {
      if (key.startsWith("q_") && Array.isArray(all2[key]) && all2[key].length) {
        const tabId = Number(key.slice(2));
        if (!Number.isNaN(tabId)) solveTab(tabId, false);
      }
    }
  }
}

async function pushOutlines(tabId) {
  if (tabId == null) return;
  const cfg = await getConfig();
  const answers =
    (await chrome.storage.session.get(`a_${tabId}`))[`a_${tabId}`] || {};
  const compact = {};
  for (const hash of Object.keys(answers)) {
    const a = answers[hash];
    if (a && !a.error && a.answerIndex != null) {
      compact[hash] = { answerIndex: a.answerIndex };
    }
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "APPLY_OUTLINES",
      answers: compact,
      enabled: cfg.outlineOn !== false,
    });
  } catch (e) {}
}

async function handleQuestions(tabId, questions) {
  const prev =
    (await chrome.storage.session.get(`q_${tabId}`))[`q_${tabId}`] || [];
  const unchanged =
    prev.length === questions.length &&
    JSON.stringify(prev) === JSON.stringify(questions);
  await chrome.storage.session.set({ [`q_${tabId}`]: questions });
  const cfg = await getConfig();
  if (unchanged) {
    pushOutlines(tabId);
    if (cfg.autoSolve) {
      try {
        const ans =
          (await chrome.storage.session.get(`a_${tabId}`))[`a_${tabId}`] || {};
        const staleArabic = questions.some((q) => {
          const row = ans[q.hash];
          return row && !row.error && row.v !== CACHE_VER && hasArabicText(q);
        });
        if (staleArabic) {
          const staleTimer = autoTimers.get(tabId);
          if (staleTimer) clearTimeout(staleTimer);
          autoTimers.set(
            tabId,
            setTimeout(() => {
              solveTab(tabId, false);
            }, 300)
          );
        }
      } catch (e) {}
    }
    return;
  }
  if (!cfg.autoSolve || questions.length === 0) {
    pushOutlines(tabId);
    return;
  }
  const prevTimer = autoTimers.get(tabId);
  if (prevTimer) clearTimeout(prevTimer);
  autoTimers.set(
    tabId,
    setTimeout(() => {
      solveTab(tabId, false);
    }, 300)
  );
}

async function getState(tabId) {
  let questions = [];
  let contentAlive = false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT" });
    contentAlive = true;
    questions = (res && res.questions) || [];
  } catch (e) {
    contentAlive = await ensureInjected(tabId);
    if (contentAlive) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, {
          type: "PING_CONTENT",
        });
        questions = (res && res.questions) || [];
      } catch (e2) {}
    }
  }
  if (!questions.length) {
    questions =
      (await chrome.storage.session.get(`q_${tabId}`))[`q_${tabId}`] || [];
  }
  const answers =
    (await chrome.storage.session.get(`a_${tabId}`))[`a_${tabId}`] || {};
  const cfg = await getConfig();
  let url = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    url = (tab && tab.url) || "";
  } catch (e) {}
  return {
    questions,
    answers,
    contentAlive,
    url,
    config: {
      provider: cfg.provider,
      model: cfg.model,
      autoSolve: cfg.autoSolve,
      outlineOn: cfg.outlineOn !== false,
      hasKey: Boolean(cfg.apiKey) || cfg.provider === "ollama",
      cacheEnabled: cfg.cacheEnabled,
    },
  };
}

async function loadCache(questions) {
  if (!questions.length) return {};
  const keys = [];
  for (const q of questions) {
    keys.push(`cache_${CACHE_VER}_${q.hash}`);
    if (!hasArabicText(q)) keys.push(`cache_${q.hash}`);
  }
  const stored = await chrome.storage.local.get(keys);
  const now = Date.now();
  const out = {};
  for (const q of questions) {
    let c = stored[`cache_${CACHE_VER}_${q.hash}`];
    if (!c && !hasArabicText(q)) c = stored[`cache_${q.hash}`];
    if (c && now - c.ts < CACHE_TTL_MS) out[q.hash] = c;
  }
  return out;
}

async function saveCache(entries) {
  const toSet = {};
  for (const e of entries) toSet[`cache_${CACHE_VER}_${e.hash}`] = e;
  await chrome.storage.local.set(toSet);
}

async function solveTab(tabId, force) {
  const cfg = await getConfig();
  if (!cfg.apiKey && cfg.provider !== "ollama") {
    return { ok: false, error: "No API key set. Open extension options." };
  }
  if (cfg.provider === "ollama") {
    const reachable = await fetch("http://localhost:11434/api/tags")
      .then(() => true)
      .catch(() => false);
    if (!reachable) {
      return {
        ok: false,
        error: "Ollama is not running. Start it with: ollama serve",
      };
    }
  }
  let questions =
    (await chrome.storage.session.get(`q_${tabId}`))[`q_${tabId}`] || [];
  if (!questions.length) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: "PING_CONTENT",
      });
      questions = (res && res.questions) || [];
      await chrome.storage.session.set({ [`q_${tabId}`]: questions });
    } catch (e) {
      const alive = await ensureInjected(tabId);
      if (alive) {
        try {
          const res = await chrome.tabs.sendMessage(tabId, {
            type: "PING_CONTENT",
          });
          questions = (res && res.questions) || [];
          await chrome.storage.session.set({ [`q_${tabId}`]: questions });
        } catch (e2) {}
      }
    }
  }
  if (!questions.length) {
    return {
      ok: false,
      error:
        "No MCQs detected on this tab. Open the side panel once so the detector can load, or check that the quiz is visible.",
    };
  }

  let answers =
    (await chrome.storage.session.get(`a_${tabId}`))[`a_${tabId}`] || {};
  const todo = questions.filter((q) => {
    if (pending.has(q.hash)) return false;
    const prev = answers[q.hash];
    if (force) return true;
    if (!prev || prev.error) return true;
    if (prev.v === CACHE_VER) return false;
    return hasArabicText(q);
  });

  const cached = cfg.cacheEnabled ? await loadCache(todo) : {};
  const cacheHits = [];
  const remaining = [];
  for (const q of todo) {
    if (cached[q.hash]) {
      answers[q.hash] = {
        answerIndex: cached[q.hash].answerIndex,
        explanation: cached[q.hash].explanation,
        model: cached[q.hash].model,
        v: CACHE_VER,
        fromCache: true,
      };
      cacheHits.push(q.hash);
    } else {
      remaining.push(q);
    }
  }

  if (cacheHits.length) {
    await chrome.storage.session.set({ [`a_${tabId}`]: answers });
  }

  if (remaining.length) {
    const size = Math.max(1, cfg.maxBatch);
    const chunks = [];
    for (let i = 0; i < remaining.length; i += size) {
      chunks.push(remaining.slice(i, i + size));
    }
    const settled = await Promise.allSettled(
      chunks.map((c) => solveChunk(c, cfg))
    );
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      for (const r of s.value) applyRow(r, answers, cfg);
    }

    const failed = remaining.filter(
      (q) => answers[q.hash] && answers[q.hash].error
    );
    if (failed.length) {
      const rateLimited = failed.some((q) =>
        /429|rate.?limit|too many|quota|overloaded/i.test(
          answers[q.hash].error || ""
        )
      );
      await sleep(rateLimited ? 2500 : 500);
      const retryRows = await mapLimit(failed, 3, (q) =>
        solveChunk([q], cfg)
      );
      for (const rows of retryRows) {
        for (const r of rows) applyRow(r, answers, cfg);
      }
    }

    const fresh = remaining
      .filter((q) => answers[q.hash] && !answers[q.hash].error)
      .map((q) => ({
        hash: q.hash,
        answerIndex: answers[q.hash].answerIndex,
        explanation: answers[q.hash].explanation,
        ts: Date.now(),
        model: cfg.model,
      }));
    if (cfg.cacheEnabled && fresh.length) await saveCache(fresh);
    await chrome.storage.session.set({ [`a_${tabId}`]: answers });
  }

  pushOutlines(tabId);
  return {
    ok: true,
    solved: Object.keys(answers).length,
    total: questions.length,
  };
}

function applyRow(r, answers, cfg) {
  if (r.error) {
    let err = r.error;
    if (
      /access|permission|not allowed|not available|model_not_found|decommissioned|unauthorized/i.test(
        err
      )
    ) {
      err += " — pick another model in Options";
    }
    answers[r.hash] = { error: err };
  } else {
    answers[r.hash] = {
      answerIndex: r.answerIndex,
      explanation: r.explanation,
      model: cfg.model,
      v: CACHE_VER,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function normMatch(s) {
  let t = String(s == null ? "" : s);
  try {
    t = t.normalize("NFC");
  } catch (e) {}
  return t
    .replace(/[\u064B-\u065F\u0670\u0640\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/[\u06CC\u06D2\u06D0]/g, "\u064A")
    .replace(/[\u06C1\u06C3\u0629]/g, "\u0647")
    .replace(/\u06A9/g, "\u0643")
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/^\s*(?:[A-Da-d][).:]|\d{1,2}[).:](?!\d))\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function exactOptionIndex(text, options) {
  const m = normMatch(text);
  if (!m) return -1;
  for (let i = 0; i < options.length; i++)
    if (normMatch(options[i].text) === m) return i;
  return -1;
}

function looseOptionIndex(text, options) {
  const m = normMatch(text);
  if (!m) return -1;
  for (let i = 0; i < options.length; i++) {
    const o = normMatch(options[i].text);
    if (o.length >= 4 && m.length >= 4 && (o.includes(m) || m.includes(o)))
      return i;
  }
  return -1;
}

async function solveChunk(questions, cfg) {
  for (const q of questions) pending.add(q.id || q.hash);
  try {
    const payload = questions.map((q) => ({
      id: q.id || q.hash,
      type: q.type,
      question: q.question || q.text,
      options: q.options.map((o, i) => `${i}) ${o.text || o.text}`),
    }));
    const nonLatin = questions.some(hasArabicText);
    const schema = nonLatin
      ? '{"answers":[{"id":"<id>","answerIndex":0,"answerText":"<verbatim text of the chosen option>","explanation":"<1-2 sentences>"}]}'
      : '{"answers":[{"id":"<id>","answerIndex":0,"explanation":"<1-2 sentences>"}]}';
    const intro = nonLatin
      ? "Solve each MCQ. Questions and options may be in Urdu, Arabic or any other script — read the original text exactly as written, do not translate or paraphrase it. " +
        "For each question first copy the correct option's text VERBATIM into answerText, then set answerIndex to the 0-based index of that exact option, so answerIndex and answerText always point to the same option. " +
        "Return ONLY JSON matching this schema, no prose: " +
        schema +
        ". answerIndex is 0-based; for multi-select (checkbox) questions use arrays for both answerIndex and answerText. Write each explanation in the same language as its question, under 30 words.\n\n"
      : "Solve each MCQ. Return ONLY JSON matching this schema, no prose: " +
        schema +
        ". answerIndex is the 0-based index of the correct option; use an array of indices for multi-select (checkbox) questions. Keep explanations under 30 words.\n\n";
    const prompt = intro + JSON.stringify(payload);
    const text = await callLLM(cfg, prompt);
    const data = parseJsonLoose(text);
    const arr = Array.isArray(data.answers)
      ? data.answers
      : Array.isArray(data)
      ? data
      : [];
    const map = new Map();
    for (const a of arr) {
      if (a && a.id != null) map.set(String(a.id), a);
    }
    return questions.map((q, i) => {
      let a = map.get(q.hash);
      if (!a && map.size === 0 && arr.length === questions.length) a = arr[i];
      if (!a) return { hash: q.hash, error: "No answer in model response" };
      let idx = a.answerIndex;
      if (idx == null) idx = a.answer_index;
      if (idx == null) idx = a.correctIndex;
      if (idx == null) idx = a.correct;
      if (idx == null) idx = a.answer;
      if (typeof idx === "string") {
        const s = idx.trim();
        if (s.startsWith("[")) {
          try {
            idx = JSON.parse(s);
          } catch (e) {}
        } else if (/^[a-zA-Z]$/.test(s)) {
          idx = s.toUpperCase().charCodeAt(0) - 65;
        } else {
          const n = Number(s);
          if (!Number.isNaN(n)) idx = n;
        }
      }
      if (typeof idx === "string") {
        const parts = idx.split(/[\s,;]+/).filter(Boolean);
        idx = parts.map((p) => (/^[a-zA-Z]$/.test(p) ? p.toUpperCase().charCodeAt(0) - 65 : Number(p))).filter((n) => !Number.isNaN(n));
        if (idx.length === 1) idx = idx[0];
      }
      if (typeof idx === "number" && !Number.isInteger(idx)) idx = Math.round(idx);

      const rawT = a.answerText != null ? a.answerText : a.answer_text;
      const texts = Array.isArray(rawT)
        ? rawT.filter((t) => String(t).trim() !== "")
        : rawT != null && String(rawT).trim() !== ""
        ? [rawT]
        : [];
      const idxValid =
        idx != null &&
        idx !== "" &&
        (Array.isArray(idx)
          ? idx.length > 0 &&
            idx.every((n) => Number.isInteger(n) && n >= 0 && n < q.options.length)
          : Number.isInteger(idx) && idx >= 0 && idx < q.options.length);
      if (texts.length) {
        const exact = texts.map((t) => exactOptionIndex(t, q.options));
        if (exact.length === texts.length && exact.every((n) => n >= 0)) {
          idx = [...new Set(exact)].sort((x, y) => x - y);
          if (idx.length === 1) idx = idx[0];
        } else if (!idxValid) {
          const loose = texts
            .map((t) => looseOptionIndex(t, q.options))
            .filter((n) => n >= 0);
          if (loose.length === texts.length) {
            idx = [...new Set(loose)].sort((x, y) => x - y);
            if (idx.length === 1) idx = idx[0];
          }
        }
      }
      if (idx == null || idx === "") {
        return { hash: q.hash, error: "Missing answerIndex in model response" };
      }
      const nums = Array.isArray(idx) ? idx : [idx];
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n >= q.options.length)) {
        return { hash: q.hash, error: "Model returned out-of-range answer: " + idx };
      }
      return {
        hash: q.hash,
        answerIndex: idx,
        explanation: String(a.explanation || a.reason || a.detail || ""),
      };
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return questions.map((q) => ({ hash: q.hash, error: msg }));
  } finally {
    for (const q of questions) pending.delete(q.hash);
  }
}

async function callLLM(cfg, prompt) {
  if (cfg.provider === "gemini") {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(cfg.model) +
      ":generateContent?key=" +
      encodeURIComponent(cfg.apiKey);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        (data.error && data.error.message) || "Gemini API error " + res.status
      );
    }
    const cand = data.candidates && data.candidates[0];
    return (cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text) || "";
  }

  let base;
  if (cfg.provider === "ollama") {
    base = (cfg.baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  } else if (cfg.provider === "groq") base = "https://api.groq.com/openai/v1";
  else if (cfg.provider === "openrouter") base = "https://openrouter.ai/api/v1";
  else if (cfg.provider === "anthropic") {
    return await callAnthropic(cfg, prompt);
  } else if (cfg.provider === "custom") {
    base = (cfg.baseUrl || "").replace(/\/+$/, "");
    if (!base) throw new Error("Custom provider requires a base URL");
  } else base = "https://api.openai.com/v1";

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + (cfg.apiKey || "ollama"),
  };
  const body = {
    model: cfg.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You solve multiple-choice questions. Respond only with valid JSON.",
      },
      { role: "user", content: prompt },
    ],
  };
  let res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 400) {
    const b = { ...body };
    delete b.response_format;
    res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(b),
    });
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      (data.error && data.error.message) || "API error " + res.status
    );
  }
  return (
    (data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    ""
  );
}

async function callAnthropic(cfg, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      (data.error && data.error.message) || "Anthropic API error " + res.status
    );
  }
  return (data.content && data.content[0] && data.content[0].text) || "";
}

function parseJsonLoose(text) {
  if (!text) throw new Error("Empty model response");
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {}
  const s = cleaned.indexOf("{");
  const e2 = cleaned.lastIndexOf("}");
  if (s >= 0 && e2 > s) return JSON.parse(cleaned.slice(s, e2 + 1));
  throw new Error("Could not parse model JSON");
}

async function testApi(config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.apiKey && cfg.provider !== "ollama") {
    return { ok: false, error: "No API key provided" };
  }
  try {
    const prompt =
      'Solve: 2+2=? options: ["3","4","5"]. Return ONLY JSON: {"answers":[{"id":"x","answerIndex":1,"explanation":"Basic arithmetic."}]}';
    const text = await callLLM(cfg, prompt);
    parseJsonLoose(text);
    return { ok: true };
  } catch (e2) {
    return { ok: false, error: String((e2 && e2.message) || e2) };
  }
}
