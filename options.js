"use strict";

const DEFAULTS = {
  provider: "groq",
  apiKey: "YOUR_GROQ_API_KEY_HERE",
  model: "openai/gpt-oss-120b",
  baseUrl: "",
  autoSolve: true,
  maxBatch: 15,
  cacheEnabled: true,
};

const MODEL_LISTS = {
  openrouter: [
    { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL (recommended)", rec: true },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B" },
    { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B" },
    { id: "minimax/minimax-m3.1-flash:free", label: "MiniMax M3.1 Flash" },
    { id: "thinkingmachines/inkling-small:free", label: "Inkling Small" },
    { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning" },
  ],
  groq: [
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (recommended)", rec: true },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B (fastest)" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (may need paid plan)" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant (may need paid plan)" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o mini (recommended)", rec: true },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { id: "gpt-4o", label: "GPT-4o" },
  ],
  gemini: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (recommended)", rec: true },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
  anthropic: [
    { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku (recommended)", rec: true },
    { id: "claude-sonnet-4-0", label: "Claude Sonnet 4" },
  ],
  ollama: [{ id: "minicpm-v4.6", label: "minicpm-v4.6 (local)" }],
  custom: [],
};

let openrouterCache = null;
let ollamaCache = null;

const $ = (id) => document.getElementById(id);

function msg(text, cls) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = cls || "";
}

async function loadOpenRouterModels() {
  if (openrouterCache) return openrouterCache;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models");
    const j = await r.json();
    const ids = (j.data || [])
      .map((m) => m.id)
      .filter((id) => id.endsWith(":free"))
      .sort();
    if (ids.length) {
      const rec = "nvidia/nemotron-3.5-super-vl:free";
      const ordered = [rec, ...ids.filter((i) => i !== rec)];
      openrouterCache = ordered.map((id) => ({
        id,
        label: id.replace(":free", "") + (id === rec ? " (recommended)" : " · free"),
      }));
    }
  } catch (e) {}
  return openrouterCache || MODEL_LISTS.openrouter;
}

async function loadOllamaModels() {
  if (ollamaCache) return ollamaCache;
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const j = await r.json();
    const names = (j.models || []).map((m) => m.name);
    if (names.length) {
      ollamaCache = names.map((n, i) => ({
        id: n,
        label: n + (i === 0 ? " (local)" : ""),
      }));
    }
  } catch (e) {}
  return ollamaCache || MODEL_LISTS.ollama;
}

async function getProviderModels(provider) {
  if (provider === "openrouter") return loadOpenRouterModels();
  if (provider === "ollama") return loadOllamaModels();
  return MODEL_LISTS[provider] || [];
}

async function populateModels(preferred) {
  const provider = $("provider").value;
  const custom = provider === "custom";
  $("model").style.display = custom ? "none" : "";
  $("modelCustom").style.display = custom ? "" : "none";
  $("modelHint").style.display = custom ? "none" : "";
  if (custom) {
    $("modelCustom").value =
      preferred && !isKnownId(preferred) ? preferred : "";
    return;
  }
  const list = await getProviderModels(provider);
  const sel = $("model");
  sel.innerHTML = "";
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  const valid = preferred && list.some((m) => m.id === preferred);
  if (valid) sel.value = preferred;
  else if (!list.some((m) => m.id === sel.value)) sel.selectedIndex = 0;
}

function isKnownId(id) {
  for (const k of Object.keys(MODEL_LISTS)) {
    if (MODEL_LISTS[k].some((m) => m.id === id)) return true;
  }
  return false;
}

function toggleProviderUI() {
  const p = $("provider").value;
  $("baseUrlWrap").style.display = p === "custom" ? "" : "none";
  const keyLabel = document.querySelector('label[for="apiKey"]');
  const noKey = p === "ollama";
  keyLabel.style.opacity = noKey ? "0.5" : "1";
  $("apiKey").disabled = noKey;
  $("apiKeyHint").textContent = noKey
    ? "Not needed — Ollama runs locally with no key."
    : "Stored locally in extension storage. Sent only to the provider you choose.";
}

async function load() {
  const cfg = {
    ...DEFAULTS,
    ...(await chrome.storage.local.get(Object.keys(DEFAULTS))),
  };
  if (cfg.provider === "groq" && !String(cfg.apiKey).startsWith("gsk_")) {
    cfg.apiKey = DEFAULTS.apiKey;
  }
  if (!cfg.apiKey) cfg.apiKey = DEFAULTS.apiKey;
  $("provider").value = cfg.provider;
  $("apiKey").value = cfg.apiKey;
  $("baseUrl").value = cfg.baseUrl;
  $("maxBatch").value = cfg.maxBatch;
  $("autoSolve").checked = Boolean(cfg.autoSolve);
  $("cacheEnabled").checked = Boolean(cfg.cacheEnabled);
  toggleProviderUI();
  await populateModels(cfg.model);
}

function collect() {
  const provider = $("provider").value;
  let model;
  if (provider === "custom") {
    model = $("modelCustom").value.trim();
  } else {
    model = $("model").value;
  }
  if (!model) model = (MODEL_LISTS[provider] && MODEL_LISTS[provider][0] && MODEL_LISTS[provider][0].id) || "unknown";
  return {
    provider,
    apiKey: provider === "ollama" ? "" : $("apiKey").value.trim(),
    model,
    baseUrl:
      provider === "custom"
        ? $("baseUrl").value.trim()
        : provider === "ollama"
        ? "http://localhost:11434/v1"
        : "",
    maxBatch: Math.min(50, Math.max(1, parseInt($("maxBatch").value, 10) || 15)),
    autoSolve: $("autoSolve").checked,
    cacheEnabled: $("cacheEnabled").checked,
  };
}

$("provider").addEventListener("change", () => {
  toggleProviderUI();
  populateModels(null).then(scheduleAutoSave);
});

for (const id of ["model", "modelCustom", "apiKey", "baseUrl", "maxBatch", "autoSolve", "cacheEnabled"]) {
  $(id).addEventListener("change", scheduleAutoSave);
}

let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveConfig, 400);
}

async function saveConfig() {
  const cfg = collect();
  await chrome.storage.local.set(cfg);
  try {
    await chrome.runtime.sendMessage({ type: "CONFIG_CHANGED", config: cfg });
  } catch (e) {}
  msg("Saved", "ok");
  setTimeout(() => msg(""), 1200);
}

$("save").addEventListener("click", async () => {
  const cfg = collect();
  if (cfg.provider === "custom" && cfg.baseUrl) {
    try {
      const origin = new URL(cfg.baseUrl).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        msg("Permission for base URL not granted", "err");
        return;
      }
    } catch (e) {
      msg("Invalid base URL", "err");
      return;
    }
  }
  await saveConfig();
});

$("test").addEventListener("click", async () => {
  msg("Testing…");
  const res = await chrome.runtime.sendMessage({
    type: "TEST_API",
    config: collect(),
  });
  if (res && res.ok) msg("API OK", "ok");
  else msg((res && res.error) || "Test failed", "err");
});

load();
