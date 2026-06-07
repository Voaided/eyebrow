// Preload script injected into all guest webviews.
// Listens to keyboard shortcuts inside the webview and forwards them to the parent window.

(function () {
  window.addEventListener("keydown", (e) => {
    const isMod = e.ctrlKey || e.metaKey;
    const key = e.key;

    // Check for target shortcuts
    const isShortcut = 
      (isMod && ["t", "w", "l", "r", "b", "Tab"].includes(key)) ||
      key === "Escape" ||
      (e.altKey && ["ArrowLeft", "ArrowRight"].includes(key)) ||
      key === "F5";

    if (isShortcut) {
      // Send keyboard event metadata to parent via console.log
      console.log("eyebrow-keydown:" + JSON.stringify({
        key: key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      }));

      // Prevent default browser action inside the webview for handled hotkeys
      // note: don't prevent tab key since web pages might use it for internal navigation,
      // but do prevent if ctrlKey is pressed (which is Ctrl+Tab)
      if (key !== "Tab" || isMod) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }, true);
})();
