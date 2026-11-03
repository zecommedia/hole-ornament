// Zecom Product Swap — Side Panel UI

const DEFAULT_UPSCALE_PROMPT = "upscale this image without changing any details";

const DEFAULT_SETTINGS = {
  // Generation
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
  // Batch
  concurrency: 2,
  waitMin: 1,
  waitMax: 3,
  autoRetry: false,
  maxRetries: 2,
  closeTabAfter: true,
  // Downloads
  folder: "zecom-swap",
  prefix: "",
  filenameTemplate: "{idx}_{product}__{listing}_{n}.{ext}",
  autoRename: true,
  // Anti-detect
  clearCookies: false,
  disableCache: true,
  cdpInput: true,
  runInWindow: false,
  // General
  language: "vi",
  defaultMode: "image-to-image",
  zoomLevel: 100,
};

const I18N = {
  vi: {
    subtitle: "Pair 1 product × N listings → batch swap trên Google Flow",
    tab_run: "Chạy",
    tab_upscale: "Upscale",
    tab_video: "Video",
    tab_trademark: "Trademark",
    tab_queue: "Queue",
    tab_settings: "Settings",
    trademark_imgs: "Ảnh cần check trademark",
    drop_trademark: "Kéo thả hoặc bấm để chọn ảnh check trademark",
    enqueue_trademark: "+ Thêm session trademark",
    trademark_fixed: "Cố định: Gemini · prompt \"Check Trademark cho tôi các thiết kế này\"",
    product_imgs: "Ảnh sản phẩm",
    listing_imgs: "Ảnh listing",
    upscale_imgs: "Ảnh cần upscale",
    drop_upscale: "Kéo thả hoặc bấm để chọn ảnh upscale",
    upscale_prompt_label: "Prompt upscale",
    upscale_prompt_desc: "Prompt dùng cho tất cả ảnh trong session",
    enqueue_upscale: "+ Thêm session upscale",
    vid_product: "Sản phẩm chính",
    vid_giver: "Người tặng",
    vid_receiver: "Người nhận",
    vid_extras: "Sản phẩm phụ (mỗi ảnh chỉ chạy Scene 1)",
    drop_vid_extras: "Kéo thả hoặc bấm để chọn sản phẩm phụ",
    drop_one: "Chọn 1 ảnh",
    vid_script_label: "Kịch bản (full SCENE 1, 2, …, Style:, Audio:)",
    vid_script_desc: "4s/6s/8s: mỗi SCENE chạy 1 clip riêng. 10s: chạy 2 lần, mỗi lần gộp 2 scene.",
    vid_model: "Model",
    vid_outputs: "Outputs",
    vid_duration: "Duration",
    enqueue_video: "+ Thêm session video",
    vid_fixed: "Cố định: 16:9 · video luôn chạy trên Flow",
    image_engine: "Engine gen ảnh",
    image_engine_desc: "Áp dụng cho Swap + Imgbatch (Upscale luôn dùng Flow, Video luôn dùng Flow)",
    engine_flow: "Google Flow (Nano Banana)",
    engine_chatgpt: "ChatGPT",
    clear_all: "Xoá hết",
    drop_product: "Kéo thả hoặc bấm để chọn ảnh sản phẩm",
    drop_listing: "Kéo thả hoặc bấm để chọn ảnh listing",
    pair_mode: "Chế độ ghép cặp",
    pair_one_to_many: "1 product → tất cả listings",
    pair_zip: "Ghép theo thứ tự (product[i] × listing[i])",
    enqueue: "+ Thêm vào queue",
    queue_title: "Queue",
    start: "▶ Start",
    stop: "⏹ Stop",
    clear_done: "Xoá job xong",
    grp_generation: "Generation",
    prompt_label: "Prompt",
    prompt_desc: "Có thể dùng biến: {product}, {listing}",
    aspect_ratio: "Tỉ lệ khung",
    aspect_desc: "Áp dụng khi Flow hỗ trợ",
    aspect_auto: "Tự động (giữ nguyên)",
    outputs_per_prompt: "Output/prompt",
    outputs_desc: "Số ảnh mỗi prompt (1–4)",
    image_model: "Image model",
    image_model_desc: "Model dùng cho Nano Banana",
    model_auto: "Tự động (mặc định Flow)",
    download_quality: "Chất lượng tải",
    download_quality_desc: "Chất lượng ảnh khi auto-download",
    quality_original: "Bản gốc",
    quality_highest: "Cao nhất có sẵn",
    quality_none: "Không download",
    grp_batch: "Batch & Concurrency",
    concurrent: "Song song",
    concurrent_desc: "Số session chạy đồng thời",
    wait_min: "Wait min (s)",
    wait_min_desc: "Delay tối thiểu trước prompt kế",
    wait_max: "Wait max (s)",
    wait_max_desc: "Delay tối đa (random trong khoảng)",
    auto_retry: "Tự động retry khi lỗi",
    max_retries: "Số lần retry tối đa",
    close_tab: "Đóng tab sau khi xong (song song > 1)",
    grp_downloads: "Downloads",
    folder: "Folder lưu",
    folder_desc: "Subfolder cho file download",
    prefix: "Prefix tên file",
    prefix_desc: "Tiền tố thêm vào trước tên file",
    filename_template: "Mẫu tên file",
    filename_template_desc: "Biến: {idx} {product} {listing} {n} {ext}",
    auto_rename: "Tự đổi tên file theo cặp",
    grp_antidetect: "Anti-detect",
    clear_cookies: "Xoá cookies labs.google trước khi chạy",
    disable_cache: "Disable cache trên tab",
    cdp_input: "Dùng CDP cho click/text (giảm bị detect bot)",
    run_in_window: "Mở mỗi session trong cửa sổ riêng (chống throttle khi nhiều session)",
    grp_general: "Tổng quát",
    language: "Ngôn ngữ",
    default_mode: "Default mode khi mở session",
    mode_i2i: "Image to Image (swap product)",
    mode_t2i: "Text to Image",
    zoom: "Zoom tab (%)",
    save_settings: "💾 Lưu cài đặt",
    reset_defaults: "↺ Reset mặc định",
    export: "Export JSON",
    import: "Import JSON",
    saved: "Đã lưu cài đặt",
    reset_confirm: "Reset toàn bộ về mặc định?",
    reset_done: "Đã reset",
    imported: "Đã import",
    invalid_json: "JSON không hợp lệ",
  },
  en: {
    subtitle: "Pair 1 product × N listings → batch swap on Google Flow",
    tab_run: "Run",
    tab_upscale: "Upscale",
    tab_video: "Video",
    tab_trademark: "Trademark",
    tab_queue: "Queue",
    tab_settings: "Settings",
    trademark_imgs: "Images to check trademark",
    drop_trademark: "Drop or click to add images for trademark check",
    enqueue_trademark: "+ Add trademark session",
    trademark_fixed: "Fixed: Gemini · prompt \"Check Trademark cho tôi các thiết kế này\"",
    product_imgs: "Product images",
    listing_imgs: "Listing images",
    upscale_imgs: "Images to upscale",
    drop_upscale: "Drop or click to add images for upscale",
    upscale_prompt_label: "Upscale prompt",
    upscale_prompt_desc: "Prompt used for every image in the session",
    enqueue_upscale: "+ Add upscale session",
    vid_product: "Main product",
    vid_giver: "Gift giver",
    vid_receiver: "Recipient",
    vid_extras: "Extra products (each runs Scene 1 only)",
    drop_vid_extras: "Drop or click to add extra products",
    drop_one: "Pick 1 image",
    vid_script_label: "Script (full SCENE 1, 2, …, Style:, Audio:)",
    vid_script_desc: "4s/6s/8s: each SCENE runs as its own clip. 10s: runs 2 times, each combining 2 scenes.",
    vid_model: "Model",
    vid_outputs: "Outputs",
    vid_duration: "Duration",
    enqueue_video: "+ Add video session",
    vid_fixed: "Fixed: 16:9 · video always runs on Flow",
    image_engine: "Image engine",
    image_engine_desc: "Applies to Swap + Imgbatch (Upscale always uses Flow, Video always uses Flow)",
    engine_flow: "Google Flow (Nano Banana)",
    engine_chatgpt: "ChatGPT",
    clear_all: "Clear all",
    drop_product: "Drop or click to add product images",
    drop_listing: "Drop or click to add listing images",
    pair_mode: "Pair mode",
    pair_one_to_many: "1 product → every listing",
    pair_zip: "Zip (product[i] × listing[i])",
    enqueue: "+ Add to queue",
    queue_title: "Queue",
    start: "▶ Start",
    stop: "⏹ Stop",
    clear_done: "Clear finished",
    grp_generation: "Generation",
    prompt_label: "Prompt",
    prompt_desc: "Variables: {product}, {listing}",
    aspect_ratio: "Aspect ratio",
    aspect_desc: "Applied when Flow supports it",
    aspect_auto: "Auto (keep current)",
    outputs_per_prompt: "Outputs/prompt",
    outputs_desc: "Images per prompt (1–4)",
    image_model: "Image model",
    image_model_desc: "Model used for Nano Banana",
    model_auto: "Auto (Flow default)",
    download_quality: "Download quality",
    download_quality_desc: "Image quality on auto-download",
    quality_original: "Original",
    quality_highest: "Highest available",
    quality_none: "Don't download",
    grp_batch: "Batch & Concurrency",
    concurrent: "Concurrent",
    concurrent_desc: "Parallel sessions",
    wait_min: "Wait min (s)",
    wait_min_desc: "Min delay before next prompt",
    wait_max: "Wait max (s)",
    wait_max_desc: "Max delay (random in range)",
    auto_retry: "Auto retry on error",
    max_retries: "Max retries",
    close_tab: "Close tab when done (concurrent > 1)",
    grp_downloads: "Downloads",
    folder: "Save to folder",
    folder_desc: "Subfolder for downloads",
    prefix: "Filename prefix",
    prefix_desc: "Prefix added to filename",
    filename_template: "Filename template",
    filename_template_desc: "Vars: {idx} {product} {listing} {n} {ext}",
    auto_rename: "Auto-rename file per pair",
    grp_antidetect: "Anti-detect",
    clear_cookies: "Clear labs.google cookies before run",
    disable_cache: "Disable tab cache",
    cdp_input: "Use CDP for click/text (less bot-detect)",
    run_in_window: "Open each session in its own window (avoid background throttling)",
    grp_general: "General",
    language: "Language",
    default_mode: "Default mode on new session",
    mode_i2i: "Image to Image (swap product)",
    mode_t2i: "Text to Image",
    zoom: "Tab zoom (%)",
    save_settings: "💾 Save settings",
    reset_defaults: "↺ Reset defaults",
    export: "Export JSON",
    import: "Import JSON",
    saved: "Settings saved",
    reset_confirm: "Reset all settings to defaults?",
    reset_done: "Reset done",
    imported: "Imported",
    invalid_json: "Invalid JSON",
  },
};

const $ = (id) => document.getElementById(id);

const ui = {
  // tabs
  tabs: document.querySelectorAll("nav.tabs .tab"),
  panels: document.querySelectorAll(".tab-panel"),

  // settings inputs
  prompt: $("prompt"),
  imageEngine: $("imageEngine"),
  aspectRatio: $("aspectRatio"),
  outputsPerPrompt: $("outputsPerPrompt"),
  imageModel: $("imageModel"),
  videoModel: $("videoModel"),
  videoOutputs: $("videoOutputs"),
  videoDuration: $("videoDuration"),
  downloadQuality: $("downloadQuality"),
  concurrency: $("concurrency"),
  waitMin: $("waitMin"),
  waitMax: $("waitMax"),
  autoRetry: $("autoRetry"),
  maxRetries: $("maxRetries"),
  closeTabAfter: $("closeTabAfter"),
  folder: $("folder"),
  prefix: $("prefix"),
  filenameTemplate: $("filenameTemplate"),
  autoRename: $("autoRename"),
  clearCookies: $("clearCookies"),
  disableCache: $("disableCache"),
  cdpInput: $("cdpInput"),
  runInWindow: $("runInWindow"),
  language: $("language"),
  defaultMode: $("defaultMode"),
  zoomLevel: $("zoomLevel"),

  btnSaveSettings: $("btnSaveSettings"),
  btnResetSettings: $("btnResetSettings"),
  btnExportSettings: $("btnExportSettings"),
  btnImportSettings: $("btnImportSettings"),
  importFile: $("importFile"),

  // uploads
  fileProduct: $("fileProduct"),
  fileListing: $("fileListing"),
  dropProduct: $("dropProduct"),
  dropListing: $("dropListing"),
  thumbsProduct: $("thumbsProduct"),
  thumbsListing: $("thumbsListing"),
  cntProduct: $("cntProduct"),
  cntListing: $("cntListing"),
  clearProduct: $("clearProduct"),
  clearListing: $("clearListing"),

  pairMode: $("pairMode"),
  btnEnqueue: $("btnEnqueue"),
  pairPreview: $("pairPreview"),

  // upscale
  fileUpscale: $("fileUpscale"),
  dropUpscale: $("dropUpscale"),
  thumbsUpscale: $("thumbsUpscale"),
  cntUpscale: $("cntUpscale"),
  clearUpscale: $("clearUpscale"),
  upscalePrompt: $("upscalePrompt"),
  btnEnqueueUpscale: $("btnEnqueueUpscale"),
  upscalePreview: $("upscalePreview"),

  // trademark
  fileTrademark: $("fileTrademark"),
  dropTrademark: $("dropTrademark"),
  thumbsTrademark: $("thumbsTrademark"),
  cntTrademark: $("cntTrademark"),
  clearTrademark: $("clearTrademark"),
  btnEnqueueTrademark: $("btnEnqueueTrademark"),
  trademarkPreview: $("trademarkPreview"),

  // video
  fileVidProduct: $("fileVidProduct"),
  fileVidGiver: $("fileVidGiver"),
  fileVidReceiver: $("fileVidReceiver"),
  thumbVidProduct: $("thumbVidProduct"),
  thumbVidGiver: $("thumbVidGiver"),
  thumbVidReceiver: $("thumbVidReceiver"),
  fileVidExtras: $("fileVidExtras"),
  dropVidExtras: $("dropVidExtras"),
  thumbsVidExtras: $("thumbsVidExtras"),
  cntVidExtras: $("cntVidExtras"),
  clearVidExtras: $("clearVidExtras"),
  videoScript: $("videoScript"),
  btnEnqueueVideo: $("btnEnqueueVideo"),
  videoPreview: $("videoPreview"),

  cntQueue: $("cntQueue"),
  queueList: $("queueList"),
  btnStart: $("btnStart"),
  btnStop: $("btnStop"),
  btnClearDone: $("btnClearDone"),

  statusLine: $("statusLine"),
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const NUMERIC_KEYS = new Set([
  "outputsPerPrompt",
  "videoOutputs",
  "videoDuration",
  "concurrency",
  "waitMin",
  "waitMax",
  "maxRetries",
  "zoomLevel",
]);
const BOOL_KEYS = new Set([
  "autoRetry",
  "closeTabAfter",
  "autoRename",
  "clearCookies",
  "disableCache",
  "cdpInput",
  "runInWindow",
]);

// in-memory image pools
const pool = {
  product: [],
  listing: [],
  upscale: [],
  trademark: [],
  vidExtras: [],
};

// Video single-slot state: { name, dataUrl } | null
const videoSlots = {
  vidProduct: null,
  vidGiver: null,
  vidReceiver: null,
};

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10);
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function toast(msg, kind = "ok", ms = 1800) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- tabs ----------
ui.tabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab;
    ui.tabs.forEach((t) => t.classList.toggle("active", t === btn));
    ui.panels.forEach((p) =>
      p.classList.toggle("active", p.dataset.panel === name)
    );
  });
});

// ---------- i18n ----------
function applyI18n(lang) {
  const dict = I18N[lang] || I18N.vi;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (dict[key]) el.textContent = dict[key];
  });
  document.documentElement.lang = lang;
}

// ---------- settings <-> UI ----------
function readSettingsFromUI() {
  const out = {};
  for (const k of SETTING_KEYS) {
    const el = ui[k];
    if (!el) continue;
    if (BOOL_KEYS.has(k)) out[k] = el.checked;
    else if (NUMERIC_KEYS.has(k)) out[k] = Number(el.value) || 0;
    else out[k] = el.value;
  }
  return out;
}
function writeSettingsToUI(s) {
  for (const k of SETTING_KEYS) {
    const el = ui[k];
    if (!el) continue;
    const v = s[k] ?? DEFAULT_SETTINGS[k];
    if (BOOL_KEYS.has(k)) el.checked = !!v;
    else el.value = v;
  }
  applyI18n(s.language || DEFAULT_SETTINGS.language);
}

async function saveSettings(showToast = true) {
  const s = readSettingsFromUI();
  await chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: s });
  if (showToast) toast(I18N[s.language || "vi"].saved);
  applyI18n(s.language);
}

// auto-save on change for instant feel
function bindAutoSave() {
  for (const k of SETTING_KEYS) {
    const el = ui[k];
    if (!el) continue;
    const ev = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
    let timer;
    el.addEventListener(ev, () => {
      clearTimeout(timer);
      timer = setTimeout(() => saveSettings(false), 300);
      if (k === "language") applyI18n(el.value);
    });
  }
}

ui.btnSaveSettings.addEventListener("click", () => saveSettings(true));
ui.btnResetSettings.addEventListener("click", async () => {
  const lang = ui.language.value || "vi";
  if (!confirm(I18N[lang].reset_confirm)) return;
  writeSettingsToUI(DEFAULT_SETTINGS);
  await saveSettings(false);
  toast(I18N[lang].reset_done);
});
ui.btnExportSettings.addEventListener("click", () => {
  const s = readSettingsFromUI();
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "zecom-swap-settings.json";
  a.click();
  URL.revokeObjectURL(url);
});
ui.btnImportSettings.addEventListener("click", () => ui.importFile.click());
ui.importFile.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const text = await f.text();
    const parsed = JSON.parse(text);
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    writeSettingsToUI(merged);
    await saveSettings(false);
    toast(I18N[ui.language.value || "vi"].imported);
  } catch {
    toast(I18N[ui.language.value || "vi"].invalid_json, "err");
  }
  e.target.value = "";
});

// ---------- uploads ----------
async function addFiles(kind, fileList) {
  const list = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;

  // Render placeholders immediately so user sees progress
  const placeholders = list.map((f) => ({
    id: uid(),
    name: f.name,
    dataUrl: null,
    loading: true,
  }));
  pool[kind].push(...placeholders);
  renderPool(kind);

  // Read all files in parallel
  const results = await Promise.all(
    list.map(async (f, i) => {
      try {
        const dataUrl = await fileToDataUrl(f);
        return { id: placeholders[i].id, dataUrl };
      } catch (e) {
        return { id: placeholders[i].id, error: String(e) };
      }
    })
  );

  // Splice results back into pool
  for (const r of results) {
    const item = pool[kind].find((p) => p.id === r.id);
    if (!item) continue;
    if (r.error) {
      const idx = pool[kind].indexOf(item);
      pool[kind].splice(idx, 1);
    } else {
      item.dataUrl = r.dataUrl;
      item.loading = false;
    }
  }
  renderPool(kind);
  if (kind === "upscale") updateUpscalePreview();
  else if (kind === "trademark") updateTrademarkPreview();
  else if (kind === "vidExtras") updateVideoPreview();
  else updatePairPreview();
}
function renderPool(kind) {
  const ul =
    kind === "product" ? ui.thumbsProduct
    : kind === "listing" ? ui.thumbsListing
    : kind === "upscale" ? ui.thumbsUpscale
    : kind === "vidExtras" ? ui.thumbsVidExtras
    : ui.thumbsTrademark;
  const counter =
    kind === "product" ? ui.cntProduct
    : kind === "listing" ? ui.cntListing
    : kind === "upscale" ? ui.cntUpscale
    : kind === "vidExtras" ? ui.cntVidExtras
    : ui.cntTrademark;
  ul.innerHTML = "";
  for (const item of pool[kind]) {
    const li = document.createElement("li");
    if (item.loading) li.classList.add("loading");
    li.innerHTML = `
      ${item.dataUrl
        ? `<img src="${item.dataUrl}" alt="" />`
        : `<div class="thumb-loading">⏳</div>`}
      <span class="name">${escapeHtml(item.name)}</span>
      <button type="button" class="x" data-id="${item.id}" title="×">×</button>
    `;
    li.querySelector("button.x").addEventListener("click", () => {
      const i = pool[kind].findIndex((p) => p.id === item.id);
      if (i >= 0) pool[kind].splice(i, 1);
      renderPool(kind);
      if (kind === "upscale") updateUpscalePreview();
      else if (kind === "trademark") updateTrademarkPreview();
      else if (kind === "vidExtras") updateVideoPreview();
      else updatePairPreview();
    });
    ul.appendChild(li);
  }
  counter.textContent = pool[kind].length;
}

function makePairs() {
  // Only ready (non-loading) items can be paired
  const products = pool.product.filter((p) => p.dataUrl);
  const listings = pool.listing.filter((p) => p.dataUrl);
  if (!products.length || !listings.length) return [];

  const mode = ui.pairMode.value;
  if (mode === "zip") {
    // Zip with cycling on the shorter side. Examples:
    //   2P × 2L → 2 pairs (1:1)
    //   1P × 3L → 3 pairs (P0×L0, P0×L1, P0×L2)
    //   3P × 1L → 3 pairs (P0×L0, P1×L0, P2×L0)
    //   3P × 2L → 3 pairs (P0×L0, P1×L1, P2×L0)
    const n = Math.max(products.length, listings.length);
    return Array.from({ length: n }, (_, i) => {
      const p = products[i % products.length];
      const l = listings[i % listings.length];
      return {
        productDataUrl: p.dataUrl,
        productName: p.name,
        listingDataUrl: l.dataUrl,
        listingName: l.name,
      };
    });
  }
  // one-to-many: every product paired with every listing
  const out = [];
  for (const p of products)
    for (const l of listings)
      out.push({
        productDataUrl: p.dataUrl,
        productName: p.name,
        listingDataUrl: l.dataUrl,
        listingName: l.name,
      });
  return out;
}
function updatePairPreview() {
  const pairs = makePairs();
  ui.pairPreview.textContent = pairs.length
    ? `→ ${pairs.length} cặp`
    : "→ chưa có cặp";
}
function updateUpscalePreview() {
  const n = pool.upscale.filter((p) => p.dataUrl).length;
  ui.upscalePreview.textContent = n ? `→ ${n} ảnh` : "→ chưa có ảnh";
}
function updateTrademarkPreview() {
  const n = pool.trademark.filter((p) => p.dataUrl).length;
  ui.trademarkPreview.textContent = n ? `→ ${n} ảnh` : "→ chưa có ảnh";
}

function bindDrop(zone, kind) {
  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("drag");
    })
  );
  zone.addEventListener("drop", (e) => {
    const files = e.dataTransfer?.files;
    if (files?.length) addFiles(kind, files);
  });
}
bindDrop(ui.dropProduct, "product");
bindDrop(ui.dropListing, "listing");
ui.fileProduct.addEventListener("change", (e) => {
  addFiles("product", e.target.files);
  e.target.value = "";
});
ui.fileListing.addEventListener("change", (e) => {
  addFiles("listing", e.target.files);
  e.target.value = "";
});
ui.clearProduct.addEventListener("click", () => {
  pool.product.length = 0;
  renderPool("product");
  updatePairPreview();
});
ui.clearListing.addEventListener("click", () => {
  pool.listing.length = 0;
  renderPool("listing");
  updatePairPreview();
});
ui.pairMode.addEventListener("change", updatePairPreview);

// ---------- upscale tab ----------
bindDrop(ui.dropUpscale, "upscale");
ui.fileUpscale.addEventListener("change", (e) => {
  addFiles("upscale", e.target.files);
  e.target.value = "";
});
ui.clearUpscale.addEventListener("click", () => {
  pool.upscale.length = 0;
  renderPool("upscale");
  updateUpscalePreview();
});
// ---------- trademark tab ----------
bindDrop(ui.dropTrademark, "trademark");
ui.fileTrademark.addEventListener("change", (e) => {
  addFiles("trademark", e.target.files);
  e.target.value = "";
});
ui.clearTrademark.addEventListener("click", () => {
  pool.trademark.length = 0;
  renderPool("trademark");
  updateTrademarkPreview();
});
ui.btnEnqueueTrademark.addEventListener("click", async () => {
  const images = pool.trademark
    .filter((p) => p.dataUrl)
    .map((p) => ({ name: p.name, dataUrl: p.dataUrl }));
  if (!images.length) {
    toast("Cần ít nhất 1 ảnh để check trademark", "err");
    return;
  }
  await chrome.runtime.sendMessage({
    type: "ADD_TRADEMARK_SESSION",
    images,
  });
  toast(`+ Trademark session với ${images.length} ảnh`);
});

ui.btnEnqueueUpscale.addEventListener("click", async () => {
  const images = pool.upscale
    .filter((p) => p.dataUrl)
    .map((p) => ({ name: p.name, dataUrl: p.dataUrl }));
  if (!images.length) {
    toast("Cần ít nhất 1 ảnh để upscale", "err");
    return;
  }
  const prompt = (ui.upscalePrompt.value || "").trim() || DEFAULT_UPSCALE_PROMPT;
  await chrome.runtime.sendMessage({
    type: "ADD_UPSCALE_SESSION",
    images,
    prompt,
  });
  toast(`+ Upscale session với ${images.length} ảnh`);
});

// ---------- video tab ----------
function renderVideoSlot(slotKey) {
  const thumb =
    slotKey === "vidProduct" ? ui.thumbVidProduct
    : slotKey === "vidGiver" ? ui.thumbVidGiver
    : ui.thumbVidReceiver;
  const v = videoSlots[slotKey];
  if (!v) {
    thumb.classList.remove("has");
    thumb.innerHTML = "";
    return;
  }
  thumb.classList.add("has");
  thumb.innerHTML = `<img src="${v.dataUrl}" alt="${escapeHtml(v.name)}" /><button type="button" class="x" title="×">×</button>`;
  thumb.querySelector("button.x").addEventListener("click", () => {
    videoSlots[slotKey] = null;
    renderVideoSlot(slotKey);
    updateVideoPreview();
  });
}
async function setVideoSlot(slotKey, file) {
  if (!file || !file.type?.startsWith("image/")) return;
  const dataUrl = await fileToDataUrl(file);
  videoSlots[slotKey] = { name: file.name, dataUrl };
  renderVideoSlot(slotKey);
  updateVideoPreview();
}
ui.fileVidProduct.addEventListener("change", (e) => {
  setVideoSlot("vidProduct", e.target.files?.[0]);
  e.target.value = "";
});
ui.fileVidGiver.addEventListener("change", (e) => {
  setVideoSlot("vidGiver", e.target.files?.[0]);
  e.target.value = "";
});
ui.fileVidReceiver.addEventListener("change", (e) => {
  setVideoSlot("vidReceiver", e.target.files?.[0]);
  e.target.value = "";
});
bindDrop(ui.dropVidExtras, "vidExtras");
ui.fileVidExtras.addEventListener("change", (e) => {
  addFiles("vidExtras", e.target.files);
  e.target.value = "";
});
ui.clearVidExtras.addEventListener("click", () => {
  pool.vidExtras.length = 0;
  renderPool("vidExtras");
  updateVideoPreview();
});

// Parse "SCENE N (...): body…" blocks, plus trailing Style/Audio appendix.
function parseVideoScript(text) {
  if (!text) return { scenes: [], appendix: "" };
  // Find the start of the "Style:" or "Audio:" appendix — whichever comes
  // FIRST after the last scene block. Everything from there is the shared
  // appendix; everything before is the scene region.
  const styleIdx = text.search(/(^|\n)\s*Style\s*:/i);
  const audioIdx = text.search(/(^|\n)\s*Audio\s*:/i);
  let cut = -1;
  if (styleIdx >= 0 && audioIdx >= 0) cut = Math.min(styleIdx, audioIdx);
  else cut = Math.max(styleIdx, audioIdx);

  const scenesRegion = cut >= 0 ? text.slice(0, cut) : text;
  const appendix = cut >= 0 ? text.slice(cut).trim() : "";

  const scenes = [];
  // Match "SCENE 1 (0-4s): body…" up to the next SCENE or EOF.
  const re = /SCENE\s+(\d+)[^\n:]*:\s*([\s\S]*?)(?=\bSCENE\s+\d+\b|$)/gi;
  let m;
  while ((m = re.exec(scenesRegion)) !== null) {
    const body = m[2].trim();
    if (body) scenes.push({ index: parseInt(m[1], 10), text: body });
  }
  // Fallback: if no SCENE blocks matched, treat the whole text as one scene.
  if (!scenes.length && text.trim()) {
    scenes.push({ index: 1, text: text.trim() });
  }
  return { scenes, appendix };
}

function updateVideoPreview() {
  const { scenes } = parseVideoScript(ui.videoScript.value || "");
  const slotsCount =
    (videoSlots.vidProduct ? 1 : 0) +
    (videoSlots.vidGiver ? 1 : 0) +
    (videoSlots.vidReceiver ? 1 : 0);
  const extras = pool.vidExtras.filter((p) => p.dataUrl).length;
  if (!scenes.length) {
    ui.videoPreview.textContent = "→ chưa có scene";
    return;
  }
  const hasMain = !!videoSlots.vidProduct;
  const duration = Number(ui.videoDuration?.value) || 4;
  const turns10 = Math.ceil(scenes.length / 2);
  const mainClips = hasMain ? (duration === 10 ? turns10 : scenes.length) : 0;
  const clips = mainClips + extras;
  const parts = [];
  if (hasMain) {
    parts.push(duration === 10 ? `${turns10} turn (2 scene/turn, ${scenes.length} scene)` : `${scenes.length} scene chính`);
  }
  if (extras) parts.push(`${extras} scene phụ`);
  const summary = parts.length ? parts.join(" + ") : "0 clip";
  ui.videoPreview.textContent = `→ ${clips} clip ${duration}s (${summary}) · ${slotsCount}/3 slot${hasMain ? "" : " (cần sản phẩm chính)"}`;
}
ui.videoScript.addEventListener("input", updateVideoPreview);
ui.videoDuration?.addEventListener("change", updateVideoPreview);

ui.btnEnqueueVideo.addEventListener("click", async () => {
  const parsed = parseVideoScript(ui.videoScript.value || "");
  let { scenes } = parsed;
  const { appendix } = parsed;
  if (!scenes.length) {
    toast("Kịch bản không có SCENE nào", "err");
    return;
  }
  if (!videoSlots.vidProduct) {
    toast("Cần ảnh sản phẩm chính", "err");
    return;
  }
  // Duration 10s = chạy 2 lần, mỗi lần gộp 2 scene thành 1 prompt (giữ tiêu
  // đề SCENE để model hiểu nhịp). Extras vẫn chạy riêng (turn đầu thôi) —
  // đó là pattern hiện tại.
  const duration = Number(ui.videoDuration?.value) || 4;
  if (duration === 10 && scenes.length > 1) {
    const chunks = [];
    for (let i = 0; i < scenes.length; i += 2) chunks.push(scenes.slice(i, i + 2));
    scenes = chunks.map((chunk, ci) => ({
      index: ci + 1,
      text: chunk.map((s) => `SCENE ${s.index}: ${s.text}`).join("\n\n"),
      combined: true,
      label: `Turn ${ci + 1} (SCENE ${chunk.map((s) => s.index).join("+")})`,
    }));
  }
  const refs = [];
  refs.push({ role: "product", name: videoSlots.vidProduct.name, dataUrl: videoSlots.vidProduct.dataUrl });
  if (videoSlots.vidGiver)
    refs.push({ role: "giver", name: videoSlots.vidGiver.name, dataUrl: videoSlots.vidGiver.dataUrl });
  if (videoSlots.vidReceiver)
    refs.push({ role: "receiver", name: videoSlots.vidReceiver.name, dataUrl: videoSlots.vidReceiver.dataUrl });
  const extras = pool.vidExtras
    .filter((p) => p.dataUrl)
    .map((p) => ({ name: p.name, dataUrl: p.dataUrl }));
  await chrome.runtime.sendMessage({
    type: "ADD_VIDEO_SESSION",
    refs,
    extras,
    scenes,
    appendix,
  });
  const extraNote = extras.length ? ` + ${extras.length} sp phụ (scene 1)` : "";
  const dPart = duration === 10 ? `${scenes.length} turn (2 scene/turn)` : `${scenes.length} scene chính`;
  toast(`+ Video session ${duration}s: ${dPart}${extraNote}`);
});

// ---------- queue actions ----------
ui.btnEnqueue.addEventListener("click", async () => {
  const pairs = makePairs();
  if (!pairs.length) {
    toast("Cần ít nhất 1 product và 1 listing", "err");
    return;
  }
  await chrome.runtime.sendMessage({ type: "ADD_PAIRS", pairs });
  toast(`+ Session với ${pairs.length} pair`);
});
ui.btnStart.addEventListener("click", () => {
  // With concurrency=1, all pairs run in ONE Flow project (batch mode).
  // With concurrency>1, jobs are split round-robin across N projects (tabs).
  chrome.runtime.sendMessage({ type: "START_QUEUE" });
});
ui.btnStop.addEventListener("click", () =>
  chrome.runtime.sendMessage({ type: "STOP_QUEUE" })
);
ui.btnClearDone.addEventListener("click", () =>
  chrome.runtime.sendMessage({ type: "CLEAR_DONE" })
);

// ---------- queue render (session-based) ----------
const expandedSessions = new Set();

function renderQueue(state) {
  if (!state) return;
  const sessions = state.sessions || [];
  ui.cntQueue.textContent = sessions.length;
  ui.queueList.innerHTML = "";

  for (const s of sessions) {
    const dur =
      s.startedAt && s.finishedAt
        ? `${Math.round((s.finishedAt - s.startedAt) / 1000)}s`
        : s.startedAt
        ? `${Math.round((Date.now() - s.startedAt) / 1000)}s`
        : "";
    const isExpanded = expandedSessions.has(s.id);

    // Session-level summary
    const meta = [];
    if (s.status === "running") {
      meta.push(`${s.pairsDone}/${s.pairCount}`);
    } else if (s.status === "done") {
      meta.push(`${s.pairsDone}/${s.pairCount} done`);
    } else if (s.status === "error") {
      meta.push(`${s.pairsError} err`);
    }
    if (s.totalOutputs) meta.push(`${s.totalOutputs} img`);
    if (dur) meta.push(dur);
    const metaStr = meta.join(" · ");

    const li = document.createElement("li");
    li.className = "session";
    li.dataset.id = s.id;
    if (isExpanded) li.classList.add("expanded");
    if (s.error) li.title = s.error;

    const isUpscale = s.kind === "upscale";
    const isVideo = s.kind === "video";
    const isImgBatch = s.kind === "imgbatch";
    const isTrademark = s.kind === "trademark";
    const isSingle = isUpscale || isVideo || isImgBatch || isTrademark;
    const unit = isVideo ? "scene" : isUpscale ? "img" : isImgBatch ? "prompt" : isTrademark ? "img" : "pair";
    const pairText = s.pairCount === 1 ? `1 ${unit}` : `${s.pairCount} ${unit}s`;
    const kindLabel = isVideo ? "Video" : isUpscale ? "Upscale" : isImgBatch ? "Imgbatch" : isTrademark ? "Trademark" : "Session";
    li.innerHTML = `
      <div class="session-head">
        <button class="expand" type="button" data-id="${s.id}" title="${isExpanded ? "Collapse" : "Expand"}">${isExpanded ? "▾" : "▸"}</button>
        <span class="status ${s.status}"></span>
        <span class="label">${kindLabel} ${s.index} <span class="paircount">${pairText}</span></span>
        <span class="meta">${escapeHtml(metaStr)}</span>
        <button class="x" data-id="${s.id}" title="×">×</button>
      </div>
      <ul class="pair-list" ${isExpanded ? "" : "hidden"}></ul>
    `;

    // Expand toggle
    li.querySelector("button.expand").addEventListener("click", () => {
      if (expandedSessions.has(s.id)) expandedSessions.delete(s.id);
      else expandedSessions.add(s.id);
      renderQueue(state);
    });

    // Remove session
    li.querySelector("button.x").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "REMOVE_SESSION", sessionId: s.id });
    });

    // Render pair list when expanded
    if (isExpanded) {
      const pairUl = li.querySelector("ul.pair-list");
      for (const p of s.pairs) {
        const pli = document.createElement("li");
        pli.className = "pair";
        const pmeta = [];
        if (p.outputs) pmeta.push(`${p.outputs} img`);
        if (p.error) pmeta.push("error");
        const labelText = isSingle
          ? escapeHtml(p.productName)
          : `${escapeHtml(p.productName)} × ${escapeHtml(p.listingName)}`;
        pli.innerHTML = `
          <span class="status ${p.status}"></span>
          <span class="label" title="${labelText}">${labelText}</span>
          <span class="meta">${escapeHtml(pmeta.join(" · "))}</span>
        `;
        if (p.error) pli.title = p.error;
        pairUl.appendChild(pli);
      }
    }

    ui.queueList.appendChild(li);
  }

  if (state.settings) writeSettingsToUI(state.settings);

  // Status line — count by session
  const running = sessions.filter((s) => s.status === "running").length;
  const pending = sessions.filter((s) => s.status === "pending").length;
  const done = sessions.filter((s) => s.status === "done").length;
  const totalPairs = sessions.reduce((sum, s) => sum + s.pairCount, 0);
  const donePairs = sessions.reduce((sum, s) => sum + s.pairsDone, 0);
  ui.statusLine.textContent = state.running
    ? `Running — ${running} active session · ${pending} pending · ${donePairs}/${totalPairs} pairs done`
    : pending
    ? `Idle — ${pending} session(s) chờ Start`
    : sessions.length
    ? `Idle — ${done}/${sessions.length} session done`
    : `Idle.`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATE_UPDATE") renderQueue(msg.state);
});

// initial fetch + boot
chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp) => {
  if (resp?.state) {
    renderQueue(resp.state);
  } else {
    writeSettingsToUI(DEFAULT_SETTINGS);
  }
  bindAutoSave();
});

setInterval(() => {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp) => {
    if (resp?.state) renderQueue(resp.state);
  });
}, 2000);
