// Zecom Product Swap — Service Worker (Session mode)
// Data model:
//   state.sessions[] = each session is one "+ Add to queue" action.
//   A session contains N pairs and runs as ONE batch in ONE Flow project.
//   `concurrency` setting = how many sessions run in parallel (each in its own tab).

const STORAGE_STATE = "zps_state_v4";
const STORAGE_SETTINGS = "zps_settings_v3";
const FLOW_URL = "https://labs.google/fx/tools/flow";
const GEMINI_URL = "https://gemini.google.com/app";
const CHATGPT_URL = "https://chatgpt.com/";
const TRADEMARK_PROMPT = "Check Trademark cho tôi các thiết kế này";

const DEFAULT_UPSCALE_PROMPT = "upscale this image without changing any details";

const DEFAULT_SETTINGS = {
  prompt: "Replace the product from the right image with the product in the left image",
  upscalePrompt: DEFAULT_UPSCALE_PROMPT,
  imageEngine: "flow",
  aspectRatio: "auto",
  outputsPerPrompt: 1,
  imageModel: "auto",
  videoModel: "omni-flash",
  videoOutputs: 1,
  videoDuration: 4,
  downloadQuality: "original",
  concurrency: 2,
  waitMin: 1,
  waitMax: 3,
  autoRetry: false,
  maxRetries: 2,
  closeTabAfter: false,
  folder: "zecom-swap",
  prefix: "",
  filenameTemplate: "{idx}_{product}__{listing}_{n}.{ext}",
  autoRename: true,
  clearCookies: false,
  disableCache: true,
  cdpInput: true,
  runInWindow: false,
  language: "vi",
  defaultMode: "image-to-image",
  zoomLevel: 100,
};

/** @typedef {{
 *   id: string, productName: string, listingName: string,
 *   status: 'pending'|'done'|'error'|'cancelled',
 *   error?: string, outputs?: string[]
 * }} Pair */

/** @typedef {{
 *   id: string, createdAt: number,
 *   status: 'pending'|'running'|'done'|'error'|'cancelled',
 *   startedAt?: number, finishedAt?: number,
 *   error?: string, tabId?: number,
 *   pairs: Pair[]
 * }} Session */

const state = {
  /** @type {Session[]} */
  sessions: [],
  running: false,
  settings: { ...DEFAULT_SETTINGS },
};

const attachedTabs = new Set();
const renameMap = new Map();
const pairDataMap = new Map(); // pairId -> { productDataUrl, listingDataUrl }
// For video sessions only: sessionId -> { refs: [{role,name,dataUrl}], appendix }
const videoSessionData = new Map();

// ---------- persistence ----------
async function loadAll() {
  try {
    const got = await chrome.storage.local.get([STORAGE_STATE, STORAGE_SETTINGS]);
    if (got[STORAGE_SETTINGS])
      state.settings = { ...DEFAULT_SETTINGS, ...got[STORAGE_SETTINGS] };
    if (got[STORAGE_STATE]?.sessions) {
      state.sessions = got[STORAGE_STATE].sessions;
      for (const s of state.sessions) {
        if (s.status === "running") s.status = "pending";
        for (const p of s.pairs || []) {
          if (p.status === "running") p.status = "pending";
        }
      }
    }
  } catch {}
}
async function saveState() {
  try {
    const snap = {
      sessions: state.sessions.map((s) => ({
        id: s.id,
        kind: s.kind || "swap",
        upscalePrompt: s.upscalePrompt,
        createdAt: s.createdAt,
        status: s.status,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        error: s.error,
        pairs: s.pairs.map((p) => ({
          id: p.id,
          productName: p.productName,
          listingName: p.listingName,
          status: p.status,
          error: p.error,
          outputs: p.outputs,
        })),
      })),
    };
    await chrome.storage.local.set({ [STORAGE_STATE]: snap });
  } catch {}
}
async function saveSettings() {
  try { await chrome.storage.local.set({ [STORAGE_SETTINGS]: state.settings }); } catch {}
}

// ---------- public state ----------
function publicState() {
  return {
    running: state.running,
    settings: state.settings,
    sessions: state.sessions.map((s, idx) => ({
      id: s.id,
      kind: s.kind || "swap",
      index: idx + 1,
      createdAt: s.createdAt,
      status: s.status,
      error: s.error,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      pairCount: s.pairs.length,
      pairsDone: s.pairs.filter((p) => p.status === "done").length,
      pairsError: s.pairs.filter((p) => p.status === "error").length,
      totalOutputs: s.pairs.reduce((sum, p) => sum + (p.outputs?.length || 0), 0),
      pairs: s.pairs.map((p) => ({
        id: p.id,
        productName: p.productName,
        listingName: p.listingName,
        status: p.status,
        error: p.error,
        outputs: p.outputs?.length || 0,
      })),
    })),
  };
}
function broadcast() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: publicState() }).catch(() => {});
}

// ---------- side panel ----------
async function ensureSidePanel() {
  try {
    await chrome.sidePanel.setOptions({ path: "sidepanel/index.html", enabled: true });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
}
ensureSidePanel();
chrome.runtime.onInstalled.addListener(ensureSidePanel);
chrome.action.onClicked.addListener(async (tab) => {
  try { if (tab.id) await chrome.sidePanel.open({ tabId: tab.id }); } catch {}
});

// ---------- download intercept ----------
// Two layers of duplicate-download protection:
//
// (1) Tab-scoped tile gate: content.js opens a "tile download window" before
//     it clicks Flow's download UI. While the window is open, the SW accepts
//     EXACTLY ONE download per tab and cancels any others — even if their URLs
//     differ (Flow can fire a preview + a high-res download from one click,
//     each with a different signed URL).
//
// (2) URL dedup: same-URL within 30s also gets cancelled. Catches duplicates
//     that fire outside any tile window (eg manual user actions).
const recentDownloads = new Map(); // url -> timestamp
const DEDUP_TTL_MS = 30 * 1000;

// tabKey -> { acceptedOne: boolean, expiresAt: number }
const tileDownloadGate = new Map();

function makeTabKey(tabUrl) {
  try {
    const u = new URL(tabUrl || "");
    return `${u.origin}${u.pathname.split("/").slice(0, 4).join("/")}`;
  } catch {
    return tabUrl || "";
  }
}

function gateForReferrer(ref) {
  const k = makeTabKey(ref);
  const g = tileDownloadGate.get(k);
  if (!g || Date.now() >= g.expiresAt) {
    if (g) tileDownloadGate.delete(k);
    return null;
  }
  return g;
}

function isRecentDuplicate(url) {
  if (!url) return false;
  const now = Date.now();
  for (const [k, t] of recentDownloads) {
    if (now - t > DEDUP_TTL_MS) recentDownloads.delete(k);
  }
  const t = recentDownloads.get(url);
  return t != null && now - t < DEDUP_TTL_MS;
}

const onDeterminingFilename = (item, suggest) => {
  const url = item.url || "";
  const fn = item.filename || "";
  const ref = item.referrer || "";
  if (!/\.(jpe?g|png|gif|webp|bmp|svg|jfif|mp4|webm|mov|m4v)$/i.test(fn || url)) return;
  if (!state.settings.autoRename) return;

  // Layer 1: tile-window gate. While we're in an active tile-download window
  // for this tab, accept only ONE download and cancel the rest.
  const gate = gateForReferrer(ref);
  if (gate) {
    if (gate.acceptedOne) {
      console.log("[zps:download] CANCEL (tile-gate)", url.slice(0, 80));
      try { chrome.downloads.cancel(item.id); } catch {}
      return;
    }
    gate.acceptedOne = true;
  }

  // Layer 2: same-URL within 30s
  if (isRecentDuplicate(url)) {
    console.log("[zps:download] CANCEL (url-dup)", url.slice(0, 80));
    try { chrome.downloads.cancel(item.id); } catch {}
    return;
  }
  recentDownloads.set(url, Date.now());

  if (renameMap.has(url)) {
    suggest({ filename: renameMap.get(url) });
    renameMap.delete(url);
    return;
  }
  const baseName = fn.split(/[\\/]/).pop() || "image";
  const folder = state.settings.folder
    ? `${state.settings.folder.trim().replace(/\/+$/, "")}/`
    : "";
  const prefix = state.settings.prefix || "";
  suggest({ filename: `${folder}${prefix}${baseName}` });
};
function enableDownloadIntercept() {
  if (!chrome.downloads.onDeterminingFilename.hasListener(onDeterminingFilename))
    chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
}
function disableDownloadIntercept() {
  if (chrome.downloads.onDeterminingFilename.hasListener(onDeterminingFilename))
    chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
}

// ---------- debugger ----------
chrome.tabs.onRemoved.addListener((id) => attachedTabs.delete(id));
chrome.debugger.onDetach.addListener((s) => { if (s.tabId != null) attachedTabs.delete(s.tabId); });

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
    if (state.settings.disableCache) {
      try {
        await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
        await chrome.debugger.sendCommand({ tabId }, "Network.setCacheDisabled", {
          cacheDisabled: true,
        });
      } catch {}
    }
    // Anti-throttling: force the page to behave as if it's the focused/visible
    // tab. Chrome throttles background tabs heavily (timers clamped to ~1Hz),
    // which breaks DOM automation. CDP can override this.
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    } catch {}
    try {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setVisibilityState", {
        visibilityState: "visible",
      });
    } catch {}
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", {
        state: "active",
      });
    } catch {}
    try {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
        enabled: true,
      });
    } catch {}
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("already attached")) {
      attachedTabs.add(tabId);
      // Even if already attached, ensure visibility override is on
      try {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setVisibilityState", {
          visibilityState: "visible",
        });
      } catch {}
    } else {
      throw e;
    }
  }
}

// Re-apply visibility override (handy to call periodically or after navigation)
async function keepTabActive(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setVisibilityState", {
      visibilityState: "visible",
    });
    await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", {
      state: "active",
    });
  } catch {}
}
async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch {}
  attachedTabs.delete(tabId);
}
async function cdpInsertText(tabId, text) {
  await attachDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
}
async function cdpClick(tabId, x, y) {
  await attachDebugger(tabId);
  const t = { tabId };
  const p = (type, button, buttons) => ({
    type, x, y, button, buttons, clickCount: 1, modifiers: 0,
  });
  await chrome.debugger.sendCommand(t, "Input.dispatchMouseEvent", p("mouseMoved", "none", 0));
  await chrome.debugger.sendCommand(t, "Input.dispatchMouseEvent", p("mousePressed", "left", 1));
  await chrome.debugger.sendCommand(t, "Input.dispatchMouseEvent", p("mouseReleased", "left", 0));
}
async function cdpKey(tabId, key, keyCode, code, modifiers = 0) {
  await attachDebugger(tabId);
  const t = { tabId };
  const b = {
    key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers,
  };
  await chrome.debugger.sendCommand(t, "Input.dispatchKeyEvent", { type: "keyDown", ...b });
  await chrome.debugger.sendCommand(t, "Input.dispatchKeyEvent", { type: "keyUp", ...b });
}

// ---------- tab helpers ----------
function waitForTabComplete(tabId, ms = 30000) {
  return new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, ms);
  });
}

function interpolatePrompt(template, ctx) {
  return String(template || "")
    .replace(/\{product\}/g, ctx.product || "")
    .replace(/\{listing\}/g, ctx.listing || "");
}

// ---------- session runner ----------
let activeSessionCount = 0;

async function startQueue() {
  if (state.running) return;
  const hasPending = state.sessions.some((s) => s.status === "pending");
  if (!hasPending) return;

  state.running = true;
  enableDownloadIntercept();
  broadcast();
  saveState();
  pumpSessions();
}

function pumpSessions() {
  if (!state.running) return;
  const concurrency = Math.max(1, Math.min(10, state.settings.concurrency || 1));
  while (activeSessionCount < concurrency) {
    const next = state.sessions.find((s) => s.status === "pending");
    if (!next) break;
    activeSessionCount++;
    runSession(next).finally(() => {
      activeSessionCount--;
      saveState();
      broadcast();
      if (state.running) pumpSessions();
      else if (activeSessionCount === 0) disableDownloadIntercept();
    });
  }
  if (activeSessionCount === 0 && !state.sessions.some((s) => s.status === "pending")) {
    state.running = false;
    disableDownloadIntercept();
    broadcast();
    saveState();
  }
}

async function runSession(session) {
  session.status = "running";
  session.startedAt = Date.now();
  broadcast();
  saveState();

  let tab;
  // ChatGPT routing: only swap (kind=undefined/"swap") and imgbatch use the
  // ChatGPT engine. Upscale, video, trademark stay on their original hosts.
  // Hoisted out of the try so the finally block can read it.
  const isImgBatchKind = session.kind === "imgbatch";
  const isSwapKind = !session.kind || session.kind === "swap";
  const useChatGpt =
    state.settings.imageEngine === "chatgpt" && (isSwapKind || isImgBatchKind);
  try {
    const isTrademark = session.kind === "trademark";
    const targetUrl = isTrademark
      ? GEMINI_URL
      : useChatGpt
      ? CHATGPT_URL
      : FLOW_URL;
    // Each session opens its OWN tab → its OWN Flow project.
    // If runInWindow is on, open a separate small window so each session has
    // its own "active tab" (no throttling).
    if (state.settings.runInWindow) {
      const win = await chrome.windows.create({
        url: targetUrl,
        type: "normal",
        focused: false,
        width: 1100,
        height: 800,
      });
      tab = win.tabs?.[0];
      if (!tab) throw new Error("could not get tab from new window");
      session.windowId = win.id;
    } else {
      tab = await chrome.tabs.create({ url: targetUrl, active: false });
    }
    session.tabId = tab.id;
    broadcast();

    // Attach debugger BEFORE the page finishes loading so visibility override
    // applies from the very start. Without this, Chrome throttles the tab
    // while in background → automation stalls.
    try {
      await attachDebugger(tab.id);
    } catch (e) {
      console.log("[zps] early debugger attach failed:", e);
    }

    await waitForTabComplete(tab.id);

    if (state.settings.zoomLevel && state.settings.zoomLevel !== 100) {
      try { await chrome.tabs.setZoom(tab.id, state.settings.zoomLevel / 100); } catch {}
    }

    // Re-apply visibility override after load (Chrome sometimes resets it)
    await keepTabActive(tab.id);
    await new Promise((r) => setTimeout(r, 1500));

    const isUpscale = session.kind === "upscale";
    const isVideo = session.kind === "video";
    const isImgBatch = session.kind === "imgbatch";
    // isTrademark already computed above
    const upscalePrompt =
      session.upscalePrompt || state.settings.upscalePrompt || DEFAULT_UPSCALE_PROMPT;
    const vidData = isVideo ? videoSessionData.get(session.id) || { refs: [], appendix: "" } : null;
    const payloadJobs = session.pairs.map((p) => {
      const data = pairDataMap.get(p.id) || {};
      if (isImgBatch) {
        return {
          id: p.id,
          productName: p.productName, // "Ref 1" / "Prompt 1"
          role: data.role,             // 'ref' | 'main'
          refIndex: data.refIndex,
          mainIndex: data.mainIndex,
          prompt: data.prompt,
        };
      }
      if (isUpscale) {
        return {
          id: p.id,
          productName: p.productName,
          productDataUrl: data.productDataUrl,
          listingName: "",
          listingDataUrl: null,
          prompt: upscalePrompt,
        };
      }
      if (isVideo) {
        const scenePrompt = vidData.appendix
          ? `${data.sceneText}\n\n${vidData.appendix}`
          : data.sceneText;
        return {
          id: p.id,
          productName: p.productName, // "Scene N" or "Scene 1 (extra)"
          sceneIndex: data.sceneIndex,
          refNames: data.refNames || [],
          extraTag: data.extraTag,
          prompt: scenePrompt,
        };
      }
      return {
        id: p.id,
        productName: p.productName,
        productDataUrl: data.productDataUrl,
        listingName: p.listingName,
        listingDataUrl: data.listingDataUrl,
        prompt: interpolatePrompt(state.settings.prompt, {
          product: (p.productName || "").replace(/\.[^.]+$/, ""),
          listing: (p.listingName || "").replace(/\.[^.]+$/, ""),
        }),
      };
    });

    const resp = isTrademark
      ? await chrome.tabs.sendMessage(tab.id, {
          type: "RUN_TRADEMARK",
          sessionId: session.id,
          jobs: session.pairs.map((p) => {
            const data = pairDataMap.get(p.id) || {};
            return {
              id: p.id,
              name: p.productName,
              dataUrl: data.productDataUrl,
            };
          }),
          prompt: TRADEMARK_PROMPT,
          settings: state.settings,
        })
      : useChatGpt
      ? await chrome.tabs.sendMessage(tab.id, {
          type: "RUN_CHATGPT",
          sessionId: session.id,
          kind: session.kind || "swap",
          jobs: payloadJobs.map((j) => ({
            id: j.id,
            productName: j.productName,
            productDataUrl: j.productDataUrl,
            listingName: j.listingName,
            listingDataUrl: j.listingDataUrl,
            prompt: j.prompt,
          })),
          inputImages: isImgBatch ? session.inputImages || [] : undefined,
          settings: state.settings,
        })
      : await chrome.tabs.sendMessage(tab.id, {
          type: "RUN_BATCH",
          sessionId: session.id,
          kind: session.kind || "swap",
          jobs: payloadJobs,
          settings: state.settings,
          videoRefs: isVideo ? vidData.refs : undefined,
          inputImages: isImgBatch ? session.inputImages || [] : undefined,
        });

    if (resp?.results) {
      let anyError = false;
      let anyDone = false;
      for (const p of session.pairs) {
        const r = resp.results[p.id];
        if (!r) {
          p.status = "error";
          p.error = "no result";
          anyError = true;
        } else if (r.success) {
          p.status = "done";
          p.outputs = r.outputs || [];
          anyDone = true;
        } else {
          p.status = "error";
          p.error = r.error || "unknown";
          anyError = true;
        }
      }
      if (anyDone && !anyError) session.status = "done";
      else if (anyDone && anyError) {
        session.status = "done";
        session.error = "some pairs failed";
      } else {
        session.status = "error";
        session.error = resp?.error || "all pairs failed";
      }
    } else {
      session.status = "error";
      session.error = resp?.error || "no response from content script";
      for (const p of session.pairs) {
        if (p.status === "pending") {
          p.status = "error";
          p.error = session.error;
        }
      }
    }
  } catch (e) {
    session.status = "error";
    session.error = e instanceof Error ? e.message : String(e);
    for (const p of session.pairs) {
      if (p.status === "pending") {
        p.status = "error";
        p.error = session.error;
      }
    }
  } finally {
    session.finishedAt = Date.now();
    if (tab && state.settings.closeTabAfter && session.kind !== "trademark" && !useChatGpt) {
      try {
        await detachDebugger(tab.id);
        if (session.windowId) {
          await chrome.windows.remove(session.windowId);
        } else {
          await chrome.tabs.remove(tab.id);
        }
      } catch {}
    }
  }
}

async function stopQueue() {
  state.running = false;
  for (const s of state.sessions) {
    if (s.status === "running") {
      s.status = "cancelled";
      s.finishedAt = Date.now();
      for (const p of s.pairs) {
        if (p.status === "pending") p.status = "cancelled";
      }
    }
  }
  const tabs = await chrome.tabs.query({
    url: ["*://labs.google/*", "https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: "CANCEL_BATCH" }).catch(() => {});
  }
  disableDownloadIntercept();
  broadcast();
  saveState();
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "GET_STATE":
      sendResponse({ state: publicState() });
      return false;

    case "ADD_PAIRS": {
      // Each ADD_PAIRS call creates a NEW SESSION
      const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const session = {
        id: sessionId,
        createdAt: Date.now(),
        status: "pending",
        pairs: [],
      };
      for (const p of msg.pairs) {
        const pid = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        session.pairs.push({
          id: pid,
          productName: p.productName,
          listingName: p.listingName,
          status: "pending",
        });
        pairDataMap.set(pid, {
          productDataUrl: p.productDataUrl,
          listingDataUrl: p.listingDataUrl,
        });
      }
      state.sessions.push(session);
      broadcast();
      saveState();
      sendResponse({ ok: true, sessionId });
      return false;
    }
    case "PUSH_PROMPTS": {
      // From bridge.js (dashboard) — schedule an image-batch session.
      // Layout:
      //   - inputImages: pre-supplied reference URLs (eg product photo)
      //   - refPrompts:  run first, no refs attached, outputs become refs
      //   - prompts:     run after, all input+generated refs attached
      const refPrompts = Array.isArray(msg.refPrompts) ? msg.refPrompts.map(String).filter(Boolean) : [];
      const prompts = Array.isArray(msg.prompts) ? msg.prompts.map(String).filter(Boolean) : [];
      const inputImages = Array.isArray(msg.inputImages)
        ? msg.inputImages
            .map((img) => ({
              name: String(img?.name || "input.png"),
              url: String(img?.url || ""),
            }))
            .filter((img) => img.url)
        : [];
      if (!refPrompts.length && !prompts.length) {
        sendResponse({ ok: false, error: "no prompts" });
        return false;
      }
      const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const session = {
        id: sessionId,
        kind: "imgbatch",
        inputImages, // [{name, url}] — fetched in content script via SW
        createdAt: Date.now(),
        status: "pending",
        pairs: [],
      };
      let idx = 0;
      for (const p of refPrompts) {
        const pid = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${idx}`;
        session.pairs.push({
          id: pid,
          productName: `Ref ${idx + 1}`,
          listingName: "",
          status: "pending",
        });
        pairDataMap.set(pid, { prompt: p, role: "ref", refIndex: idx });
        idx++;
      }
      let mainIdx = 0;
      for (const p of prompts) {
        const pid = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${idx}`;
        session.pairs.push({
          id: pid,
          productName: `Prompt ${mainIdx + 1}`,
          listingName: "",
          status: "pending",
        });
        pairDataMap.set(pid, { prompt: p, role: "main", mainIndex: mainIdx });
        mainIdx++;
        idx++;
      }
      state.sessions.push(session);
      broadcast();
      saveState();
      // Auto-start if not running
      if (!state.running) startQueue();
      sendResponse({
        ok: true,
        sessionId,
        refCount: refPrompts.length,
        promptCount: prompts.length,
        inputCount: inputImages.length,
      });
      return false;
    }
    case "ADD_VIDEO_SESSION": {
      const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const session = {
        id: sessionId,
        kind: "video",
        createdAt: Date.now(),
        status: "pending",
        pairs: [],
      };
      const refs = msg.refs || [];
      const extras = (msg.extras || []).filter((e) => e && e.name && e.dataUrl);
      const mainRef = refs.find((r) => r.role === "product");
      const supportRefs = refs.filter((r) => r.role !== "product");
      const supportNames = supportRefs.map((r) => r.name).filter(Boolean);
      const mainRefNames = [mainRef?.name, ...supportNames].filter(Boolean);

      const scenes = msg.scenes || [];
      const scene1 = scenes.find((s) => s.index === 1) || scenes[0];

      // Main scenes
      for (const scene of scenes) {
        if (!mainRef) break;
        const pid = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        session.pairs.push({
          id: pid,
          productName: scene.label || `Scene ${scene.index}`,
          listingName: "",
          status: "pending",
        });
        pairDataMap.set(pid, {
          sceneText: scene.text,
          sceneIndex: scene.index,
          refNames: mainRefNames,
        });
      }
      // Extra products → only Scene 1, with extra replacing main
      if (scene1) {
        for (const ex of extras) {
          const pid = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          const baseName = (ex.name || "extra").replace(/\.[^.]+$/, "");
          session.pairs.push({
            id: pid,
            productName: `Scene 1 (${baseName})`,
            listingName: "",
            status: "pending",
          });
          pairDataMap.set(pid, {
            sceneText: scene1.text,
            sceneIndex: 1,
            refNames: [ex.name, ...supportNames],
            extraTag: baseName,
          });
        }
      }

      // Session-level refs: dedupe by name (main + supports + extras)
      const seen = new Set();
      const allRefs = [];
      for (const r of refs) {
        if (r?.name && !seen.has(r.name)) {
          seen.add(r.name);
          allRefs.push(r);
        }
      }
      for (const ex of extras) {
        if (!seen.has(ex.name)) {
          seen.add(ex.name);
          allRefs.push({ role: "extra", name: ex.name, dataUrl: ex.dataUrl });
        }
      }
      videoSessionData.set(sessionId, {
        refs: allRefs,
        appendix: msg.appendix || "",
      });
      state.sessions.push(session);
      broadcast();
      saveState();
      sendResponse({ ok: true, sessionId });
      return false;
    }
    case "ADD_UPSCALE_SESSION": {
      const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const session = {
        id: sessionId,
        kind: "upscale",
        upscalePrompt: msg.prompt || state.settings.upscalePrompt || DEFAULT_UPSCALE_PROMPT,
        createdAt: Date.now(),
        status: "pending",
        pairs: [],
      };
      for (const img of msg.images || []) {
        const pid = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        session.pairs.push({
          id: pid,
          productName: img.name,
          listingName: "",
          status: "pending",
        });
        pairDataMap.set(pid, {
          productDataUrl: img.dataUrl,
          listingDataUrl: null,
        });
      }
      state.sessions.push(session);
      broadcast();
      saveState();
      sendResponse({ ok: true, sessionId });
      return false;
    }
    case "ADD_TRADEMARK_SESSION": {
      const images = (msg.images || []).filter((i) => i && i.dataUrl);
      if (!images.length) {
        sendResponse({ ok: false, error: "no images" });
        return false;
      }
      const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const session = {
        id: sessionId,
        kind: "trademark",
        createdAt: Date.now(),
        status: "pending",
        pairs: [],
      };
      // One pair per image so the queue UI shows N items, but they're all
      // submitted as ONE Gemini message.
      for (const img of images) {
        const pid = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        session.pairs.push({
          id: pid,
          productName: img.name,
          listingName: "",
          status: "pending",
        });
        pairDataMap.set(pid, {
          productDataUrl: img.dataUrl,
          listingDataUrl: null,
        });
      }
      state.sessions.push(session);
      broadcast();
      saveState();
      sendResponse({ ok: true, sessionId });
      return false;
    }
    case "REMOVE_SESSION": {
      const i = state.sessions.findIndex((s) => s.id === msg.sessionId);
      if (i >= 0 && state.sessions[i].status !== "running") {
        for (const p of state.sessions[i].pairs) pairDataMap.delete(p.id);
        videoSessionData.delete(state.sessions[i].id);
        state.sessions.splice(i, 1);
      }
      broadcast();
      saveState();
      sendResponse({ ok: true });
      return false;
    }
    case "CLEAR_DONE": {
      const toRemove = state.sessions.filter((s) =>
        ["done", "error", "cancelled"].includes(s.status)
      );
      for (const s of toRemove) {
        for (const p of s.pairs) pairDataMap.delete(p.id);
        videoSessionData.delete(s.id);
      }
      state.sessions = state.sessions.filter(
        (s) => !["done", "error", "cancelled"].includes(s.status)
      );
      broadcast();
      saveState();
      sendResponse({ ok: true });
      return false;
    }
    case "UPDATE_SETTINGS": {
      const s = msg.settings || {};
      state.settings = { ...state.settings, ...s };
      if (state.settings.waitMax < state.settings.waitMin)
        state.settings.waitMax = state.settings.waitMin;
      state.settings.concurrency = Math.max(
        1,
        Math.min(10, state.settings.concurrency || 1)
      );
      broadcast();
      saveSettings();
      sendResponse({ ok: true });
      return false;
    }
    case "START_QUEUE":
      startQueue();
      sendResponse({ ok: true });
      return false;
    case "STOP_QUEUE":
      stopQueue();
      sendResponse({ ok: true });
      return false;

    // ----- from content script -----
    case "CDP_INSERT_TEXT": {
      const id = sender.tab?.id;
      if (!id) return false;
      cdpInsertText(id, msg.text).then(
        () => sendResponse({ success: true }),
        (e) => sendResponse({ success: false, error: String(e) })
      );
      return true;
    }
    case "CDP_CLICK": {
      const id = sender.tab?.id;
      if (!id) return false;
      cdpClick(id, msg.x, msg.y).then(
        () => sendResponse({ success: true }),
        (e) => sendResponse({ success: false, error: String(e) })
      );
      return true;
    }
    case "CDP_KEY": {
      const id = sender.tab?.id;
      if (!id) return false;
      cdpKey(id, msg.key, msg.keyCode, msg.code, msg.modifiers || 0).then(
        () => sendResponse({ success: true }),
        (e) => sendResponse({ success: false, error: String(e) })
      );
      return true;
    }
    case "CDP_ATTACH": {
      const id = sender.tab?.id;
      if (!id) return false;
      attachDebugger(id).then(
        () => sendResponse({ success: true }),
        (e) => sendResponse({ success: false, error: String(e) })
      );
      return true;
    }
    case "CDP_DETACH": {
      const id = sender.tab?.id;
      if (!id) return false;
      detachDebugger(id).then(
        () => sendResponse({ success: true }),
        () => sendResponse({ success: true })
      );
      return true;
    }
    case "TILE_DOWNLOAD_WINDOW": {
      // content.js calls this to bracket a single-tile download. Inside the
      // window, only ONE download is accepted per tab; the rest get cancelled.
      const tabUrl = sender.tab?.url || "";
      const key = makeTabKey(tabUrl);
      if (msg.open) {
        tileDownloadGate.set(key, {
          acceptedOne: false,
          expiresAt: Date.now() + (msg.ttlMs || 15000),
        });
      } else {
        tileDownloadGate.delete(key);
      }
      sendResponse({ ok: true });
      return false;
    }
    case "REGISTER_DOWNLOAD_NAME": {
      const { url, filename } = msg;
      if (url && filename) renameMap.set(url, filename);
      sendResponse({ ok: true });
      return false;
    }
    case "DOWNLOAD_URL": {
      if (state.settings.downloadQuality === "none") {
        sendResponse({ success: true, skipped: true });
        return false;
      }
      const { url, filename } = msg;
      const folder = state.settings.folder
        ? `${state.settings.folder.trim().replace(/\/+$/, "")}/`
        : "";
      const target = filename
        ? `${folder}${state.settings.prefix || ""}${filename}`
        : undefined;
      if (target) renameMap.set(url, target);
      chrome.downloads.download(
        { url, filename: target, saveAs: false },
        (id) => {
          const err = chrome.runtime?.lastError;
          if (err || !id) {
            sendResponse({ success: false, error: err?.message || "Failed" });
          } else {
            sendResponse({ success: true, downloadId: id });
          }
        }
      );
      return true;
    }
    case "PAIR_PROGRESS": {
      // Optional update from content script when a pair completes mid-batch
      const { sessionId, pairId, status, error, outputs } = msg;
      const session = state.sessions.find((s) => s.id === sessionId);
      if (session) {
        const p = session.pairs.find((pp) => pp.id === pairId);
        if (p) {
          if (status) p.status = status;
          if (error) p.error = error;
          if (outputs) p.outputs = outputs;
          broadcast();
          saveState();
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    case "FETCH_AS_DATA_URL": {
      // For data: URLs and dashboard-hosted URLs (zaa-image, etc.) the SW can
      // fetch directly. credentials:"omit" because none of those need cookies.
      (async () => {
        try {
          const r = await fetch(msg.url, { credentials: "omit" });
          if (!r.ok) {
            sendResponse({ ok: false, error: `HTTP ${r.status}` });
            return;
          }
          const blob = await r.blob();
          const reader = new FileReader();
          reader.onload = () => sendResponse({ ok: true, dataUrl: String(reader.result) });
          reader.onerror = () => sendResponse({ ok: false, error: "read failed" });
          reader.readAsDataURL(blob);
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }
    case "FETCH_TILE_VIA_MAIN_WORLD": {
      // Flow tile URLs (`labs.google/fx/api/trpc/media.getMediaUrlRedirect`)
      // redirect to `flow-content.google` whose response carries
      // `Access-Control-Allow-Origin: *`. Wildcard ACAO is INVALID with
      // credentials → so credentials must be stripped on the redirect hop.
      // `credentials:"same-origin"` does exactly that: cookies sent only on
      // same-origin hops, stripped on cross-origin redirects.
      //
      // BUT this only works from the PAGE origin (labs.google). MV3 content-
      // script fetches run from `chrome-extension://` (cross-origin to
      // labs.google) so even "same-origin" sends no cookies → trpc auth fails.
      // The fix is to inject a fetch into the page's MAIN world via
      // chrome.scripting, where the fetch origin = labs.google.
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "no sender tab" });
        return false;
      }
      (async () => {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: async (url) => {
              const r = await fetch(url, { credentials: "same-origin" });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const blob = await r.blob();
              return await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result));
                fr.onerror = () => reject(new Error("read failed"));
                fr.readAsDataURL(blob);
              });
            },
            args: [msg.url],
          });
          const dataUrl = results?.[0]?.result;
          if (!dataUrl) {
            sendResponse({ ok: false, error: "main-world fetch returned no data" });
            return;
          }
          sendResponse({ ok: true, dataUrl });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
      return true;
    }
    case "JOB_LOG":
      console.log(`[zps ${msg.jobId || "-"}]`, msg.message);
      return false;
  }
  return false;
});

// ---------- boot ----------
loadAll().then(() => broadcast());

// ============================================================================
// Project-O bridge poller (added on top of the Zecom sample).
// Polls <BASE>/api/bridge/next → runs each job as a single Flow "upscale" (1
// image in → 1 image out, no listing) via the existing RUN_BATCH machinery →
// fetches the output tile → POSTs it back to /api/bridge/result/:id.
// Configure BASE + token on the options page (default http://localhost:4500).
// ============================================================================
const PO_DEFAULT_BASE = "http://localhost:4500";
let poBusy = false;
let poFlowTabId = null;

async function poGetConfig() {
  const c = await chrome.storage.local.get(["bridgeBase", "bridgeToken", "bridgeEnabled"]);
  return { base: (c.bridgeBase || PO_DEFAULT_BASE).replace(/\/+$/, ""), token: c.bridgeToken || "", enabled: c.bridgeEnabled !== false };
}
const poAuth = (t) => (t ? { "x-bridge-token": t } : {});

async function poEnsureFlowTab() {
  let tab = null;
  if (poFlowTabId != null) { try { tab = await chrome.tabs.get(poFlowTabId); } catch { poFlowTabId = null; } }
  if (!tab) {
    const existing = await chrome.tabs.query({ url: "*://labs.google/*" });
    tab = existing[0] || (await chrome.tabs.create({ url: FLOW_URL, active: false }));
    poFlowTabId = tab.id;
  }
  // Must be on the Flow tool page (content.js takes it into a project from there).
  if (!/labs\.google\/fx\/tools\/flow/.test(tab.url || "")) {
    try { await chrome.tabs.update(tab.id, { url: FLOW_URL }); } catch {}
  }
  await attachDebugger(tab.id);
  await waitForTabComplete(tab.id);
  await keepTabActive(tab.id);
  // A tab opened BEFORE the extension was (re)loaded has NO auto-injected content
  // script → sendMessage fails with "receiving end does not exist". Inject it now
  // (idempotent — content.js guards against double-init).
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); }
  catch (e) { console.warn("[po-bridge] inject content.js failed", e); }
  await new Promise((r) => setTimeout(r, 1500));
  return tab.id;
}

async function poUrlToDataUrl(url, base, token) {
  const abs = /^https?:/i.test(url) ? url : base + url;
  const r = await fetch(abs, { headers: poAuth(token) });
  if (!r.ok) throw new Error("fetch input " + r.status);
  const blob = await r.blob();
  return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

async function poSendRunBatch(tabId, payload, job) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (e) {
    // "Receiving end does not exist" → content.js not there yet. Inject + retry once.
    console.warn("[po-bridge] sendMessage failed, re-injecting content.js…", e?.message || e);
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    return await chrome.tabs.sendMessage(tabId, payload);
  }
}

async function poRunJob(job, cfg) {
  const tabId = await poEnsureFlowTab();
  const dataUrl = await poUrlToDataUrl(job.imageUrl, cfg.base, cfg.token);
  const pairId = "po_" + job.id;
  const resp = await poSendRunBatch(tabId, {
    type: "RUN_BATCH",
    kind: "upscale", // single image + prompt → single output (no listing image)
    settings: { ...state.settings, imageEngine: "flow", downloadQuality: "original", cdpInput: true, autoRename: false, closeTabAfter: false },
    jobs: [{ id: pairId, productName: "input.png", productDataUrl: dataUrl, listingName: "", listingDataUrl: null, prompt: job.prompt }],
  }, job);
  const r = resp && resp.results && resp.results[pairId];
  const tileUrl = r && (r.outputs || []).find(Boolean);
  if (!tileUrl) throw new Error((resp && (resp.error)) || (r && r.error) || "Flow returned no output tile");
  const img = await fetch(tileUrl); // googleusercontent — host_permissions cover it
  if (!img.ok) throw new Error("fetch tile " + img.status);
  const bytes = await img.blob();
  const pr = await fetch(`${cfg.base}/api/bridge/result/${job.id}`, {
    method: "POST", headers: { ...poAuth(cfg.token), "Content-Type": "image/png" }, body: bytes,
  });
  if (!pr.ok) throw new Error("post result " + pr.status);
}

async function poPoll() {
  if (poBusy) return;
  const cfg = await poGetConfig();
  if (!cfg.enabled) return;
  poBusy = true;
  try {
    let r;
    try { r = await fetch(`${cfg.base}/api/bridge/next`, { headers: poAuth(cfg.token) }); } catch { return; }
    if (!r.ok) return;
    const { job } = await r.json();
    if (!job) return;
    console.log("[po-bridge] flow job", job.id, (job.prompt || "").slice(0, 50));
    try { await poRunJob(job, cfg); console.log("[po-bridge] done", job.id); }
    catch (e) {
      console.warn("[po-bridge] job failed", job.id, e);
      try {
        await fetch(`${cfg.base}/api/bridge/fail/${job.id}`, {
          method: "POST", headers: { ...poAuth(cfg.token), "Content-Type": "application/json" },
          body: JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }),
        });
      } catch {}
    }
  } finally { poBusy = false; }
}

chrome.alarms.create("po-poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "po-poll") poPoll(); });
setInterval(poPoll, 5000);
poPoll();
