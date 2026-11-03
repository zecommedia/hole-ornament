// Zecom Product Swap — Content Script (Batch mode)
// All pairs in a single Flow project:
//   1. Ensure in 1 project (create if needed)
//   2. Pre-upload ALL unique images at once (parallel via multi-file DataTransfer)
//   3. For each pair: select 2 images from gallery → fill prompt → submit
//   4. Wait for all tiles to finish (parallel server-side generation)
//   5. Download each tile with proper naming

(() => {
  if (window.__zpsInjected) return;
  window.__zpsInjected = true;

  // ====================================================================
  // Icon names (Material Symbols) used by Flow UI
  // ====================================================================
  const ICONS = {
    add: "add_2",
    crop: "crop",
    tune: "tune",
    arrowDropDown: "arrow_drop_down",
    arrowForward: "arrow_forward",
    download: "download",
    check: "check",
    image: "image",
    moreVert: "more_vert",
    settings: "settings_2",
  };

  // ====================================================================
  // Logging
  // ====================================================================
  function log(jobId, ...args) {
    console.log("[zps]", jobId || "-", ...args);
    chrome.runtime
      .sendMessage({ type: "JOB_LOG", jobId, message: args.map(String).join(" ") })
      .catch(() => {});
  }

  // ====================================================================
  // Generic DOM helpers
  // ====================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => ms * (0.6 + 0.8 * Math.random());
  const jSleep = (ms) => sleep(jitter(ms));

  // Type text into the focused editable in small chunks so it looks like a
  // person at the keyboard, not a paste. Uses CDP Input.insertText when
  // available (proper Flow input handling), falls back to execCommand. Adds
  // small per-chunk jitter plus an occasional longer "thinking" pause.
  async function humanType(text) {
    let i = 0;
    while (i < text.length) {
      const chunk = 4 + Math.floor(Math.random() * 5); // 4-8 chars
      const piece = text.slice(i, i + chunk);
      if (currentSettings.cdpInput) {
        await chrome.runtime
          .sendMessage({ type: "CDP_INSERT_TEXT", text: piece })
          .catch(() => null);
      } else {
        document.execCommand("insertText", false, piece);
      }
      i += chunk;
      let delay = 15 + Math.random() * 35; // 15-50ms between chunks
      if (Math.random() < 0.03) delay += 150 + Math.random() * 250; // rare pause
      await sleep(delay);
    }
  }

  function isVisible(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    return true;
  }
  function isClickable(el) {
    if (!isVisible(el)) return false;
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") return false;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0) return false;
    if (r.bottom > (window.innerHeight || document.documentElement.clientHeight)) return false;
    return true;
  }

  function findByIcon(iconName, { tag = "button", root = document } = {}) {
    const out = [];
    for (const el of root.querySelectorAll(tag)) {
      for (const i of el.querySelectorAll("i")) {
        if (i.textContent.trim() === iconName) {
          out.push(el);
          break;
        }
      }
    }
    return out;
  }
  function firstByIcon(iconName, opts) {
    return findByIcon(iconName, opts).find(isVisible) || null;
  }

  async function waitFor(predicate, { timeout = 30000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = predicate();
        if (v && (!Array.isArray(v) || v.length > 0)) return v;
      } catch {}
      await sleep(interval);
    }
    return null;
  }

  let currentSettings = {};

  // Click via CDP at 25% from left, 50% from top (mirrors VEO Automation).
  async function clickEl(el, { jobId, label = "click", timeout = 5000, interval = 100 } = {}) {
    if (!el) {
      log(jobId, `${label}: no element`);
      return false;
    }
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (isClickable(el)) {
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + 0.25 * r.width);
        const y = Math.round(r.top + r.height / 2);
        if (currentSettings.cdpInput) {
          await chrome.runtime.sendMessage({ type: "CDP_CLICK", x, y }).catch(() => null);
        } else {
          ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) =>
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y }))
          );
        }
        await sleep(300);
        return true;
      }
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
      await sleep(interval);
    }
    log(jobId, `${label}: not clickable in ${timeout}ms`);
    return false;
  }

  async function waitClickable(finder, { timeout = 5000, interval = 100 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const el = finder();
        if (el && isClickable(el)) {
          await sleep(200);
          return el;
        }
      } catch {}
      await sleep(interval);
    }
    return null;
  }

  async function waitForReactHydrated(jobId, { maxMs = 20000 } = {}) {
    const start = Date.now();
    let last = -1;
    let stable = 0;
    while (Date.now() - start < maxMs) {
      const c =
        document.querySelectorAll("button,[role='button']").length +
        document.querySelectorAll('div[role="textbox"]').length;
      if (c > 0 && c === last) {
        stable++;
        if (stable >= 3) return;
      } else stable = 0;
      last = c;
      await sleep(200);
    }
    log(jobId, "hydration wait timed out");
  }

  // ====================================================================
  // Project navigation
  // ====================================================================
  function isInProject() {
    return /\/tools\/flow\/project\//.test(location.pathname);
  }

  async function ensureInsideProject(jobId) {
    if (isInProject()) {
      log(jobId, "already inside project:", location.href);
      return;
    }
    log(jobId, "creating new project");
    const fromHref = location.href;

    const candidates = findByIcon(ICONS.add);
    if (!candidates.length) throw new Error("'Create new' button not found on home");
    await clickEl(candidates[0], { jobId, label: "create project" });

    const ok = await waitFor(() => location.href !== fromHref && isInProject(), {
      timeout: 15000,
    });
    if (!ok) throw new Error("project creation did not navigate");
    log(jobId, "project ready:", location.href);
    await sleep(3000);
    await waitForReactHydrated(jobId);
  }

  // ====================================================================
  // Generation settings — aspect ratio, image model
  // ====================================================================

  // Map internal value -> display labels Flow uses on the aspect-ratio chips.
  // `exact` matches are required for ratio text (so "1:1" doesn't bleed into other
  // text). `loose` matches are used as a last resort.
  const ASPECT_LABELS = {
    "1:1": { exact: ["1:1", "1 : 1"], loose: ["square"] },
    "16:9": { exact: ["16:9", "16 : 9"], loose: ["landscape", "wide"] },
    "9:16": { exact: ["9:16", "9 : 16"], loose: ["portrait", "vertical"] },
    "4:3": { exact: ["4:3", "4 : 3"], loose: [] },
    "3:4": { exact: ["3:4", "3 : 4"], loose: [] },
  };
  // Each model maps to an array of acceptable display labels. Matching is done
  // on normalized text (lowercase, hyphens→spaces, collapsed whitespace), so
  // "Nano-Banana Pro 2" matches the candidate "nano banana pro".
  // IMPORTANT: order candidates from most specific to least — "nano banana pro"
  // must come BEFORE "nano banana" (substring match would otherwise let
  // selecting "nano-banana" pick the Pro version by accident, and vice versa).
  const MODEL_LABELS = {
    "nano-banana": ["nano banana 2", "nano banana"],
    "nano-banana-pro": ["nano banana pro", "nanobananapro"],
    "imagen-3": ["imagen 3", "imagen3"],
    "imagen-4": ["imagen 4", "imagen4"],
    "omni-flash": ["omni flash", "omniflash"],
    "veo-3-fast": ["veo 3 fast", "veo3fast"],
  };

  // Other models the matcher must REJECT when looking for a given target —
  // prevents substring "nano banana" from clicking "Nano Banana Pro" (or vice
  // versa).
  const MODEL_ANTI_LABELS = {
    "nano-banana": ["nano banana pro"],
    "nano-banana-pro": [],
    "imagen-3": ["imagen 30", "imagen 3xl"], // future-proof
    "imagen-4": [],
    "omni-flash": [],
    "veo-3-fast": [],
  };

  function normText(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Data-attribute slug variants Flow's selectors are known to use. Example:
  // sample extension's template was `aspect-ratio-{aspectRatio}` with ":" → "_",
  // so "16:9" → ["16_9", "16-9", "16:9"].
  function ratioSlugs(ratio) {
    return [ratio.replace(":", "_"), ratio.replace(":", "-"), ratio];
  }

  // Material Symbols icons render their NAME as the element's text content (e.g.
  // `<i>crop_square</i>` literally contains "crop_square"). When that icon sits
  // inside a button, `button.textContent` is "crop_square1:1" — the icon name
  // bleeds into our text-match. cleanText strips out every <i> descendant first.
  function cleanText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    for (const i of clone.querySelectorAll("i")) i.remove();
    return (clone.textContent || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function elText(el) {
    return ((el.getAttribute?.("aria-label") || "") + " " + cleanText(el))
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  const QUERYABLE_ROLES =
    'button, [role="button"], [role="radio"], [role="menuitemradio"], [role="menuitem"], [role="option"], [role="tab"]';

  // Strict exact-text match — the element's clean text or aria-label EQUALS one
  // of the candidates. Prevents "1:1" from matching "crop_square1:1".
  function findButtonByExact(candidates, root = document) {
    const cands = candidates.map((c) => c.toLowerCase());
    const buttons = [...root.querySelectorAll(QUERYABLE_ROLES)];
    return (
      buttons.find((b) => {
        if (!isVisible(b)) return false;
        const text = cleanText(b);
        const aria = (b.getAttribute("aria-label") || "").trim().toLowerCase();
        return cands.includes(text) || cands.includes(aria);
      }) || null
    );
  }

  // Substring text/aria-label match — used as last resort.
  function findButtonByLabel(candidates, root = document) {
    const cands = candidates.map((c) => c.toLowerCase());
    const buttons = [...root.querySelectorAll(QUERYABLE_ROLES)];
    return (
      buttons.find((b) => {
        if (!isVisible(b)) return false;
        const t = elText(b);
        return cands.some((c) => t.includes(c));
      }) || null
    );
  }

  // Match by data-attribute or id slug, e.g. data-test-id="aspect-ratio-16_9".
  function findBySlug(slugs, root = document) {
    const selectors = [];
    for (const s of slugs) {
      for (const attr of ["data-test-id", "data-testid", "data-aspect-ratio", "data-value", "id"]) {
        selectors.push(`[${attr}*="${s}" i]`);
      }
    }
    for (const sel of selectors) {
      try {
        const candidates = document.querySelectorAll(sel);
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          // Walk up to nearest button-like ancestor
          const btn = el.closest('button, [role="button"], [role="radio"], [role="menuitemradio"], [role="menuitem"], [role="option"], [role="tab"]') || el;
          if (isVisible(btn)) return btn;
        }
      } catch {}
    }
    return null;
  }

  // The real generation-config chip lives in the prompt bar. It always contains
  // a Material Symbols icon whose name starts with `crop_` (e.g. crop_square,
  // crop_landscape, crop_portrait, crop_free) — that icon visually represents
  // the currently selected aspect ratio. We anchor on that.
  //
  // settings_2 / tune look promising at first glance but on Flow they open
  // unrelated panels (grid display, etc.), so they're NOT in this list.
  function findConfigButton() {
    // Strategy 1: the prompt-chip button containing a crop_* icon. This is the
    // most reliable anchor.
    const buttons = [...document.querySelectorAll('button, [role="button"]')];
    for (const b of buttons) {
      if (!isVisible(b)) continue;
      for (const i of b.querySelectorAll("i")) {
        const n = (i.textContent || "").trim();
        if (/^crop_/.test(n)) return { btn: b, icon: n };
      }
    }
    // Strategy 2: button whose visible text contains a known model name AND an
    // output-count hint like "1x"/"2x". Covers Flow re-skins that drop the
    // crop icon.
    for (const b of buttons) {
      if (!isVisible(b)) continue;
      const t = elText(b);
      const hasModel = Object.values(MODEL_LABELS).some((labels) =>
        labels.some((l) => t.includes(l.toLowerCase()))
      );
      if (hasModel && /\b\d+x\b/.test(t)) return { btn: b, icon: "model+count" };
    }
    return null;
  }

  // Heuristic: the config panel is open if we can see an aspect-ratio chip with
  // exact "1:1" / "16:9" / etc text. Substring/loose match is too eager (Flow has
  // unrelated labels containing words like "landscape").
  function configPanelIsOpen() {
    for (const labels of Object.values(ASPECT_LABELS)) {
      if (findButtonByExact(labels.exact)) return true;
    }
    for (const ratio of Object.keys(ASPECT_LABELS)) {
      if (findBySlug(ratioSlugs(ratio))) return true;
    }
    return false;
  }

  let lastConfigIcon = null;
  let lastConfigBtn = null;

  async function openConfigPanel(jobId) {
    if (configPanelIsOpen()) {
      log(jobId, "config: panel already open");
      lastConfigIcon = null;
      lastConfigBtn = null;
      return true;
    }
    const found = findConfigButton();
    if (!found) {
      log(jobId, `config: button not found (tried ${CONFIG_ICON_CANDIDATES.join(", ")} + label match)`);
      // Diagnostic: dump every Material Symbol icon name on visible buttons,
      // so we can identify the right candidate next time.
      const seen = new Set();
      for (const b of document.querySelectorAll('button, [role="button"]')) {
        if (!isVisible(b)) continue;
        for (const i of b.querySelectorAll("i")) {
          const n = (i.textContent || "").trim();
          if (n && n.length < 40) seen.add(n);
        }
      }
      log(jobId, `config: visible button icons on page = [${[...seen].join(", ")}]`);
      return false;
    }
    lastConfigIcon = found.icon;
    lastConfigBtn = found.btn;
    log(jobId, `config: opening via icon "${found.icon}"`);
    await clickEl(found.btn, { jobId, label: "open config panel" });
    // Wait until aspect-ratio chips actually appear; otherwise subsequent
    // selectAspectRatio races against an empty DOM.
    const ok = await waitFor(() => configPanelIsOpen(), {
      timeout: 4000,
      interval: 200,
    });
    if (!ok) log(jobId, "config: panel button clicked but aspect chips never appeared");
    return true;
  }

  async function closeConfigPanel(jobId) {
    if (!lastConfigIcon) return; // controls were inline — nothing to close
    // Flow may have already auto-closed the popover after a chip click.
    if (!configPanelIsOpen()) {
      log(jobId, "config: panel already auto-closed");
      lastConfigIcon = null;
      lastConfigBtn = null;
      return;
    }
    const found = findConfigButton();
    if (found && isClickable(found.btn)) {
      await clickEl(found.btn, { jobId, label: "close config panel" });
    } else {
      await pressEscape();
    }
    lastConfigIcon = null;
    lastConfigBtn = null;
    await sleep(400);
  }

  function dumpButtons(jobId, label, root = document) {
    const out = [];
    const seen = new Set();
    for (const b of root.querySelectorAll(QUERYABLE_ROLES)) {
      if (!isVisible(b)) continue;
      const text = cleanText(b).slice(0, 50);
      const aria = (b.getAttribute("aria-label") || "").slice(0, 50);
      const tid = b.getAttribute("data-test-id") || b.getAttribute("data-testid") || "";
      const id = b.id || "";
      const icons = [...b.querySelectorAll("i")]
        .map((i) => (i.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(",");
      const key = `${text}|${aria}|${tid}|${id}|${icons}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = [];
      if (text) parts.push(`"${text}"`);
      if (icons) parts.push(`icon=[${icons}]`);
      if (aria && aria.toLowerCase() !== text) parts.push(`aria="${aria}"`);
      if (tid) parts.push(`tid="${tid}"`);
      if (id) parts.push(`id="${id}"`);
      if (parts.length) out.push(parts.join(" "));
    }
    log(jobId, `${label} (${out.length} elements):`);
    for (const line of out.slice(0, 50)) log(jobId, "  " + line);
  }

  async function selectAspectRatio(jobId, ratio) {
    const labels = ASPECT_LABELS[ratio] || { exact: [ratio], loose: [] };
    const slugs = ratioSlugs(ratio);

    const finder = () =>
      findBySlug(slugs) ||
      findButtonByExact(labels.exact) ||
      (labels.loose.length ? findButtonByLabel(labels.loose) : null);

    const target = await waitFor(finder, { timeout: 5000, interval: 200 });
    if (!target) {
      log(jobId, `aspect ratio button not found for ${ratio} — dumping buttons:`);
      dumpButtons(jobId, "aspect-ratio dump");
      return false;
    }
    await clickEl(target, { jobId, label: `aspect ${ratio}` });
    await sleep(400);
    return true;
  }

  async function selectImageModel(jobId, model) {
    const candidates = (MODEL_LABELS[model] || [model]).map(normText);
    const antiLabels = (MODEL_ANTI_LABELS[model] || []).map(normText);

    // Substring match on normalized text, but rejecting any text that ALSO
    // contains an anti-label. Example: target="nano-banana", anti-labels=
    // ["nano banana pro"]. A button with text "nano banana pro 2" contains
    // "nano banana" but also "nano banana pro" → rejected (good).
    function matches(text) {
      if (!text) return false;
      if (antiLabels.some((a) => text.includes(a))) return false;
      return candidates.some((c) => text.includes(c));
    }

    function findModelOption(root = document) {
      const buttons = [...root.querySelectorAll(QUERYABLE_ROLES)];
      // Prefer exact-text match first
      let hit = buttons.find((b) => {
        if (!isVisible(b) || b === lastConfigBtn) return false;
        const text = normText(cleanText(b));
        const aria = normText(b.getAttribute("aria-label") || "");
        return candidates.includes(text) || candidates.includes(aria);
      });
      if (hit) return hit;
      // Fall back to substring with anti-label rejection
      return (
        buttons.find((b) => {
          if (!isVisible(b) || b === lastConfigBtn) return false;
          const text = normText(cleanText(b));
          const aria = normText(b.getAttribute("aria-label") || "");
          return matches(text) || matches(aria);
        }) || null
      );
    }

    let target = findModelOption();
    if (target) {
      log(jobId, `model match: "${cleanText(target).slice(0, 40)}"`);
      await clickEl(target, { jobId, label: `model ${model}` });
      await sleep(400);
      return true;
    }

    // Fallback: if Flow's popover uses a Select dropdown rather than visible
    // chips, click the dropdown trigger and look in the resulting menu. SCOPE
    // is restricted to the popover container — earlier we scanned the whole
    // document and accidentally clicked unrelated dropdowns (selecting
    // Imagen 4 by accident).
    const popover = findPopoverContainer();
    if (!popover) {
      log(jobId, `model option not found for ${model} (no popover container) — dumping buttons:`);
      dumpButtons(jobId, "model dump");
      return false;
    }
    const dropBtns = findByIcon(ICONS.arrowDropDown, { root: popover })
      .filter(isVisible)
      .filter((b) => b !== lastConfigBtn && !lastConfigBtn?.contains(b));
    for (const db of dropBtns) {
      await clickEl(db, { jobId, label: "open model dropdown" });
      await sleep(500);
      const menu = document.querySelector('div[role="menu"], div[role="listbox"]');
      const opt = menu ? findModelOption(menu) : null;
      if (opt) {
        log(jobId, `model match (via dropdown): "${cleanText(opt).slice(0, 40)}"`);
        await clickEl(opt, { jobId, label: `model ${model}` });
        await sleep(400);
        return true;
      }
      await pressEscape();
      await sleep(300);
    }
    log(jobId, `model option not found for ${model} — dumping buttons:`);
    dumpButtons(jobId, "model dump (popover scope)", popover);
    return false;
  }

  // Find the Radix popover that opened after we clicked the config chip.
  function findPopoverContainer() {
    return (
      document.querySelector('[data-radix-popper-content-wrapper] [data-state="open"]') ||
      document.querySelector('[data-radix-popper-content-wrapper]') ||
      document.querySelector('[role="dialog"][data-state="open"]') ||
      document.querySelector('[data-side][data-state="open"]') ||
      null
    );
  }

  // ====================================================================
  // Video mode helpers
  // ====================================================================
  // Flow exposes a mode switch somewhere near the prompt bar. The label
  // varies — could be a plain "Video" tab, or "Image to Video" / "Text to
  // Video" item in a dropdown. We try a few heuristics.
  // Mode tab toggle — Flow's IMAGE / VIDEO tabs live INSIDE the config
  // popover (not on the main page). Ids are stable as:
  //   id="radix-:r2v:-trigger-IMAGE"   data-state="active|inactive"
  //   id="radix-:r2v:-trigger-VIDEO"   data-state="active|inactive"
  // The selector `[id$="-trigger-IMAGE"]` excludes sub-tabs like
  // `-trigger-VIDEO_FRAMES` and `-trigger-VIDEO_REFERENCES` because those
  // ids end in `S`, not `O`.
  // mode = "IMAGE" | "VIDEO"
  async function ensureMode(jobId, mode) {
    const want = mode === "VIDEO" ? "VIDEO" : "IMAGE";
    const findTab = (m) => {
      let el = document.querySelector(`[id$="-trigger-${m}"]`);
      if (el) return el;
      // Fallback: any role=tab whose visible text matches
      const wantText = m === "VIDEO" ? ["video"] : ["hình ảnh", "image"];
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      return (
        tabs.find((t) => {
          const txt = cleanText(t);
          return wantText.some((w) => txt === w);
        }) || null
      );
    };
    const isActive = (el) =>
      el?.getAttribute("data-state") === "active" ||
      el?.getAttribute("aria-selected") === "true";

    // Quick check: if the tab is already in the DOM AND already active, skip
    // opening the popover.
    const inlineTab = findTab(want);
    if (inlineTab && isActive(inlineTab)) {
      log(jobId, `mode: already in ${want}`);
      return true;
    }

    // Tabs typically render only when the config popover is open — open it.
    const opened = await openConfigPanel(jobId);
    if (!opened) {
      log(jobId, `mode: cannot open config popover to switch to ${want}`);
      return false;
    }

    // Poll for the tab inside the popover
    const start = Date.now();
    let tab = null;
    while (Date.now() - start < 5000) {
      tab = findTab(want);
      if (tab) break;
      await sleep(200);
    }
    if (!tab) {
      log(jobId, `mode: ${want} tab not visible even after opening config — Flow UI may have changed`);
      await closeConfigPanel(jobId);
      return false;
    }

    if (isActive(tab)) {
      log(jobId, `mode: already in ${want} (was in popover)`);
      await closeConfigPanel(jobId);
      return true;
    }

    log(jobId, `mode: switching to ${want} (id="${tab.id || "?"}")`);
    await clickEl(tab, { jobId, label: `select ${want} mode` });
    await sleep(900);
    // Re-find — Radix re-mounts on state flip; also the panel content (chips,
    // dropdowns) may swap out as the panel re-renders for the new mode.
    const after = findTab(want);
    const ok = isActive(after);
    if (!ok) log(jobId, `mode: switch click did not flip ${want} to active`);
    else log(jobId, `mode: now in ${want}`);
    // Close so the caller (applyGenerationSettings / applyVideoSettings) can
    // re-open the popover cleanly against the new mode's chips.
    await closeConfigPanel(jobId);
    await sleep(400);
    return ok;
  }

  async function selectVideoMode(jobId) {
    // Preferred path: the explicit tablist toggle.
    if (await ensureMode(jobId, "VIDEO")) return true;
    // Fallback: very specific labels — bare "video" substring matches hit
    // model names like "Veo 3.1 Fast" accidentally.
    const exactCandidates = ["image to video", "text to video"];
    let target = findButtonByExact(exactCandidates);
    if (!target) target = findButtonByLabel(exactCandidates);
    if (target) {
      log(jobId, `video: switching mode via "${cleanText(target).slice(0, 40)}"`);
      await clickEl(target, { jobId, label: "select Video mode" });
      await sleep(700);
      return true;
    }
    log(jobId, "video: no explicit mode toggle found — assuming already in video mode");
    return true;
  }

  // Video mode model picker is a DROPDOWN inside the config popover, not a
  // chip. The trigger button shows the current model (e.g. "Veo 3.1 - Fast")
  // and has an arrow_drop_down icon. Clicking it opens a menu (which may
  // render in a separate Radix portal, NOT under role="menu"), where each
  // model option is a plain button with text like "Omni Flash".
  async function selectVideoModelInPopover(jobId, model) {
    const candidates = (MODEL_LABELS[model] || [model]).map(normText);
    const popover = findPopoverContainer();
    if (!popover) {
      log(jobId, "video model: no popover container");
      return false;
    }
    const popoverButtons = [...popover.querySelectorAll(QUERYABLE_ROLES)].filter(
      isVisible
    );

    // Find the dropdown trigger.
    //   A) preferred: button with an arrow_drop_down icon
    //   B) fallback: button whose visible text contains a known model name
    //      (the currently-selected model is shown on the trigger)
    let trigger = popoverButtons.find((b) => {
      if (b === lastConfigBtn) return false;
      return [...b.querySelectorAll("i")].some(
        (i) => (i.textContent || "").trim() === ICONS.arrowDropDown
      );
    });
    if (!trigger) {
      const allModelLabels = Object.values(MODEL_LABELS).flat().map(normText);
      trigger = popoverButtons.find((b) => {
        if (b === lastConfigBtn) return false;
        const t = normText(cleanText(b));
        return allModelLabels.some((l) => t.includes(l));
      });
    }
    if (!trigger) {
      log(jobId, "video model: dropdown trigger not found in popover");
      return false;
    }

    log(jobId, `video model: opening dropdown "${cleanText(trigger).slice(0, 40)}"`);
    // Snapshot buttons BEFORE opening so we can isolate the new ones added.
    const before = new Set(document.querySelectorAll(QUERYABLE_ROLES));
    await clickEl(trigger, { jobId, label: "open model dropdown" });
    await sleep(600);

    // Scan ALL of document for a NEW visible button matching the model name.
    // Flow renders its menu via a separate portal that doesn't always use
    // role="menu" / "listbox", so we can't restrict by role.
    const finder = () => {
      const all = [...document.querySelectorAll(QUERYABLE_ROLES)];
      // Prefer NEW buttons (added after opening dropdown); fall back to all.
      const pools = [all.filter((b) => !before.has(b)), all];
      for (const pool of pools) {
        const hit = pool.find((b) => {
          if (!isVisible(b)) return false;
          if (b === trigger || b === lastConfigBtn) return false;
          const t = normText(cleanText(b));
          const a = normText(b.getAttribute("aria-label") || "");
          if (candidates.includes(t) || candidates.includes(a)) return true;
          // Substring match — Omni Flash button text is exactly "Omni Flash"
          // so exact match should normally hit, but be lenient for variants.
          return candidates.some((c) => t === c || a === c || t.includes(c));
        });
        if (hit) return hit;
      }
      return null;
    };

    const option = await waitFor(finder, { timeout: 4000, interval: 200 });
    if (!option) {
      log(jobId, `video model: option "${model}" not found after opening dropdown`);
      dumpButtons(jobId, "model dropdown dump (whole doc)");
      await pressEscape();
      return false;
    }
    log(jobId, `video model: clicking option "${cleanText(option).slice(0, 40)}"`);
    await clickEl(option, { jobId, label: `select model ${model}` });
    await sleep(500);
    return true;
  }

  // Scan the entire visible UI for a model chip whose text/aria EXACTLY
  // matches one of the model's labels. In video mode, model chips live in
  // the sidebar (icon = volume_up) — they're NOT inside any popover.
  async function selectVideoModelDirect(jobId, model) {
    const candidates = (MODEL_LABELS[model] || [model]).map(normText);
    const antiLabels = (MODEL_ANTI_LABELS[model] || []).map(normText);
    const finder = () => {
      const buttons = [...document.querySelectorAll(QUERYABLE_ROLES)];
      // Exact match first
      let hit = buttons.find((b) => {
        if (!isVisible(b)) return false;
        const t = normText(cleanText(b));
        const a = normText(b.getAttribute("aria-label") || "");
        if (antiLabels.some((x) => t.includes(x) || a.includes(x))) return false;
        return candidates.includes(t) || candidates.includes(a);
      });
      if (hit) return hit;
      // Substring fallback with anti-label rejection
      return (
        buttons.find((b) => {
          if (!isVisible(b)) return false;
          const t = normText(cleanText(b));
          const a = normText(b.getAttribute("aria-label") || "");
          if (antiLabels.some((x) => t.includes(x) || a.includes(x))) return false;
          return candidates.some((c) => t.includes(c) || a.includes(c));
        }) || null
      );
    };
    const target = await waitFor(finder, { timeout: 4000, interval: 200 });
    if (!target) {
      log(jobId, `video: model "${model}" not visible directly`);
      return false;
    }
    log(jobId, `video: clicking model "${cleanText(target).slice(0, 40)}"`);
    await clickEl(target, { jobId, label: `model ${model}` });
    await sleep(500);
    return true;
  }

  async function setVideoDuration(jobId, seconds) {
    const wanted = [`${seconds}s`, `${seconds} s`, `${seconds} seconds`, `${seconds}sec`];
    const finder = () =>
      findButtonByExact(wanted) ||
      findButtonByLabel(wanted);
    const target = await waitFor(finder, { timeout: 4000, interval: 200 });
    if (!target) {
      log(jobId, `video: duration chip ${seconds}s not found`);
      return false;
    }
    log(jobId, `video: setting duration to ${seconds}s`);
    await clickEl(target, { jobId, label: `duration ${seconds}s` });
    await sleep(400);
    return true;
  }

  // Outputs/prompt chip — Flow shows these as "1x"/"2x"/"3x"/"4x" pills near
  // the duration row. Same chip pattern as duration: exact-text match wins.
  async function setVideoOutputs(jobId, n) {
    const wanted = [`${n}x`, `x${n}`, `${n} x`];
    const finder = () =>
      findButtonByExact(wanted) ||
      findButtonByLabel(wanted);
    const target = await waitFor(finder, { timeout: 4000, interval: 200 });
    if (!target) {
      log(jobId, `video: outputs chip ${n}x not found`);
      return false;
    }
    log(jobId, `video: setting outputs to ${n}x`);
    await clickEl(target, { jobId, label: `outputs ${n}x` });
    await sleep(400);
    return true;
  }

  async function applyVideoSettings(jobId) {
    const model = currentSettings.videoModel || "omni-flash";
    const durationRaw = Number(currentSettings.videoDuration) || 4;
    // 10s = combined-script mode → still set Flow duration to the longest
    // value Flow accepts. Clamp known values; otherwise pass through.
    const duration = [4, 6, 8, 10].includes(durationRaw) ? durationRaw : 4;
    const outputsRaw = Number(currentSettings.videoOutputs) || 1;
    const outputs = Math.max(1, Math.min(4, outputsRaw));

    log(jobId, `applying video settings: ${model} · 16:9 · ${duration}s · ${outputs}x`);

    // Step 1: model chip is in the sidebar (visible directly, not inside any
    // popover). Try direct scan first — that's where Flow renders model
    // buttons with the volume_up icon.
    let modelOk = await selectVideoModelDirect(jobId, model);

    // Step 2: aspect ratio + duration + outputs. Try direct first — some
    // Flow layouts show these inline as chips.
    let ratioOk = await selectAspectRatio(jobId, "16:9");
    let durOk = await setVideoDuration(jobId, duration);
    let outOk = outputs === 1 ? true : await setVideoOutputs(jobId, outputs);

    // Step 3: if anything failed, retry inside the config popover.
    if (!modelOk || !ratioOk || !durOk || !outOk) {
      const opened = await openConfigPanel(jobId);
      if (opened) {
        try {
          // Do chips FIRST — those won't close the popover. Model dropdown
          // click might collapse things, so save it for last.
          if (!ratioOk) ratioOk = await selectAspectRatio(jobId, "16:9");
          if (!durOk) durOk = await setVideoDuration(jobId, duration);
          if (!outOk && outputs !== 1) outOk = await setVideoOutputs(jobId, outputs);
          if (!modelOk) modelOk = await selectVideoModelInPopover(jobId, model);
        } catch (e) {
          log(jobId, "video settings popover error:", e instanceof Error ? e.message : String(e));
        } finally {
          await closeConfigPanel(jobId);
        }
      } else {
        log(jobId, "video: config popover unavailable — leaving missing settings as-is");
      }
    }

    log(jobId, `video settings result: model=${modelOk} ratio=${ratioOk} duration=${durOk} outputs=${outOk}`);
  }

  async function applyGenerationSettings(jobId) {
    const ratio = currentSettings.aspectRatio;
    const model = currentSettings.imageModel;
    const wantRatio = ratio && ratio !== "auto";
    const wantModel = model && model !== "auto";
    if (!wantRatio && !wantModel) {
      log(jobId, "generation settings: aspectRatio + model both auto, skipping");
      return;
    }

    log(jobId, `applying settings — aspectRatio=${ratio}, model=${model}`);
    const opened = await openConfigPanel(jobId);
    if (!opened) {
      log(jobId, "config panel did not open, settings skipped");
      return;
    }

    try {
      if (wantRatio) await selectAspectRatio(jobId, ratio);
      if (wantModel) await selectImageModel(jobId, model);
    } catch (e) {
      log(jobId, "settings apply error:", e instanceof Error ? e.message : String(e));
    } finally {
      await closeConfigPanel(jobId);
    }
  }

  // ====================================================================
  // Files
  // ====================================================================
  async function dataUrlToFile(dataUrl, filename) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], filename, { type: blob.type || "image/png" });
  }

  // Fetch a Flow tile URL → data URL.
  //
  // Why this is roundabout: MV3 content-script fetches run from the EXTENSION
  // origin (`chrome-extension://...`), NOT the page origin (`labs.google`).
  // So a direct fetch from here is cross-origin to labs.google → cookies don't
  // attach → trpc auth fails. We ask the SW to inject a MAIN-world script via
  // chrome.scripting; that script runs in the page's JS context with
  // labs.google as fetch origin, so `credentials:"same-origin"` works:
  //   • cookies sent on the initial labs.google trpc hop (auth OK)
  //   • cookies stripped on the cross-origin 302 to flow-content.google
  //     (whose `Access-Control-Allow-Origin: *` is valid only without creds)
  async function fetchTileToDataUrl(url) {
    const sw = await chrome.runtime.sendMessage({
      type: "FETCH_TILE_VIA_MAIN_WORLD",
      url,
    });
    if (!sw?.ok || !sw.dataUrl) {
      throw new Error(`fetch ref image: ${sw?.error || "unknown"}`);
    }
    return sw.dataUrl;
  }

  // ====================================================================
  // Image gallery — open dialog, manage uploads & selection
  // ====================================================================
  async function openAddImageDialog(jobId) {
    // Find the add image button — in a project there are typically 1-2
    // `add_2` icons. The first visible one in the prompt area is the
    // addImageButton.
    const btn = firstByIcon(ICONS.add);
    if (!btn) throw new Error("addImageButton not found");
    await clickEl(btn, { jobId, label: "open add-image dialog" });
    await sleep(600);

    // Wait for the dialog (data-side="top")
    const dialog = await waitFor(
      () => document.querySelector('div[data-side="top"]'),
      { timeout: 8000 }
    );
    if (!dialog) throw new Error("add-image dialog didn't open");

    // Click the "Upload" tab — has the `image` icon
    let uploadOpt = null;
    for (const b of dialog.querySelectorAll("button")) {
      for (const i of b.querySelectorAll("i")) {
        if (i.textContent.trim() === ICONS.image) {
          uploadOpt = b;
          break;
        }
      }
      if (uploadOpt) break;
    }
    if (uploadOpt) {
      await clickEl(uploadOpt, { jobId, label: "click Upload tab" });
      await sleep(500);
    }
    return dialog;
  }

  async function sortGalleryByLatest(jobId, dialog) {
    // Sort menu: last button with aria-haspopup="menu" in dialog
    const sortBtns = [...dialog.querySelectorAll('button[aria-haspopup="menu"]')];
    const sortBtn = sortBtns[sortBtns.length - 1];
    if (!sortBtn) return;
    await clickEl(sortBtn, { jobId, label: "open sort menu" });
    await sleep(300);
    const menu = document.querySelector('div[role="menu"]');
    if (menu) {
      const opts = [...menu.querySelectorAll("button")];
      const latest = opts[2] || opts[opts.length - 1];
      if (latest) {
        await clickEl(latest, { jobId, label: "sort by latest" });
        await sleep(400);
      }
    }
  }

  // Upload N files in one go using a multi-file DataTransfer.
  // Flow's <input type="file"> usually has `multiple`, so all files
  // queue up in the gallery in parallel.
  async function uploadFilesAtOnce(jobId, files) {
    log(jobId, `uploading ${files.length} file(s) in batch`);
    const dialog = await openAddImageDialog(jobId);

    // Sort by latest so new uploads appear at the top
    await sortGalleryByLatest(jobId, dialog);

    // Find the file input (now visible inside the dialog)
    const fileInput = await waitFor(
      () =>
        [...document.querySelectorAll('input[type="file"]')].find(
          (i) => i.accept === "" || /image/.test(i.accept || "")
        ),
      { timeout: 8000 }
    );
    if (!fileInput) throw new Error("file input not visible after opening upload");

    // Set ALL files in one DataTransfer (parallel upload to server)
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    log(jobId, "all files set on input, waiting for them to appear in gallery");

    // Wait for all files to land in the gallery list.
    // Each upload finishes independently; we poll until we see every file name.
    const wantedNames = new Set(files.map((f) => f.name));
    const seen = new Set();
    const start = Date.now();
    const maxMs = 120000; // 2 minutes for large batches
    while (Date.now() - start < maxMs && seen.size < wantedNames.size) {
      const list =
        dialog.querySelector('[data-testid="virtuoso-item-list"]') ||
        document.querySelector('[data-testid="virtuoso-item-list"]');
      if (list) {
        const items = [...list.querySelectorAll(":scope > div")].filter((d) =>
          d.querySelector("img")
        );
        for (const it of items) {
          const text = (it.textContent || "").trim();
          for (const n of wantedNames) {
            if (!seen.has(n) && (text.includes(n) || text.includes(n.replace(/\.[^.]+$/, "")))) {
              seen.add(n);
            }
          }
        }
      }
      if (seen.size < wantedNames.size) await sleep(1500);
    }
    log(jobId, `gallery has ${seen.size}/${wantedNames.size} files`);
    if (seen.size < wantedNames.size) {
      log(jobId, "warning: not all files appeared, continuing anyway");
    }

    // Close the dialog (press Escape) so we can re-open it cleanly for selection
    await closeAnyDialog(jobId);
    await sleep(600);
  }

  async function closeAnyDialog(jobId) {
    // Click outside if there's a sticky dialog
    document.activeElement?.blur();
    try {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
      );
    } catch {}
    if (currentSettings.cdpInput) {
      await chrome.runtime
        .sendMessage({ type: "CDP_KEY", key: "Escape", keyCode: 27, code: "Escape" })
        .catch(() => {});
    }
    await sleep(300);
  }

  // Select one image from the gallery by name. Opens dialog if needed.
  // IMPORTANT: always closes the dialog before returning so the next call to
  // openAddImageDialog clicks "add" against a clean state (otherwise the click
  // toggles the open dialog off and the next selection runs against stale DOM).
  async function selectFromGallery(jobId, name) {
    log(jobId, `selecting from gallery: ${name}`);
    // Make sure any previous dialog is closed before opening fresh — guards
    // against toggle-add-button-while-open re-closing the panel mid-flow.
    await closeAnyDialog(jobId);
    const dialog = await openAddImageDialog(jobId);

    // Use the search input to filter
    const searchInput = dialog.querySelector('input[type="text"]');
    const hasSearch = !!searchInput;
    if (searchInput) {
      try { searchInput.focus(); } catch {}
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      // Clear first so old search text from prior call doesn't linger
      setter?.call(searchInput, "");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(150);
      setter?.call(searchInput, name);
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(900);
    }

    const nameNoExt = name.replace(/\.[^.]+$/, "");
    // Find matching item — STRICT match by name. No items[0] fallback because
    // that historically caused the 1st-uploaded file (product) to be selected
    // for every ref slot when search filter returned 0 hits.
    const findItem = () => {
      const list =
        dialog.querySelector('[data-testid="virtuoso-item-list"]') ||
        document.querySelector('[data-testid="virtuoso-item-list"]');
      if (!list) return null;
      const items = [...list.querySelectorAll(":scope > div")].filter((d) =>
        d.querySelector("img")
      );
      const matched = items.find((d) => {
        const text = (d.textContent || "").trim();
        return text.includes(name) || text.includes(nameNoExt);
      });
      if (matched) return matched;
      // Loose fallback ONLY when there's no search box (can't filter) AND
      // exactly one item is visible — otherwise refuse to guess.
      if (!hasSearch && items.length === 1) return items[0];
      return null;
    };
    const item = await waitFor(findItem, { timeout: 15000, interval: 300 });
    if (!item) {
      log(jobId, `gallery item for ${name} not found (strict match)`);
      await closeAnyDialog(jobId);
      return false;
    }
    // Click the img — that's what attaches to the current prompt
    const img = item.querySelector("img") || item;
    const ok = await clickEl(img, { jobId, label: `select gallery ${name}` });
    await sleep(900);
    // Always close so the next selectFromGallery starts from a clean state.
    await closeAnyDialog(jobId);
    await sleep(300);
    return ok;
  }

  // ====================================================================
  // Prompt & submit (1:1 clone of VEO Automation's flow)
  // ====================================================================
  async function fillPromptAndSubmit(jobId, prompt, opts = {}) {
    const fast = !!opts.fast;
    log(jobId, `filling prompt — start (fast=${fast})`);
    const box = await waitClickable(
      () => document.querySelector('div[role="textbox"]'),
      { timeout: 15000 }
    );
    if (!box) throw new Error("prompt textbox not clickable");

    await clickEl(box, { jobId, label: "Prompt textarea" });
    await jSleep(1000);

    if (!fast && currentSettings.cdpInput) {
      await chrome.runtime.sendMessage({ type: "CDP_ATTACH" }).catch(() => {});
    }
    if (fast) {
      // Same humanType mechanism (small chunks via execCommand — Slate-safe),
      // but tuned for speed: 8-15 char chunks, 3-8ms delay, no rare pauses.
      // ~3K char prompt ≈ 1-2s thay vì 16s.
      let i = 0;
      while (i < prompt.length) {
        const chunk = 8 + Math.floor(Math.random() * 8); // 8-15 chars
        const piece = prompt.slice(i, i + chunk);
        if (currentSettings.cdpInput) {
          await chrome.runtime
            .sendMessage({ type: "CDP_INSERT_TEXT", text: piece })
            .catch(() => null);
        } else {
          document.execCommand("insertText", false, piece);
        }
        i += chunk;
        await sleep(3 + Math.random() * 5); // 3-8ms
      }
    } else {
      await humanType(prompt);
    }
    log(jobId, `✍️ filled prompt: ${prompt.substring(0, 60)}...`);

    await jSleep(1000);

    const submit = await waitClickable(() => firstByIcon(ICONS.arrowForward), {
      timeout: 8000,
    });
    const useEnter = Math.random() >= 0.2 || !submit;
    if (useEnter) {
      log(jobId, "submit via Enter key");
      await chrome.runtime
        .sendMessage({ type: "CDP_KEY", key: "Enter", keyCode: 13, code: "Enter" })
        .catch(() => null);
    } else {
      log(jobId, "submit via button click");
      await clickEl(submit, { jobId, label: "Submit button" });
    }
    // Hold ~7s after firing generation: looks human and gives Flow time to
    // register the new tile before the caller starts polling the DOM.
    await jSleep(7000);
  }

  // ====================================================================
  // Tile collection + download
  // ====================================================================
  function collectTileIds() {
    // Flow renders the same tile in multiple containers (main grid + side
    // panel + recent strip). Dedup so we don't process a tile twice.
    return [
      ...new Set(
        [...document.querySelectorAll("div[data-tile-id]")]
          .map((e) => e.getAttribute("data-tile-id"))
          .filter(Boolean)
      ),
    ];
  }

  // When `requireUrl` is true, also wait for the tile to have a real http(s) img src
  // (needed for downloading). When false, just wait for the tile to leave the queued
  // state — used when downloadQuality === "none" so we don't waste cycles capturing URLs.
  async function waitForTileDone(jobId, tileId, maxMs = 7 * 60 * 1000, requireUrl = true) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const tile = document.querySelector(`div[data-tile-id="${tileId}"]`);
      if (tile) {
        let queued = false;
        for (const i of tile.querySelectorAll("i")) {
          if (i.textContent.trim() === "movie") {
            queued = true;
            break;
          }
        }
        if (!queued) {
          const img = tile.querySelector("img");
          if (!requireUrl) return img?.src || "";
          if (img?.src && /^https?:/.test(img.src)) return img.src;
        }
      }
      await sleep(2000);
    }
    throw new Error(`tile ${tileId} timeout`);
  }

  function sanitize(s) {
    return (
      String(s || "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 80) || "img"
    );
  }
  function renderFilename(template, ctx) {
    return String(template || "{idx}_{product}__{listing}_{n}.{ext}")
      .replace(/\{idx\}/g, String(ctx.idx).padStart(3, "0"))
      .replace(/\{product\}/g, sanitize(ctx.product))
      .replace(/\{listing\}/g, sanitize(ctx.listing))
      .replace(/\{n\}/g, String(ctx.n).padStart(2, "0"))
      .replace(/\{ext\}/g, ctx.ext);
  }

  async function pressEscape() {
    if (currentSettings.cdpInput) {
      await chrome.runtime
        .sendMessage({ type: "CDP_KEY", key: "Escape", keyCode: 27, code: "Escape" })
        .catch(() => {});
    }
  }

  async function downloadTile(jobId, tileId, ctx) {
    log(jobId, `download tile ${tileId} (#${ctx.idx}/${ctx.n})`);
    const tile = document.querySelector(`div[data-tile-id="${tileId}"]`);
    if (!tile) {
      log(jobId, "tile vanished before download");
      return null;
    }

    // Open the tile-download "gate" in the SW. The SW will accept exactly ONE
    // download from this tab while the gate is open; anything else (preview +
    // high-res both fired by Flow on one click, etc.) gets cancelled.
    await chrome.runtime
      .sendMessage({ type: "TILE_DOWNLOAD_WINDOW", open: true, ttlMs: 20000 })
      .catch(() => {});

    try {
      return await downloadTileInner(jobId, tileId, ctx, tile);
    } finally {
      await chrome.runtime
        .sendMessage({ type: "TILE_DOWNLOAD_WINDOW", open: false })
        .catch(() => {});
    }
  }

  async function downloadTileInner(jobId, tileId, ctx, tile) {
    const downloadedSrc = tile.querySelector("img")?.src || null;
    const editLink = tile.querySelector('a[href*="/edit/"]');
    if (editLink) {
      await clickEl(editLink, { jobId, label: "open tile edit" });
    } else {
      await clickEl(tile, { jobId, label: "click tile" });
    }
    await sleep(900);

    if (downloadedSrc) {
      const ext = "png";
      const filename = renderFilename(currentSettings.filenameTemplate, {
        idx: ctx.idx,
        product: ctx.product,
        listing: ctx.listing,
        n: ctx.n,
        ext,
      });
      chrome.runtime
        .sendMessage({
          type: "REGISTER_DOWNLOAD_NAME",
          url: downloadedSrc,
          filename: `${currentSettings.folder || "zecom-swap"}/${
            currentSettings.prefix || ""
          }${filename}`,
        })
        .catch(() => {});
    }

    const dlBtn = await waitClickable(() => firstByIcon(ICONS.download), { timeout: 10000 });
    if (!dlBtn) {
      log(jobId, "download button not in toolbar");
      await pressEscape();
      return downloadedSrc;
    }
    await clickEl(dlBtn, { jobId, label: "open download menu" });
    await sleep(700);

    const menu = document.querySelector('div[role="menu"]');
    if (menu) {
      const order =
        currentSettings.downloadQuality === "highest"
          ? ["4K", "2K", "1K"]
          : ["1K", "2K", "4K"];
      let pick = null;
      for (const q of order) {
        for (const b of menu.querySelectorAll("button")) {
          if ((b.textContent || "").includes(q)) {
            pick = b;
            break;
          }
        }
        if (pick) break;
      }
      if (!pick) {
        for (const b of menu.querySelectorAll("button")) {
          for (const i of b.querySelectorAll("i")) {
            if (i.textContent.trim() === "favorite") {
              pick = b;
              break;
            }
          }
          if (pick) break;
        }
      }
      if (!pick) pick = menu.querySelector("button");
      if (pick) {
        await clickEl(pick, { jobId, label: "quality" });
        await sleep(2500);
      }
    }

    // Close the edit/download view. Previously we looked for a "check" icon, but
    // on Flow that icon can be a "Mark as best / confirm" action that re-triggers
    // a download — producing the duplicate file the user was seeing. Escape is
    // unambiguous and never downloads.
    await pressEscape();
    await sleep(700);
    return downloadedSrc;
  }

  // ====================================================================
  // Image-batch pipeline: run a few "ref-gen" prompts first (no refs),
  // capture their outputs, upload them back as named files, then run the
  // remaining prompts with those refs attached.
  // ====================================================================
  // Fetch one or more URLs into File objects via the SW (its host_permissions
  // reach the dashboard + Google CDNs; direct fetch from labs.google would
  // CORS-fail). Failures don't stop the batch — that ref is just skipped.
  async function fetchUrlsToFiles(urls, defaultExt = "png") {
    const out = [];
    for (let i = 0; i < urls.length; i++) {
      const item = urls[i];
      const name = item.name || `input${i + 1}.${defaultExt}`;
      try {
        const sw = await chrome.runtime.sendMessage({
          type: "FETCH_AS_DATA_URL",
          url: item.url,
        });
        if (!sw?.ok || !sw.dataUrl) {
          log(null, `inputImage ${name}: fetch failed — ${sw?.error || "?"}`);
          continue;
        }
        out.push(await dataUrlToFile(sw.dataUrl, name));
      } catch (e) {
        log(null, `inputImage ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  async function runImgBatch(jobs, inputImages = []) {
    const results = {};
    for (const j of jobs) results[j.id] = { success: false, outputs: [] };

    try {
      if (!/labs\.google/.test(location.href)) {
        throw new Error(`not on labs.google (url=${location.href})`);
      }
      if (currentSettings.cdpInput) {
        await chrome.runtime.sendMessage({ type: "CDP_ATTACH" }).catch(() => {});
      }
      await waitForReactHydrated(null);
      await sleep(800);
      await ensureInsideProject(null);
      // Project may open in VIDEO mode if user last used video — flip it back.
      await ensureMode(null, "IMAGE");
      await applyGenerationSettings(null);

      const refJobs = jobs.filter((j) => j.role === "ref");
      const mainJobs = jobs.filter((j) => j.role === "main");
      log(null, `imgbatch: ${inputImages.length} input img + ${refJobs.length} ref + ${mainJobs.length} main prompt(s)`);

      // ---- Phase 0: fetch input images (dashboard-supplied, eg product) ----
      const inputFiles = inputImages.length
        ? await fetchUrlsToFiles(inputImages, "png")
        : [];
      log(null, `inputImages fetched: ${inputFiles.length}/${inputImages.length}`);

      // ---- Phase 1: submit all ref prompts (no image attachments) ----
      const refTileMap = new Map(); // jobId -> [tileId,…]
      for (let i = 0; i < refJobs.length; i++) {
        const j = refJobs[i];
        log(j.id, `submitting ref ${i + 1}/${refJobs.length}: ${j.prompt.slice(0, 60)}…`);
        const before = new Set(collectTileIds());
        try {
          await fillPromptAndSubmit(j.id, j.prompt);
          await sleep(3500);
          const newT = collectTileIds().filter((t) => !before.has(t));
          refTileMap.set(j.id, newT);
          log(j.id, `ref submitted, new tiles: ${newT.join(", ") || "(none yet)"}`);
        } catch (e) {
          results[j.id].error = e instanceof Error ? e.message : String(e);
          log(j.id, "ref submit error:", results[j.id].error);
        }
        await jSleep(1500);
      }

      // ---- Phase 2: wait for ref tiles, fetch their URLs, build Files ----
      const refFiles = [];
      for (let i = 0; i < refJobs.length; i++) {
        const j = refJobs[i];
        const tids = refTileMap.get(j.id) || [];
        if (!tids.length) {
          if (!results[j.id].error) results[j.id].error = "no tile generated for ref";
          continue;
        }
        try {
          // Use the first output as the canonical ref image
          const src = await waitForTileDone(j.id, tids[0], undefined, true);
          log(j.id, `ref tile finished: ${String(src).slice(0, 80)}…`);
          results[j.id].outputs.push(src);
          // Fetch directly from content-script (labs.google origin). MUST use
          // credentials:"same-origin" — that way:
          //   • initial hit to labs.google/fx/api/trpc → cookies sent → auth OK
          //   • after the 302 redirect to flow-content.google (cross-origin) →
          //     credentials auto-stripped → server's ACAO:* wildcard is valid
          // Routing via SW fails because the SW lives on chrome-extension://
          // (cross-origin to labs.google) so trpc has no cookies to auth with.
          const name = `ref${i + 1}.png`;
          const dataUrl = await fetchTileToDataUrl(src);
          refFiles.push(await dataUrlToFile(dataUrl, name));
          results[j.id].success = true;
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          results[j.id].error = m;
          log(j.id, "ref capture error:", m);
        }
      }

      // All ref files attached to main prompts = dashboard inputs + generated refs.
      const allRefFiles = [...inputFiles, ...refFiles];
      log(
        null,
        `phase2 done: ${refFiles.length}/${refJobs.length} generated refs captured ` +
          `(names: ${refFiles.map((f) => f.name).join(",") || "none"}); ` +
          `total refs for main = ${allRefFiles.length} ` +
          `(${inputFiles.length} input + ${refFiles.length} generated)`
      );
      if (mainJobs.length && !allRefFiles.length) {
        throw new Error("no reference images available — main prompts cannot proceed");
      }
      if (mainJobs.length && refJobs.length && refFiles.length < refJobs.length) {
        log(
          null,
          `WARN: only ${refFiles.length}/${refJobs.length} ref images captured — ` +
            `main prompts will run without the missing person ref(s). ` +
            `Check the ref-capture errors above (likely FETCH_AS_DATA_URL failed for the tile URL).`
        );
      }

      // ---- Phase 3: upload all refs into project so we can select by name ----
      if (allRefFiles.length) {
        log(null, `uploading ${allRefFiles.length} ref image(s) into project (${inputFiles.length} input + ${refFiles.length} generated)`);
        await uploadFilesAtOnce(null, allRefFiles);
      }

      // ---- Phase 4: submit main prompts with all refs attached ----
      const mainTileMap = new Map();
      for (let i = 0; i < mainJobs.length; i++) {
        const j = mainJobs[i];
        log(j.id, `submitting main ${i + 1}/${mainJobs.length}: ${j.prompt.slice(0, 60)}…`);
        const before = new Set(collectTileIds());
        try {
          let attached = 0;
          for (const f of allRefFiles) {
            const ok = await selectFromGallery(j.id, f.name);
            if (ok) attached++;
            else log(j.id, `warn: ref ${f.name} NOT attached`);
          }
          log(j.id, `refs attached: ${attached}/${allRefFiles.length} for main ${i + 1}`);
          if (attached < allRefFiles.length) {
            log(j.id, `WARN: missing ${allRefFiles.length - attached} ref(s) — output may not reflect the missing person/product face`);
          }
          await jSleep(800);
          // Listing prompts are huge (~7-10K chars after wrap) — paste, don't type.
          await fillPromptAndSubmit(j.id, j.prompt, { fast: true });
          await sleep(3500);
          const newT = collectTileIds().filter((t) => !before.has(t));
          mainTileMap.set(j.id, newT);
          log(j.id, `main submitted, new tiles: ${newT.join(", ") || "(none yet)"}`);
        } catch (e) {
          results[j.id].error = e instanceof Error ? e.message : String(e);
          log(j.id, "main submit error:", results[j.id].error);
        }
        await jSleep(1500);
      }

      // ---- Phase 5: wait + download main outputs ----
      const skipDl = currentSettings.downloadQuality === "none";
      for (let i = 0; i < mainJobs.length; i++) {
        const j = mainJobs[i];
        const tids = mainTileMap.get(j.id) || [];
        if (!tids.length) {
          if (!results[j.id].error) results[j.id].error = "no tile generated";
          continue;
        }
        let n = 0;
        for (const tid of tids) {
          n++;
          try {
            const src = await waitForTileDone(j.id, tid, undefined, !skipDl);
            if (skipDl) {
              results[j.id].outputs.push("");
            } else {
              const downloadedSrc = await downloadTile(j.id, tid, {
                idx: refJobs.length + i + 1,
                product: `prompt${i + 1}`,
                listing: "imgbatch",
                n,
              });
              if (downloadedSrc) results[j.id].outputs.push(downloadedSrc);
            }
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (!results[j.id].error) results[j.id].error = m;
            log(j.id, "main tile error:", m);
          }
        }
        if (results[j.id].outputs.length > 0 && !results[j.id].error) {
          results[j.id].success = true;
        }
      }

      for (const j of jobs) {
        if (results[j.id].outputs.length > 0) results[j.id].success = true;
      }

      return { success: true, results };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(null, "IMGBATCH ERROR:", m);
      for (const j of jobs) {
        if (!results[j.id].success && !results[j.id].error) results[j.id].error = m;
      }
      return { success: false, error: m, results };
    }
  }

  // ====================================================================
  // Main batch runner
  // ====================================================================
  let activeBatch = false;

  async function runBatch(payload) {
    const { jobs, settings, kind, videoRefs } = payload;
    const isUpscale = kind === "upscale";
    const isVideo = kind === "video";
    const isImgBatch = kind === "imgbatch";
    if (activeBatch) return { success: false, error: "batch already running" };
    activeBatch = true;
    currentSettings = settings || {};

    log(null, `RUN_BATCH start — ${jobs.length} job(s) [${kind || "swap"}], url: ${location.href}`);

    // imgbatch has its own pipeline (2-then-N with auto-generated refs).
    if (isImgBatch) {
      try {
        const out = await runImgBatch(jobs, payload.inputImages || []);
        return out;
      } finally {
        activeBatch = false;
      }
    }

    const results = {}; // jobId -> { success, outputs, error }
    for (const j of jobs) results[j.id] = { success: false, outputs: [] };

    try {
      if (!/labs\.google/.test(location.href)) {
        throw new Error(`not on labs.google (url=${location.href})`);
      }

      if (currentSettings.cdpInput) {
        await chrome.runtime.sendMessage({ type: "CDP_ATTACH" }).catch(() => {});
      }
      await waitForReactHydrated(null);
      await sleep(800);

      // ----- step 1: ensure in project
      await ensureInsideProject(null);

      // ----- step 1b: apply generation settings (once per session)
      if (isVideo) {
        // Switch to Video mode, then lock model=omni-flash, aspect=16:9, 4s.
        await selectVideoMode(null);
        await applyVideoSettings(null);
      } else {
        // Project may have opened in VIDEO mode — flip to IMAGE first.
        await ensureMode(null, "IMAGE");
        await applyGenerationSettings(null);
      }

      // ----- step 2: collect unique files (avoid uploading same image twice)
      const uniqueFiles = new Map(); // name -> File
      if (isVideo) {
        for (const ref of videoRefs || []) {
          if (ref?.name && ref?.dataUrl && !uniqueFiles.has(ref.name)) {
            uniqueFiles.set(ref.name, await dataUrlToFile(ref.dataUrl, ref.name));
          }
        }
      } else {
        for (const j of jobs) {
          if (j.productName && j.productDataUrl && !uniqueFiles.has(j.productName)) {
            uniqueFiles.set(
              j.productName,
              await dataUrlToFile(j.productDataUrl, j.productName)
            );
          }
          if (j.listingName && j.listingDataUrl && !uniqueFiles.has(j.listingName)) {
            uniqueFiles.set(
              j.listingName,
              await dataUrlToFile(j.listingDataUrl, j.listingName)
            );
          }
        }
      }
      log(null, `unique files to upload: ${uniqueFiles.size}`);

      // ----- step 3: upload all at once
      const fileArr = [...uniqueFiles.values()];
      if (fileArr.length) await uploadFilesAtOnce(null, fileArr);

      // ----- step 4: for each pair, select 2 images + fill prompt + submit
      const jobToTiles = new Map(); // jobId -> [tileIds]
      for (let idx = 0; idx < jobs.length; idx++) {
        const j = jobs[idx];
        log(j.id, `processing pair ${idx + 1}/${jobs.length}`);
        const tilesBefore = new Set(collectTileIds());

        try {
          if (isVideo) {
            // Re-attach the per-scene refs. Main scenes use main product +
            // giver + receiver; extra-product scenes swap main → that extra.
            const refNames = (j.refNames && j.refNames.length)
              ? j.refNames
              : (videoRefs || []).map((r) => r?.name).filter(Boolean);
            for (const name of refNames) {
              if (!name) continue;
              const ok = await selectFromGallery(j.id, name);
              if (!ok) log(j.id, `warn: ref ${name} not attached`);
            }
          } else {
            // Select product (left) first, then listing (right). For upscale,
            // only one image per job — skip the listing selection entirely.
            const okP = await selectFromGallery(j.id, j.productName);
            if (!okP) throw new Error(`failed to select product ${j.productName}`);
            if (!isUpscale) {
              const okL = await selectFromGallery(j.id, j.listingName);
              if (!okL) throw new Error(`failed to select listing ${j.listingName}`);
            }
          }

          // Verify ingredient thumbnails appear before submitting
          await jSleep(800);

          await fillPromptAndSubmit(j.id, j.prompt);
          await sleep(3500); // wait for tile to register

          const tilesAfter = collectTileIds();
          const newTiles = [...new Set(tilesAfter.filter((t) => !tilesBefore.has(t)))];
          jobToTiles.set(j.id, newTiles);
          log(j.id, `submitted, new tiles: ${newTiles.join(", ") || "(none yet)"}`);
        } catch (e) {
          results[j.id].error = e instanceof Error ? e.message : String(e);
          log(j.id, "ERROR in submit:", results[j.id].error);
        }

        // small gap between submissions to avoid rate limits
        await jSleep(1500);
      }

      // ----- step 5: wait for tiles + (optionally) download each
      const skipDownload = currentSettings.downloadQuality === "none";
      if (skipDownload) {
        log(null, "📥 download skipped (downloadQuality = none)");
      } else {
        log(null, "all submitted, waiting for tiles to finish");
      }
      for (let idx = 0; idx < jobs.length; idx++) {
        const j = jobs[idx];
        const tileIds = jobToTiles.get(j.id) || [];
        if (!tileIds.length) {
          if (!results[j.id].error)
            results[j.id].error = "no tile IDs captured for this job";
          continue;
        }
        let n = 0;
        for (const tid of tileIds) {
          n++;
          try {
            const src = await waitForTileDone(j.id, tid, undefined, !skipDownload);
            if (skipDownload) {
              // Tile finished — no URL capture, no download UI. Just count it.
              results[j.id].outputs.push("");
              log(j.id, `tile ${tid} ready (download skipped)`);
            } else {
              const downloadedSrc = await downloadTile(j.id, tid, {
                idx: idx + 1,
                product: j.productName?.replace(/\.[^.]+$/, "") || "product",
                listing: isVideo
                  ? `scene${j.sceneIndex || idx + 1}${j.extraTag ? `_${j.extraTag}` : ""}`
                  : (j.listingName?.replace(/\.[^.]+$/, "") ||
                     (isUpscale ? "upscale" : "listing")),
                n,
              });
              if (downloadedSrc) results[j.id].outputs.push(downloadedSrc);
            }
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            log(j.id, "tile error:", m);
            if (!results[j.id].error) results[j.id].error = m;
          }
        }
        if (results[j.id].outputs.length > 0 && !results[j.id].error) {
          results[j.id].success = true;
        }
      }

      // Mark anything with outputs as success even if error present elsewhere
      for (const j of jobs) {
        if (results[j.id].outputs.length > 0) results[j.id].success = true;
      }

      return { success: true, results };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(null, "BATCH ERROR:", m);
      // Mark all unstarted jobs with the error
      for (const j of jobs) {
        if (!results[j.id].success && !results[j.id].error) results[j.id].error = m;
      }
      return { success: false, error: m, results };
    } finally {
      activeBatch = false;
    }
  }

  // ====================================================================
  // Message handlers
  // ====================================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "RUN_BATCH") {
      runBatch(msg).then(sendResponse);
      return true;
    }
    if (msg?.type === "CANCEL_BATCH") {
      activeBatch = false;
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === "PING") {
      sendResponse({ ok: true, url: location.href, inProject: isInProject() });
      return false;
    }
    return false;
  });

  log(null, "Zecom Product Swap content script loaded on", location.href);
})();
