const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["bridgeBase", "bridgeToken", "bridgeEnabled"]).then((c) => {
  $("base").value = c.bridgeBase || "http://localhost:4500";
  $("token").value = c.bridgeToken || "";
  $("enabled").checked = c.bridgeEnabled !== false; // default on
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    bridgeBase: $("base").value.trim().replace(/\/+$/, ""),
    bridgeToken: $("token").value.trim(),
    bridgeEnabled: $("enabled").checked,
  });
  $("status").textContent = "Đã lưu ✓";
  setTimeout(() => ($("status").textContent = ""), 1500);
});
