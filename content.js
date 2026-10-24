(() => {
  "use strict";

  if (window.__MCQ_HELPER_V1__) return;
  window.__MCQ_HELPER_V1__ = true;

  const EXTRACT_DEBOUNCE_MS = 250;
  const ATTRIBUTE = "data-mcq-helper-id";
  const POLL_MS = 2500;

  const WATCHED_ATTRS = [
    "class",
    "style",
    "hidden",
    "value",
    "checked",
    "selected",
    "aria-checked",
    "aria-selected",
    "aria-expanded",
    "aria-hidden",
    "data-value",
    "data-state",
    "data-answer",
    "open",
  ];

  let lastSignature = "";
  let extractTimer = null;
  let lastOptionEls = new Map();
  let lastAnswers = {};
  let outlineEnabled = true;
  let orderedHashes = [];
  let lastRoots = new Map();
  let focusHash = null;
  let submitting = false;
  let lastWrongPress = null;
  let markedEls = [];
  let soloOn = true;
  let lastTops = new Map();
  let onSoloStorage = null;
  let autoSubmitOnComplete = true;
  let lastQuestionsMap = new Map();
  let lastSubjectIndex = new Map();
  let subjectCount = 0;
  const VANISH_CLS = "mcq-helper-vanish";
  const SOLO_BODY_CLS = "mcq-helper-solo";

  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function buildSubjectIndex() {
    lastSubjectIndex = new Map();
    subjectCount = 0;
    const roots = [...lastRoots.values()].filter(Boolean);
    if (!roots.length) return;
    const boundOf = new Map();
    const bounds = new Set();
    for (const r of roots) {
      let b = null;
      let n = r.parentElement;
      while (n && n.nodeType === 1 && n !== document.documentElement) {
        let cnt = 0;
        for (const r2 of roots) if (n.contains(r2)) cnt++;
        if (cnt >= 2) { b = n; break; }
        n = n.parentElement;
      }
      if (!b) b = document.body;
      boundOf.set(r, b);
      bounds.add(b);
    }
    const boundList = [...bounds].sort((a, b) => {
      const p = a.compareDocumentPosition(b);
      return (p & Node.DOCUMENT_POSITION_PRECEDING) ? -1 : (p & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0);
    });
    subjectCount = boundList.length;
    for (const [hash, root] of lastRoots) {
      if (!root) continue;
      lastSubjectIndex.set(hash, boundList.indexOf(boundOf.get(root)));
    }
  }

  async function solveSubject(si) {
    const hashes = orderedHashes.filter((h) => (lastSubjectIndex.get(h) || 0) === si && !isAnswered(h));
    if (!hashes.length) return;
    const payload = hashes.map((h) => {
      const q = lastQuestionsMap.get(h);
      return q ? { id: q.hash, type: q.type, question: q.text, options: q.options.map((o) => o.text) } : null;
    }).filter(Boolean);
    if (!payload.length) return;
    try {
      setFocus(hashes[0]);
      chrome.runtime.sendMessage({ type: "SOLVE_SUBJECT", questions: payload }, (res) => {
        if (!res || !res.results) return;
        for (const r of res.results) {
          if (r.error) continue;
          const els = lastOptionEls.get(r.hash) || [];
          const idxs = Array.isArray(r.answerIndex) ? r.answerIndex : [r.answerIndex];
          idxs.forEach((i) => selectOption(els[i]));
          lastAnswers[r.hash] = { answerIndex: r.answerIndex, explanation: r.explanation || "" };
          const firstEl = els[idxs[0]];
          const isRadio = firstEl && firstEl.tagName === "INPUT" && firstEl.type === "radio";
          if (!Array.isArray(r.answerIndex) || isRadio || allSelected(r.hash, r.answerIndex)) advanceFocus(r.hash);
        }
        applyOutlines(lastAnswers);
      });
    } catch (e) {}
  }

  const BLOCKY_RE =
    /^(DIV|P|LI|TR|TD|TH|UL|OL|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|H[1-6]|BR|HR|TABLE|FIGURE|BLOCKQUOTE|PRE|FORM|DETAILS|SUMMARY|DT|DD|DL|ADDRESS|FIGCAPTION)$/;
  const INLINEY_RE =
    /^(SPAN|B|I|EM|STRONG|A|CODE|FONT|U|S|SMALL|BIG|SUB|SUP|LABEL|TIME|MARK|Q|CITE|DEL|INS|ABBR|RUBY|RT|RP|VAR|KBD|SAMP|DATA|OUTPUT|NOBR|DFN)$/;

  function gapBetween(a, b) {
    if (!a || !b) return " ";
    let cur = b;
    let guard = 0;
    while (cur && cur !== a && guard++ < 200) {
      const prev = cur.previousSibling;
      if (!prev) {
        cur = cur.parentNode;
        continue;
      }
      if (prev === a) {
        if (prev.nodeType === 1)
          return INLINEY_RE.test(prev.tagName)
            ? ""
            : BLOCKY_RE.test(prev.tagName)
            ? " "
            : "";
        return "";
      }
      if (prev.nodeType === 3)
        return /\s/.test(prev.textContent || "") ? "" : " ";
      if (prev.nodeType === 1) {
        if (prev === a || prev.contains(a)) {
          return INLINEY_RE.test(prev.tagName)
            ? ""
            : BLOCKY_RE.test(prev.tagName)
            ? " "
            : "";
        }
        if (BLOCKY_RE.test(prev.tagName)) return " ";
        cur = prev;
        continue;
      }
      cur = prev;
    }
    return " ";
  }

  function gapByElements(elA, elB) {
    if (!elA || !elB) return " ";
    let n = elA.nextSibling;
    let guard = 0;
    while (n && n !== elB && guard++ < 100) {
      if (n.nodeType === 3) return /\s/.test(n.textContent || "") ? " " : " ";
      if (n.nodeType === 1) {
        if (BLOCKY_RE.test(n.tagName)) return " ";
        if (INLINEY_RE.test(n.tagName)) {
          n = n.nextSibling;
          continue;
        }
        return " ";
      }
      n = n.nextSibling;
    }
    if (BLOCKY_RE.test(elA.tagName)) return " ";
    if (BLOCKY_RE.test(elB.tagName)) return " ";
    return "";
  }

  function joinParts(parts, nodes) {
    let out = "";
    let prevNode = null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (!out) {
        out = p;
        prevNode = nodes ? nodes[i] : null;
        continue;
      }
      const gap =
        prevNode && nodes && nodes[i] ? gapBetween(prevNode, nodes[i]) : " ";
      if (gap === " " && !/\s$/.test(out) && !/^\s/.test(p)) out += " ";
      out += p;
      prevNode = nodes && nodes[i] ? nodes[i] : prevNode;
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function optionText(el) {
    if (!el) return "";
    const lbl = el.labels && el.labels[0];
    let t = norm((lbl || el).textContent);
    if (!t) t = norm(el.getAttribute("aria-label") || el.value || "");
    return t.slice(0, 300);
  }

  function textOfSubtree(root, optSet) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      let p = n.parentElement;
      let skip = false;
      while (p) {
        if (
          optSet.has(p) ||
          p.tagName === "INPUT" ||
          p.tagName === "LABEL" ||
          p.tagName === "BUTTON" ||
          p.tagName === "SELECT" ||
          p.tagName === "TEXTAREA"
        ) {
          skip = true;
          break;
        }
        p = p.parentElement;
      }
      if (skip) continue;
      if (n.textContent) {
        parts.push(n.textContent);
        nodes.push(n);
      }
      if (joinParts(parts, nodes).length > 500) break;
    }
    return joinParts(parts, nodes).slice(0, 700);
  }

  function precedingText(el, stopNode, optSet) {
    const entries = [];
    const rawLen = () => entries.reduce((s, e) => s + e.t.length, 0);
    let cur = el;
    while (cur && cur !== stopNode && rawLen() < 500) {
      let prev = cur.previousElementSibling;
      while (prev && rawLen() < 8) {
        const t = textOfSubtree(prev, optSet);
        if (t) entries.unshift({ t, el: prev });
        prev = prev.previousElementSibling;
      }
      if (rawLen() >= 8) break;
      cur = cur.parentElement;
    }
    let out = "";
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!out) {
        out = e.t;
        continue;
      }
      const gap = i > 0 ? gapByElements(entries[i - 1].el, e.el) : " ";
      if (gap === " " && !/\s$/.test(out) && !/^\s/.test(e.t)) out += " ";
      out += e.t;
    }
    return out.replace(/\s+/g, " ").trim().slice(0, 700);
  }

  function questionTextNear(el, optionEls) {
    const optSet = new Set(optionEls);
    for (const o of optionEls) {
      const lbl = o.closest && o.closest("label");
      if (lbl) optSet.add(lbl);
    }
    const firstOpt = optionEls[0];
    let node = el.closest("fieldset,li,div,section,article,tr");
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const parts = [];
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) {
        if (
          firstOpt &&
          !(firstOpt.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING)
        )
          break;
        let p = n.parentElement;
        let skip = false;
        while (p) {
          if (
            optSet.has(p) ||
            p.tagName === "INPUT" ||
            p.tagName === "LABEL" ||
            p.tagName === "BUTTON" ||
            p.tagName === "SELECT" ||
            p.tagName === "TEXTAREA"
          ) {
            skip = true;
            break;
          }
          p = p.parentElement;
        }
        if (skip) continue;
        if (n.textContent) {
          parts.push(n.textContent);
          nodes.push(n);
        }
        if (joinParts(parts, nodes).length > 500) break;
      }
      const walkText = joinParts(parts, nodes).slice(0, 700);
      let text = "";
      if (depth < 2) {
        text = walkText;
        if (text.length < 8) text = precedingText(el, node, optSet);
      } else {
        text = precedingText(el, node, optSet);
        if (text.length < 8) text = walkText;
      }
      if (text.length >= 8) return { text, node };
    }
    return { text: "", node: null };
  }

  function questionHash(q) {
    return hashStr(q.text + "|" + q.options.map((o) => o.text).join("|"));
  }

  function collectRadioGroups() {
    const byName = new Map();
    const loose = [];
    for (const input of document.querySelectorAll(
      'input[type="radio"],input[type="checkbox"]'
    )) {
      if (input.disabled || !input.isConnected) continue;
      if (input.name) {
        if (!byName.has(input.name)) byName.set(input.name, []);
        byName.get(input.name).push(input);
      } else {
        loose.push(input);
      }
    }
    const groups = [];
    for (const arr of byName.values()) {
      if (arr.length >= 2 && arr.length <= 12) groups.push(arr);
    }
    const byScope = new Map();
    for (const input of loose) {
      const scope =
        input.closest(
          '[role="radiogroup"],fieldset,ul,ol,.options,.choices,.option-list,li,div'
        ) || input.parentElement;
      if (!scope) continue;
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push(input);
    }
    for (const arr of byScope.values()) {
      if (arr.length >= 2 && arr.length <= 12) groups.push(arr);
    }
    return groups;
  }

  function buildFromGroup(inputs, type) {
    const options = [];
    const seenText = new Set();
    const els = [];
    for (const input of inputs) {
      const text = optionText(input);
      if (!text || seenText.has(text)) continue;
      seenText.add(text);
      options.push({ text });
      els.push(input);
    }
    if (options.length < 2) return null;
    const near = questionTextNear(inputs[0], inputs);
    if (!near.text) return null;
    if (near.text.split(/\s+/).length < 2 || near.text.length > 700)
      return null;
    const q = {
      text: near.text,
      type,
      options,
      _els: els,
      _stem: near.node,
    };
    q.hash = questionHash(q);
    return q;
  }

  function isHidden(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.classList && node.classList.contains(VANISH_CLS)) return false;
      try {
        const cs = window.getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden") return true;
      } catch (e) {}
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true")
        return true;
      node = node.parentElement;
    }
    return false;
  }

  function collectButtonGroups(alreadyUsed) {
    const leafSel =
      'button,li,a,div,span,[role="button"],[role="radio"],[role="option"],[role="menuitemradio"]';
    const innerSel =
      '[class*="option" i],[class*="choice" i],[class*="answer" i],[role="radio"],[role="option"]';
    const nameRe = /option|choice|answer|variant|opt-|-opt\b/i;
    const badRegion =
      'nav,header,footer,aside,[role="navigation"],[role="menu"],[role="menubar"],[role="toolbar"],[role="banner"],[role="contentinfo"],[role="tablist"],[role="tab"],[role="search"]';
    const containerClassRe =
      /^(ul|ol|fieldset|table|form)$/i;
    const proseClassRe =
      /faq|comment|review|feedback|testimonial|description|summary|caption|transcript|cookie|banner|promo|breadcrumb|social|excerpt/i;
    const candidates = [];
    for (const el of document.querySelectorAll(leafSel)) {
      if (!el.isConnected || el.disabled || alreadyUsed.has(el)) continue;
      if (el.matches("a[href]") || el.closest("a[href]")) continue;
      if (el.closest(badRegion)) continue;
      if (isHidden(el)) continue;
      const cls = typeof el.className === "string" ? el.className : "";
      if (!nameRe.test(cls) && !nameRe.test(el.id || "")) continue;
      if (proseClassRe.test(cls) || proseClassRe.test(el.id || "")) continue;
      if (el.querySelector(innerSel)) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 300) continue;
      if (el.querySelector("input[type=radio],input[type=checkbox]")) continue;
      candidates.push(el);
    }

    const groupsMap = new Map();
    for (const el of candidates) {
      if (
        containerClassRe.test(el.tagName) ||
        el.matches(
          '[role="radiogroup"],[role="listbox"],.options,.choices,.answers,.option-list,.choice-list'
        )
      )
        continue;
      const parent = el.parentElement;
      if (!parent) continue;
      if (!groupsMap.has(parent)) groupsMap.set(parent, []);
      groupsMap.get(parent).push(el);
    }
    for (const [parent, els] of groupsMap) {
      if (els.length >= 2 && els.length <= 12) continue;
      const gp = parent.parentElement;
      if (!gp) continue;
      for (const el of els) {
        if (!groupsMap.has(gp)) groupsMap.set(gp, []);
        groupsMap.get(gp).push(el);
      }
      groupsMap.delete(parent);
    }

    const groups = [];
    for (const [parent, els] of groupsMap) {
      if (els.length < 2 || els.length > 12) continue;
      const options = [];
      const seenText = new Set();
      const usedEls = [];
      for (const el of els) {
        const text = norm(el.textContent || el.getAttribute("aria-label") || "");
        if (!text || seenText.has(text.slice(0, 120))) continue;
        seenText.add(text.slice(0, 120));
        options.push({ text: text.slice(0, 300) });
        usedEls.push(el);
      }
      if (options.length < 2) continue;
      let wordSum = 0;
      for (const o of options) wordSum += o.text.split(/\s+/).length;
      if (wordSum / options.length > 10) continue;
      const tagCount = {};
      for (const e of usedEls) tagCount[e.tagName] = (tagCount[e.tagName] || 0) + 1;
      const topTag = Math.max.apply(null, Object.values(tagCount));
      if (topTag < usedEls.length * 0.75) continue;
      const near = questionTextNear(usedEls[0], usedEls);
      if (!near.text) continue;
      const words = near.text.split(/\s+/).length;
      if (words < 2 || near.text.length > 700) continue;
      const q = {
        text: near.text,
        type: "radio",
        options,
        _els: usedEls,
        _stem: near.node,
      };
      q.hash = questionHash(q);
      groups.push(q);
      usedEls.forEach((e) => alreadyUsed.add(e));
    }
    return groups;
  }

  function outlineTarget(el) {
    if (!el) return null;
    if (el.tagName === "INPUT") {
      return (el.labels && el.labels[0]) || el.parentElement || el;
    }
    return el;
  }

  function clearOutlines() {
    for (const el of markedEls) {
      try {
        el.classList.remove("mcq-helper-correct");
      } catch (e) {}
    }
    markedEls = [];
    try {
      document
        .querySelectorAll(".mcq-helper-correct")
        .forEach((e) => e.classList.remove("mcq-helper-correct"));
    } catch (e) {}
  }

  function applyOutlines(answers) {
    lastAnswers = answers || {};
    const next = [];
    const seen = new Set();
    const addTarget = (t) => {
      if (t && !seen.has(t)) {
        seen.add(t);
        next.push(t);
      }
    };
    if (outlineEnabled) {
      for (const hash of Object.keys(lastAnswers)) {
        const a = lastAnswers[hash];
        if (!a || a.error || a.answerIndex == null) continue;
        const els = lastOptionEls.get(hash);
        if (!els) continue;
        const idxs = Array.isArray(a.answerIndex)
          ? a.answerIndex
          : [a.answerIndex];
        for (const i of idxs) addTarget(outlineTarget(els[Number(i)]));
      }
    }
    for (const el of markedEls) {
      if (!seen.has(el) && el.isConnected) {
        try {
          el.classList.remove("mcq-helper-correct");
        } catch (e) {}
      }
    }
    for (const el of next) el.classList.add("mcq-helper-correct");
    markedEls = next;
  }

  function lcaTwo(a, b) {
    if (!a || !b) return a || b || null;
    if (a === b) return a;
    if (a.contains(b)) return a;
    if (b.contains(a)) return b;
    let p = a.parentElement;
    while (p && !p.contains(b)) p = p.parentElement;
    return p;
  }

  function lcaOf(els) {
    const list = els.filter(Boolean);
    if (!list.length) return null;
    let acc = list[0];
    for (let i = 1; i < list.length; i++) {
      acc = lcaTwo(acc, list[i]);
      if (!acc) return null;
    }
    return acc;
  }

  const FOCUS_CLS = "mcq-helper-focus";

  function applyFocusClass() {
    const root = focusHash ? lastRoots.get(focusHash) : null;
    try {
      document
        .querySelectorAll("." + FOCUS_CLS)
        .forEach((e) => {
          if (e !== root) e.classList.remove(FOCUS_CLS);
        });
    } catch (e) {}
    if (root && root.isConnected) root.classList.add(FOCUS_CLS);
  }

  function applySolo() {
    for (const entry of lastRoots) {
      const root = entry[1];
      if (!root || !root.isConnected) continue;
      const shouldVanish = soloOn && entry[0] !== focusHash;
      const has = root.classList.contains(VANISH_CLS);
      if (shouldVanish && !has) root.classList.add(VANISH_CLS);
      else if (!shouldVanish && has) root.classList.remove(VANISH_CLS);
    }
    try {
      const body = document.body;
      if (!body) return;
      const bHas = body.classList.contains(SOLO_BODY_CLS);
      if (soloOn && !bHas) body.classList.add(SOLO_BODY_CLS);
      else if (!soloOn && bHas) body.classList.remove(SOLO_BODY_CLS);
    } catch (e) {}
  }

  function applyVisuals() {
    applyFocusClass();
    applySolo();
  }

  function setFocus(hash) {
    if (!hash || hash === focusHash) return;
    focusHash = hash;
    applyVisuals();
    const root = lastRoots.get(hash);
    if (root) {
      try {
        root.scrollIntoView({ block: "nearest" });
      } catch (e) {}
    }
  }

  function isAnswered(hash) {
    const els = lastOptionEls.get(hash) || [];
    for (const el of els) {
      try {
        if (el.type === "radio" || el.type === "checkbox") {
          if (el.checked) return true;
          continue;
        }
        if (
          el.getAttribute("aria-pressed") === "true" ||
          el.getAttribute("aria-checked") === "true"
        )
          return true;
        const cls = typeof el.className === "string" ? el.className : "";
        if (/(^|[\s-])(selected|active|checked|chosen|current)([\s-]|$)/.test(cls))
          return true;
      } catch (e) {}
    }
    return false;
  }

  function advanceFocus(fromHash) {
    const i = orderedHashes.indexOf(fromHash);
    if (i === -1) return;
    for (let j = i + 1; j < orderedHashes.length; j++) {
      if (!isAnswered(orderedHashes[j])) {
        setFocus(orderedHashes[j]);
        return;
      }
    }
    if (i + 1 < orderedHashes.length) setFocus(orderedHashes[i + 1]);
  }

  function moveFocus(dir) {
    const i = orderedHashes.indexOf(focusHash);
    if (i === -1) {
      if (orderedHashes.length) setFocus(orderedHashes[0]);
      return;
    }
    const j = i + dir;
    if (j >= 0 && j < orderedHashes.length) setFocus(orderedHashes[j]);
  }

  function allQuestionsAnswered() {
    for (const hash of orderedHashes) if (!isAnswered(hash)) return false;
    return orderedHashes.length > 0;
  }

  function triggerAutoSubmit() {
    if (submitting || !autoSubmitOnComplete) return;
    const first = findSubmitBtn(null, false);
    if (first) runSubmitSequence(first, null);
  }

  function flash(el) {
    try {
      const t = outlineTarget(el) || el;
      t.classList.add("mcq-helper-flash");
      setTimeout(() => t.classList.remove("mcq-helper-flash"), 650);
    } catch (e) {}
  }

  function selectOption(el) {
    if (!el || el.disabled) return false;
    try {
      el.click();
    } catch (e) {
      return false;
    }
    flash(el);
    return true;
  }

  function wrongFlash(el) {
    try {
      const t = outlineTarget(el) || el;
      t.classList.add("mcq-helper-wrong");
      setTimeout(() => t.classList.remove("mcq-helper-wrong"), 550);
    } catch (e) {}
  }

  function allSelected(hash, idxs) {
    const els = lastOptionEls.get(hash) || [];
    return idxs.every((i) => {
      const el = els[i];
      if (!el) return false;
      if (el.tagName === "INPUT") return !!el.checked;
      return true;
    });
  }

  function isTextEntry() {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement)
      return false;
    const t = a.tagName;
    if (t === "TEXTAREA" || t === "SELECT" || a.isContentEditable) return true;
    if (t === "INPUT") {
      const type = (a.getAttribute("type") || "text").toLowerCase();
      if (
        type === "radio" ||
        type === "checkbox" ||
        type === "submit" ||
        type === "button" ||
        type === "reset" ||
        type === "range" ||
        type === "file" ||
        type === "color" ||
        type === "image"
      )
        return false;
      return true;
    }
    return false;
  }

  const SUBMIT_STRICT =
    /^(submit|confirm|finish|finali[sz]e|lock\s*in|save\s*(answer|progress)|جاری|تصدیق|جمع)/i;
  const SUBMIT_LOOSE =
    /^(submit|confirm|yes|ok|done|proceed|continue|finish|finali[sz]e|verify|agree|accept|جاری|تصدیق|جمع|اجازت|تائید|قفل|بند)/i;
  const DIALOG_SEL =
    '[role="dialog"],dialog,.modal,[class*="modal" i],[class*="popup" i],[class*="dialog" i]';

  function findSubmitBtn(exclude, loose) {
    try {
      const cands = [];
      for (const el of document.querySelectorAll(
        'button,input[type="submit"],[role="button"]'
      )) {
        if (exclude && exclude.has(el)) continue;
        if (el.disabled) continue;
        try {
          if (isHidden(el)) continue;
        } catch (e) {
          continue;
        }
        const t = norm(
          el.textContent || el.value || el.getAttribute("aria-label") || ""
        );
        if (!t) continue;
        const inDialog = !!el.closest(DIALOG_SEL);
        const re = loose ? SUBMIT_LOOSE : SUBMIT_STRICT;
        if (re.test(t)) cands.push({ el, inDialog });
      }
      cands.sort((a, b) => Number(b.inDialog) - Number(a.inDialog));
      if (cands.length) return cands[0].el;
    } catch (e) {}
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForSubmit(exclude, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const b = findSubmitBtn(exclude, true);
      if (b) return b;
      await sleep(120);
    }
    return null;
  }

  function runSubmitSequence(first, e) {
    if (submitting || !first) return false;
    if (e) e.preventDefault();
    submitting = true;
    const clicked = new Set();
    (async () => {
      try {
        try { first.click(); } catch (err) {}
        clicked.add(first);
        flash(first);
        const t0 = Date.now();
        let confirmBtn = null;
        while (!confirmBtn && Date.now() - t0 < 2000) {
          confirmBtn = findSubmitBtn(clicked, true);
          if (!confirmBtn) await sleep(50);
        }
        if (confirmBtn) {
          try { confirmBtn.click(); } catch (err) {}
          clicked.add(confirmBtn);
          flash(confirmBtn);
        }
      } finally {
        submitting = false;
      }
    })();
    return true;
  }

  const onClickCapture = (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    let matched = false;
    if (lastOptionEls.size) {
      for (const entry of lastOptionEls) {
        const hash = entry[0];
        const els = entry[1];
        for (const el of els) {
          if (el === t || el.contains(t)) {
            setFocus(hash);
            matched = true;
            break;
          }
          const lbl = el.labels && el.labels[0];
          if (lbl && (lbl === t || lbl.contains(t))) {
            setFocus(hash);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        for (const entry of lastRoots) {
          const root = entry[1];
          if (root && (root === t || root.contains(t))) {
            setFocus(entry[0]);
            matched = true;
            break;
          }
        }
      }
    }
    if (matched && e.isTrusted && autoSubmitOnComplete && allQuestionsAnswered())
      triggerAutoSubmit();
  };
  document.addEventListener("click", onClickCapture, true);

  const onKeyCapture = (e) => {
      if (!lastOptionEls.size) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntry()) return;
      if (submitting) {
        if (e.key === "Enter") e.preventDefault();
        return;
      }
      let digit = /^Digit([0-9])$/.exec(e.code || "");
      if (!digit) digit = /^Numpad([0-9])$/.exec(e.code || "");
      if (!digit && /^[0-9]$/.test(e.key || "")) digit = [e.key, e.key];
      if (digit) {
        if (!focusHash) return;
        const n = Number(digit[1]);
        const idx = n === 0 || n >= 5 ? 3 : n - 1;
        const els = lastOptionEls.get(focusHash);
        const el = els && els[idx];
        if (!el) return;
        e.preventDefault();
        const row = lastAnswers[focusHash];
        const ans =
          row && !row.error && row.answerIndex != null
            ? row.answerIndex
            : null;
        if (ans == null || !outlineEnabled) {
          if (selectOption(el)) {
            advanceFocus(focusHash);
            if (e.isTrusted && autoSubmitOnComplete) triggerAutoSubmit();
          }
          return;
        }
        const idxs = (Array.isArray(ans) ? ans : [ans]).map(Number);
        if (idxs.indexOf(idx) !== -1) {
          if (selectOption(el)) {
            const firstEl = els[idxs[0]];
            const isRadio =
              firstEl && firstEl.tagName === "INPUT" && firstEl.type === "radio";
            if (!Array.isArray(ans) || isRadio || allSelected(focusHash, idxs))
              advanceFocus(focusHash);
            if (e.isTrusted && autoSubmitOnComplete) triggerAutoSubmit();
          }
          return;
        }
        const wkey = focusHash + ":" + idx;
        const now = Date.now();
        if (
          lastWrongPress &&
          lastWrongPress.key === wkey &&
          now - lastWrongPress.ts < 1500
        ) {
          lastWrongPress = null;
          if (selectOption(el)) {
            advanceFocus(focusHash);
            if (e.isTrusted && autoSubmitOnComplete) triggerAutoSubmit();
          }
          return;
        }
        lastWrongPress = { key: wkey, ts: now };
        wrongFlash(el);
        return;
      }
      const si = "asdfgh".indexOf((e.key || "").toLowerCase());
      if (si >= 0) {
        if (si < subjectCount) {
          e.preventDefault();
          solveSubject(si);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter") {
        const first = findSubmitBtn(null, false);
        if (first) runSubmitSequence(first, e);
      }
  };
  document.addEventListener("keydown", onKeyCapture, true);

  function contextAlive() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime) return false;
      if (typeof chrome.runtime.getPlatformInfo !== "function") return true;
      if (!chrome.runtime.id) return false;
      chrome.runtime.getPlatformInfo(() => {});
      return true;
    } catch (e) {
      return false;
    }
  }

  function teardown() {
    try {
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("keydown", onKeyCapture, true);
    } catch (e) {}
    try {
      observer.disconnect();
    } catch (e) {}
    try {
      clearTimeout(extractTimer);
    } catch (e) {}
    try {
      clearInterval(pollInterval);
      clearInterval(selfCheckInterval);
    } catch (e) {}
    try {
      clearOutlines();
      document
        .querySelectorAll(".mcq-helper-focus,.mcq-helper-flash,.mcq-helper-wrong,.mcq-helper-vanish")
        .forEach((e) => {
          e.classList.remove(
            "mcq-helper-focus",
            "mcq-helper-flash",
            "mcq-helper-wrong",
            "mcq-helper-vanish"
          );
        });
      if (document.body)
        document.body.classList.remove("mcq-helper-solo");
    } catch (e) {}
    try {
      if (onSoloStorage && chrome.storage && chrome.storage.onChanged)
        chrome.storage.onChanged.removeListener(onSoloStorage);
    } catch (e) {}
    try {
      window.__MCQ_HELPER_V1__ = false;
    } catch (e) {}
  }

  const selfCheckInterval = setInterval(() => {
    if (!contextAlive()) teardown();
  }, 1500);

  function extractAll() {
    const qs = [];
    const used = new Set();
    for (const g of collectRadioGroups()) {
      const type = g[0].type === "checkbox" ? "checkbox" : "radio";
      const q = buildFromGroup(g, type);
      if (!q) continue;
      q._els.forEach((e) => used.add(e));
      qs.push(q);
    }
    for (const q of collectButtonGroups(used)) qs.push(q);

    const byHash = new Map();
    for (const q of qs) if (!byHash.has(q.hash)) byHash.set(q.hash, q);
    const list = [...byHash.values()];
    list.forEach((q) => {
      try {
        q._els[0].setAttribute(ATTRIBUTE, q.hash);
      } catch (e) {}
      let top = null;
      try {
        const r = q._els[0].getBoundingClientRect();
        if (r.height || r.width) top = r.top + window.scrollY;
      } catch (e) {}
      if (top == null) top = lastTops.has(q.hash) ? lastTops.get(q.hash) : 0;
      lastTops.set(q.hash, top);
      q.top = top;
    });
    list.sort((a, b) => a.top - b.top);
    lastOptionEls = new Map(list.map((q) => [q.hash, q._els]));
    orderedHashes = [];
    lastRoots = new Map();
    for (const q of list) {
      let root = null;
      try {
        root = lcaOf([q._stem, ...q._els].filter(Boolean));
      } catch (e) {}
      lastRoots.set(q.hash, root);
      orderedHashes.push(q.hash);
    }
    if (Object.keys(lastAnswers).length) applyOutlines(lastAnswers);
    if (
      focusHash &&
      (!lastRoots.get(focusHash) || !lastRoots.get(focusHash).isConnected)
    )
      focusHash = null;
    if (!focusHash && list.length) focusHash = list[0].hash;
    lastQuestionsMap = new Map(list.map((q) => [q.hash, { hash: q.hash, type: q.type, text: q.text, options: q.options.map((o) => o.text) }]));
    try { buildSubjectIndex(); } catch (e) { lastSubjectIndex = new Map(); subjectCount = 0; }
    try { applyVisuals(); } catch (e) {}
    return list.map((q, i) => ({
      index: i + 1,
      hash: q.hash,
      text: q.text,
      type: q.type,
      options: q.options.map((o, j) => ({ index: j, text: o.text })),
    }));
  }

  function safeSend(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {}
  }

  function emit() {
    let questions;
    try {
      questions = extractAll();
    } catch (e) {
      return;
    }
    const payload = JSON.stringify(questions);
    if (payload === lastSignature) return;
    lastSignature = payload;
    safeSend({ type: "QUESTIONS_UPDATE", questions });
  }

  function scheduleExtract() {
    clearTimeout(extractTimer);
    extractTimer = setTimeout(emit, EXTRACT_DEBOUNCE_MS);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") {
        scheduleExtract();
        return;
      }
      if (
        m.type === "attributes" &&
        WATCHED_ATTRS.indexOf(m.attributeName) !== -1
      ) {
        scheduleExtract();
        return;
      }
      if (
        m.type === "childList" &&
        (m.addedNodes.length || m.removedNodes.length)
      ) {
        scheduleExtract();
        return;
      }
    }
  });
  const pollInterval = setInterval(() => {
    try {
      emit();
    } catch (e) {}
  }, POLL_MS);

  function start() {
    if (!document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRS,
    });
    emit();
  }

  function registerListener() {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "PING_CONTENT") {
          let questions;
          try {
            questions = extractAll();
          } catch (e) {
            questions = [];
          }
          lastSignature = JSON.stringify(questions);
          safeSend({ type: "QUESTIONS_UPDATE", questions });
          sendResponse({ questions });
          return true;
        }
        if (msg.type === "APPLY_OUTLINES") {
          outlineEnabled = msg.enabled !== false;
          applyOutlines(msg.answers || {});
          sendResponse({ ok: true });
          return true;
        }
        if (msg.type === "CLEAR_OUTLINES") {
          lastAnswers = {};
          clearOutlines();
          sendResponse({ ok: true });
          return true;
        }
      });
    } catch (e) {}
  }
  registerListener();

  try {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ soloMode: true, autoSubmitOnComplete: true }, (cfg) => {
        try {
          soloOn = !cfg || cfg.soloMode !== false;
          autoSubmitOnComplete = cfg.autoSubmitOnComplete !== false;
          applyVisuals();
        } catch (e) {}
      });
      if (chrome.storage.onChanged) {
        onSoloStorage = (changes, area) => {
          if (area !== "local") return;
          if (changes.soloMode !== undefined)
            soloOn = changes.soloMode.newValue !== false;
          if (changes.autoSubmitOnComplete !== undefined)
            autoSubmitOnComplete = changes.autoSubmitOnComplete.newValue !== false;
          try {
            applyVisuals();
          } catch (e) {}
        };
        chrome.storage.onChanged.addListener(onSoloStorage);
      }
    }
  } catch (e) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
