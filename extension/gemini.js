// Zecom Product Swap — Gemini Trademark Content Script
// Uploads images to gemini.google.com/app and submits a fixed prompt.

(() => {
  if (window.__zpsGeminiInjected) return;
  window.__zpsGeminiInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(jobId, ...args) {
    console.log("[zps:gemini]", jobId || "-", ...args);
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

  // Convert data URL → File for DataTransfer.
  function dataUrlToFile(dataUrl, name) {
    const [meta, b64] = dataUrl.split(",");
    const mime = (meta.match(/data:([^;]+)/) || [, "image/png"])[1];
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], name || `image.${mime.split("/")[1] || "png"}`, { type: mime });
  }

  // Find any <input type="file"> on the page, walking shadow roots too.
  function findFileInputDeep() {
    function walk(root) {
      try {
        const direct = root.querySelectorAll?.('input[type="file"]');
        if (direct && direct.length) {
          // Prefer one accepting images
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

  // The "+" / upload button on Gemini's prompt bar. Clicking it makes Gemini
  // mount the hidden <input type="file"> into the DOM.
  function findAddButton() {
    const buttons = [...document.querySelectorAll("button")];
    return (
      buttons.find((b) => {
        if (!isVisible(b)) return false;
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const cls = (b.className || "").toLowerCase();
        return (
          aria.includes("upload") ||
          aria.includes("attach") ||
          aria.includes("add file") ||
          aria.includes("open upload") ||
          aria.includes("tải lên") ||
          aria.includes("đính kèm") ||
          cls.includes("upload-card-button")
        );
      }) || null
    );
  }

  // Try to reveal the file input by clicking the add/upload menu button. Some
  // builds of Gemini lazy-mount the input only after the menu is opened.
  async function ensureFileInput() {
    let input = findFileInputDeep();
    if (input) return input;

    const addBtn = findAddButton();
    if (addBtn) {
      addBtn.click();
      await sleep(600);
      input = findFileInputDeep();
      if (input) return input;

      // Some builds need a second click on an "Upload files" submenu item to
      // mount the input.
      const menuItems = [...document.querySelectorAll('[role="menuitem"], button')];
      const uploadItem = menuItems.find((el) => {
        if (!isVisible(el)) return false;
        const text = (el.textContent || "").toLowerCase();
        return (
          text.includes("upload file") ||
          text.includes("upload image") ||
          text.includes("tải lên")
        );
      });
      if (uploadItem) {
        uploadItem.click();
        await sleep(600);
        input = findFileInputDeep();
        if (input) return input;
      }
    }
    return null;
  }

  // Find the rich-text input area in Gemini.
  function findPromptInput() {
    // Gemini uses <rich-textarea> with a contenteditable inside.
    const rte = document.querySelector("rich-textarea");
    if (rte) {
      const ce = rte.querySelector('[contenteditable="true"], [contenteditable=""]');
      if (ce && isVisible(ce)) return ce;
    }
    // Generic fallback
    const cands = [...document.querySelectorAll('[contenteditable="true"]')];
    return cands.find(isVisible) || null;
  }

  function findSendButton() {
    // aria-label varies by locale; try common patterns + class hints.
    const buttons = [...document.querySelectorAll('button')];
    return (
      buttons.find((b) => {
        if (!isVisible(b)) return false;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const cls = (b.className || "").toLowerCase();
        return (
          aria.includes("send") ||
          aria.includes("gửi") ||
          aria.includes("submit") ||
          cls.includes("send-button")
        );
      }) || null
    );
  }

  // Human-paced typing (per memory feedback_pacing.md): slow chunks, not paste.
  async function humanType(el, text) {
    el.focus();
    let i = 0;
    while (i < text.length) {
      const chunkLen = 3 + Math.floor(Math.random() * 4); // 3-6 chars
      const piece = text.slice(i, i + chunkLen);
      // execCommand is deprecated but still works inside contenteditable for
      // dispatching input events that frameworks (Lit/Angular) listen to.
      const ok = document.execCommand("insertText", false, piece);
      if (!ok) {
        // Manual fallback
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
      let delay = 25 + Math.random() * 60; // 25-85ms
      if (Math.random() < 0.05) delay += 250 + Math.random() * 350;
      await sleep(delay);
    }
  }

  async function runTrademark(msg) {
    const { jobs, prompt, sessionId } = msg;
    const results = {};
    for (const j of jobs) results[j.id] = { success: false, outputs: [], error: null };

    try {
      log(sessionId, `trademark session start (${jobs.length} images)`);

      // Wait for Gemini to fully load — the prompt input must exist
      const promptEl = await waitFor(findPromptInput, { timeout: 30000 });
      if (!promptEl) throw new Error("Gemini prompt input not found");

      // Build File list from data URLs
      const files = jobs
        .filter((j) => j.dataUrl)
        .map((j) => dataUrlToFile(j.dataUrl, j.name));
      if (!files.length) throw new Error("no valid images");

      // Strategy 1: hidden <input type="file">. Some Gemini builds lazy-mount
      // it only after the upload menu is opened, so we click the add button
      // first if needed.
      let uploaded = false;
      const fileInput = await ensureFileInput();
      if (fileInput) {
        log(sessionId, `uploading ${files.length} file(s) via input`);
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        try {
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          uploaded = true;
        } catch (e) {
          log(sessionId, "file input set failed:", String(e));
        }
      }

      // Strategy 2: paste images directly into the prompt contenteditable. This
      // is what Cmd/Ctrl+V does and Gemini handles it reliably.
      if (!uploaded) {
        log(sessionId, `pasting ${files.length} file(s) into prompt`);
        promptEl.focus();
        await sleep(200);
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        const pasteEvent = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        // Some browsers ignore clipboardData passed to the constructor;
        // force-define it so handlers see the files.
        try {
          if (!pasteEvent.clipboardData || pasteEvent.clipboardData !== dt) {
            Object.defineProperty(pasteEvent, "clipboardData", { value: dt, configurable: true });
          }
        } catch {}
        promptEl.dispatchEvent(pasteEvent);
        uploaded = true;
      }

      // Give Gemini time to ingest the uploads and show chips
      await sleep(3500);

      // Focus prompt and type the message
      promptEl.focus();
      await sleep(300);
      await humanType(promptEl, prompt);
      await sleep(600);

      // Wait until the send button becomes enabled, then click
      const sendBtn = await waitFor(findSendButton, { timeout: 60000 });
      if (!sendBtn) throw new Error("send button not found / still disabled");
      log(sessionId, "clicking send");
      sendBtn.click();

      // Wait ~7s after trigger, per pacing memory, before reporting done
      await sleep(7000);

      for (const j of jobs) results[j.id] = { success: true, outputs: [], error: null };
      log(sessionId, "trademark session submitted");
      return { success: true, results };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(sessionId, "ERROR:", m);
      for (const j of jobs) {
        if (!results[j.id].success) results[j.id] = { success: false, outputs: [], error: m };
      }
      return { success: false, error: m, results };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "RUN_TRADEMARK") {
      runTrademark(msg).then(sendResponse);
      return true;
    }
    if (msg?.type === "PING") {
      sendResponse({ ok: true, url: location.href });
      return false;
    }
    return false;
  });

  log(null, "Zecom Product Swap (Gemini) content script loaded on", location.href);
})();
