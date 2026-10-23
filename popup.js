"use strict";

document.getElementById("openPanel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  window.close();
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
