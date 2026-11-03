// Zecom Product Swap — ChatGPT Content Script
// For swap + imgbatch when imageEngine === "chatgpt".
// Uploads images + types the prompt + clicks Send for each job. No download —
// user reviews / saves results manually (matches gemini.js pattern).

(() => {
  if (window.__zpsChatGptInjected) return;
  window.__zpsChatGptInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(jobId, ...args) {
    console.log("[zps:chatgpt]", jobId || "-", ...args);
    chrome.runtime
      .sendMessage({ type: "JOB_LOG", jobId, message: args.map(String).join(" ") })
      .catch(() => {});
  }

  function isVisible(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    return true;
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

  function dataUrlToFile(dataUrl, name) {
    const [meta, b64] = dataUrl.split(",");
    const mime = (meta.match(/data:([^;]+)/) || [, "image/png"])[1];
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], name || `image.${mime.split("/")[1] || "png"}`, { type: mime });
  }

  // Fetch a remote URL (eg dashboard-supplied input image) → File via the SW.
  // The SW has host_permissions for those origins; content-script fetch from
  // chatgpt.com would be cross-origin.
  async function urlToFile(url, name) {
    const r = await chrome.runtime.sendMessage({ type: "FETCH_AS_DATA_URL", url });
    if (!r?.ok || !r.dataUrl) throw new Error(`fetch ${name}: ${r?.error || "unknown"}`);
    return dataUrlToFile(r.dataUrl, name);
  }

  function findPromptInput() {
    const el =
      document.getElementById("prompt-textarea") ||
      document.querySelector('div[contenteditable="true"][data-id]') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("textarea");
    return el && isVisible(el) ? el : null;
  }

  function findSendButton() {
    const explicit =
      document.querySelector('[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send" i]') ||
      document.querySelector('button[aria-label*="Gửi" i]');
    if (explicit && isVisible(explicit) && !explicit.disabled) return explicit;
    return null;
  }

  function findFileInputDeep() {
    function walk(root) {
      try {
        const direct = root.querySelectorAll?.('input[type="file"]');
        if (direct && direct.length) {
          for (const i of direct) if (/image/i.test(i.accept || "")) return i;
          for (const i of direct) if (!i.accept) return i;
          return direct[0];
        }
        const all = root.querySelectorAll?.("*") || [];
        for (const el of all) {
          if (el.shadowRoot) {
            const r = walk(el.shadowRoot);
            if (r) return r;
          }
        }
      } catch {}
      return null;
    }
    return walk(document);
  }

  async function humanType(el, text) {
    el.focus();
    let i = 0;
    while (i < text.length) {
      const chunkLen = 4 + Math.floor(Math.random() * 5); // 4-8 chars (đồng nhất Flow)
      const piece = text.slice(i, i + chunkLen);
      const ok = document.execCommand("insertText", false, piece);
      if (!ok) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(piece));
          range.collapse(false);
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: piece, inputType: "insertText" }));
      }
      i += chunkLen;
      let delay = 15 + Math.random() * 35; // 15-50ms (đồng nhất Flow)
      if (Math.random() < 0.03) delay += 150 + Math.random() * 250; // 3% × 150-400ms rare pause
      await sleep(delay);
    }
  }

  // Attach a batch of files. Try hidden <input type="file"> first (reliable),
  // fall back to clipboard-paste into the prompt (works on ChatGPT too).
  async function attachFiles(jobId, files, promptEl) {
    if (!files.length) return true;
    const fileInput = findFileInputDeep();
    if (fileInput) {
      try {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        log(jobId, `attached ${files.length} file(s) via input`);
        return true;
      } catch (e) {
        log(jobId, "file input set failed, falling back to paste:", String(e));
      }
    }
    promptEl?.focus();
    await sleep(150);
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    try {
      if (!pasteEvent.clipboardData || pasteEvent.clipboardData !== dt) {
        Object.defineProperty(pasteEvent, "clipboardData", { value: dt, configurable: true });
      }
    } catch {}
    promptEl?.dispatchEvent(pasteEvent);
    log(jobId, `attached ${files.length} file(s) via paste`);
    return true;
  }

  // Clear contenteditable / textarea between jobs so a new prompt starts blank.
  function clearPrompt(el) {
    if (!el) return;
    if (el.tagName === "TEXTAREA") {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    }
  }

  // Wait until the previous assistant turn is finished (no Stop button) AND a
  // fresh Send button shows up — that's when ChatGPT is ready for the next
  // prompt. Falls back to a fixed delay after `maxMs` so we always make
  // progress even when DOM signals shift between ChatGPT releases.
  async function waitReady(maxMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const stop =
        document.querySelector('[data-testid="stop-button"]') ||
        document.querySelector('button[aria-label*="Stop" i]');
      if (!stop && findSendButton()) return true;
      await sleep(700);
    }
    return false;
  }

  let cancelled = false;

  async function runChatGptBatch(msg) {
    cancelled = false;
    const { jobs, sessionId, kind, inputImages } = msg;
    const results = {};
    for (const j of jobs) results[j.id] = { success: false, outputs: [], error: null };

    try {
      log(sessionId, `chatgpt batch start — kind=${kind} · ${jobs.length} job(s)`);

      const promptEl = await waitFor(findPromptInput, { timeout: 60000 });
      if (!promptEl) throw new Error("ChatGPT prompt input not found");

      // Imgbatch: pre-fetch dashboard inputImages once; reuse on every job.
      const sharedFiles = [];
      if (kind === "imgbatch" && Array.isArray(inputImages) && inputImages.length) {
        for (let i = 0; i < inputImages.length; i++) {
          const im = inputImages[i];
          try {
            sharedFiles.push(await urlToFile(im.url, im.name || `input${i + 1}.png`));
          } catch (e) {
            log(sessionId, `inputImage ${im?.name || i} fetch failed:`, String(e));
          }
        }
        log(sessionId, `prefetched ${sharedFiles.length}/${inputImages.length} input image(s)`);
      }

      for (let i = 0; i < jobs.length; i++) {
        if (cancelled) {
          log(sessionId, "cancelled mid-batch");
          break;
        }
        const j = jobs[i];
        try {
          // Build per-job file list: shared inputs + the job's own images.
          const files = [...sharedFiles];
          if (j.productDataUrl) files.push(dataUrlToFile(j.productDataUrl, j.productName || `product${i + 1}.png`));
          if (j.listingDataUrl) files.push(dataUrlToFile(j.listingDataUrl, j.listingName || `listing${i + 1}.png`));

          // Re-find prompt (ChatGPT re-mounts the input after each turn).
          const pel = (await waitFor(findPromptInput, { timeout: 30000 })) || promptEl;
          pel.focus();
          await sleep(200);
          clearPrompt(pel);
          await sleep(150);

          await attachFiles(j.id, files, pel);
          // Give ChatGPT time to ingest the uploads before typing.
          await sleep(3500);

          pel.focus();
          await sleep(200);
          await humanType(pel, j.prompt || "");
          await sleep(500);

          const sendBtn = await waitFor(findSendButton, { timeout: 60000 });
          if (!sendBtn) throw new Error("send button never enabled");
          log(j.id, `submitting job ${i + 1}/${jobs.length}`);
          sendBtn.click();

          // Per pacing memory: ~7s after trigger before doing anything else.
          await sleep(7000);
          // Wait for ChatGPT to finish replying so the next job has a clean slate.
          await waitReady();

          results[j.id] = { success: true, outputs: [], error: null };
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          log(j.id, "ERROR:", m);
          results[j.id] = { success: false, outputs: [], error: m };
        }
      }

      log(sessionId, "chatgpt batch done");
      return { success: true, results };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(sessionId, "BATCH ERROR:", m);
      for (const j of jobs) {
        if (!results[j.id].success) results[j.id] = { success: false, outputs: [], error: m };
      }
      return { success: false, error: m, results };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "RUN_CHATGPT") {
      runChatGptBatch(msg).then(sendResponse);
      return true;
    }
    if (msg?.type === "CANCEL_BATCH") {
      cancelled = true;
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === "PING") {
      sendResponse({ ok: true, url: location.href });
      return false;
    }
    return false;
  });

  log(null, "Zecom Product Swap (ChatGPT) content script loaded on", location.href);
})();
