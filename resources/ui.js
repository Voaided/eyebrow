"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  const appEl = $("app");
  const tabsEl = $("tabs");
  const viewportEl = $("viewport");
  const emptyEl = $("empty");
  const urlInput = $("url");
  const extensionsEl = $("extensions");
  const palette = $("palette");
  const paletteInput = $("palette-input");
  const paletteResults = $("palette-results");

  const state = {
    windowId: null,
    tabs: [],
    activeId: null,
    extensions: [],
    popups: [],
  };

  let paletteFocusTimer = null;
  let paletteResultsList = [];
  let paletteSelectedIndex = -1;
  let lastQuery = "";
  let lastActiveId = null;
  let clockInterval = null;
  let paletteNewTabMode = false;
  let suppressPaletteAutoOpen = false;

  const DEFAULT_SPEED_DIALS = [
    { name: "GitHub", url: "https://github.com" },
    { name: "YouTube", url: "https://youtube.com" },
    { name: "Reddit", url: "https://reddit.com" },
    { name: "ChatGPT", url: "https://chatgpt.com" },
    { name: "Gemini", url: "https://gemini.google.com" },
    { name: "Gmail", url: "https://mail.google.com" }
  ];

  /* ─── utilities ─────────────────────────────────── */

  async function getWindowId() {
    if (typeof vivaldiWindowId !== "undefined") return vivaldiWindowId;
    const w = await chrome.windows.getCurrent();
    return w.id;
  }

  function smartUrl(input) {
    const v = input.trim();
    if (!v) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
    if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v) || v.startsWith("localhost")) {
      return "https://" + v;
    }
    return "https://www.google.com/search?q=" + encodeURIComponent(v);
  }

  function withActiveView(fn) {
    if (state.activeId == null) return;
    const v = document.getElementById("view-" + state.activeId);
    if (v) fn(v);
  }

  function navigateTo(url) {
    if (state.activeId == null) {
      chrome.tabs.create({ windowId: state.windowId, url, active: true });
    } else {
      chrome.tabs.update(state.activeId, { url });
    }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  /* ─── Toast ─────────────────────────────────────── */

  function showToast(message) {
    const toast = $("eyebrow-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove("show");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.add("show");
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove("show"), 2000);
      });
    });
  }

  /* ─── webviews ──────────────────────────────────── */

  const KEYBOARD_INJECT_CODE = `(function(){
    if(window.__eyebrow_keys_injected)return;
    window.__eyebrow_keys_injected=true;
    window.addEventListener("keydown",function(e){
      var isMod=e.ctrlKey||e.metaKey;
      var key=e.key;
      var isShortcut=
        (isMod&&["t","w","l","r","b","d","Tab"].indexOf(key)!==-1)||
        key==="Escape"||
        (e.altKey&&["ArrowLeft","ArrowRight"].indexOf(key)!==-1)||
        key==="F5";
      if(isShortcut){
        console.log("eyebrow-keydown:"+JSON.stringify({
          key:key,code:e.code,
          ctrlKey:e.ctrlKey,metaKey:e.metaKey,
          shiftKey:e.shiftKey,altKey:e.altKey
        }));
        if(key!=="Tab"||isMod){e.preventDefault();e.stopPropagation();}
      }
    },true);
    if(window.__eyebrow_ctx_injected)return;
    window.__eyebrow_ctx_injected=true;
    document.addEventListener("contextmenu",function(e){
      e.preventDefault();
      console.log("eyebrow-ctx:"+JSON.stringify({x:e.clientX,y:e.clientY}));
    },true);
    document.addEventListener("mousedown",function(e){
      if(e.button!==0)return;
      console.log("eyebrow-click");
    },true);
  })();`;

  function injectKeyboardListener(view) {
    try {
      view.executeScript({ code: KEYBOARD_INJECT_CODE }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (_) {}
  }

  function ensureView(tabId) {
    let view = document.getElementById("view-" + tabId);
    if (view) return view;
    view = document.createElement("webview");
    view.id = "view-" + tabId;
    view.className = "view";
    view.setAttribute("role", "document");
    view.setAttribute("tab_id", String(tabId));

    view.addEventListener("consolemessage", (e) => {
      if (e.message && e.message.startsWith("eyebrow-keydown:")) {
        try {
          const data = JSON.parse(e.message.substring("eyebrow-keydown:".length));
          handleForwardedKeyEvent(data);
        } catch (err) {}
      } else if (e.message && e.message.startsWith("eyebrow-ctx:")) {
        try {
          const data = JSON.parse(e.message.substring("eyebrow-ctx:".length));
          const rect = view.getBoundingClientRect();
          openCtxMenu(rect.left + data.x, rect.top + data.y);
        } catch (err) {}
      } else if (e.message === "eyebrow-click") {
        closeCtxMenu();
      }
    });

    view.addEventListener("loadstop", () => {
      injectKeyboardListener(view);
      // Capture screenshot for preview when this is the active tab
      const tabId = Number(view.getAttribute("tab_id"));
      if (tabId === state.activeId) {
        setTimeout(() => captureTabScreenshot(tabId), 400);
      }
    });
    view.addEventListener("contentload", () => {
      injectKeyboardListener(view);
    });

    viewportEl.appendChild(view);
    return view;
  }

  /* ─── Tab Screenshots ────────────────────────────── */

  const tabScreenshots = new Map();

  async function captureTabScreenshot(tabId) {
    if (tabId !== state.activeId) return;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(state.windowId, { format: "jpeg", quality: 40 });
      tabScreenshots.set(tabId, dataUrl);
    } catch (_) {}
  }

  /* ─── Tab Preview ────────────────────────────────── */

  let previewTimeout = null;
  let previewVisible = false;

  function showTabPreview(tab, anchorEl) {
    clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      const preview = $("tab-preview");
      if (!preview) return;

      const previewFav = preview.querySelector(".preview-favicon");
      const previewTitle = preview.querySelector(".preview-title");
      const previewUrl = preview.querySelector(".preview-url");
      const previewImg = preview.querySelector(".preview-screenshot");

      previewTitle.textContent = tab.title || "Untitled";
      previewUrl.textContent = tab.url || "";

      if (tab.favIconUrl) {
        previewFav.src = tab.favIconUrl;
        previewFav.style.display = "block";
      } else {
        previewFav.style.display = "none";
      }

      const screenshot = tabScreenshots.get(tab.id);
      if (screenshot) {
        previewImg.style.backgroundImage = `url(${screenshot})`;
        previewImg.classList.add("has-image");
      } else {
        previewImg.classList.remove("has-image");
      }

      const sidebarEl = document.getElementById("sidebar");
      const sidebarRect = sidebarEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();

      preview.style.display = "block";

      const previewH = screenshot ? 190 : 56;
      let top = anchorRect.top;
      const maxTop = window.innerHeight - previewH - 8;
      if (top > maxTop) top = maxTop;
      if (top < 8) top = 8;

      preview.style.top = top + "px";
      preview.style.left = (sidebarRect.right + 10) + "px";

      requestAnimationFrame(() => {
        preview.classList.add("open");
        previewVisible = true;
      });
    }, 280);
  }

  function hideTabPreview() {
    clearTimeout(previewTimeout);
    const preview = $("tab-preview");
    if (!preview) return;
    preview.classList.remove("open");
    previewVisible = false;
    setTimeout(() => {
      if (!previewVisible) preview.style.display = "none";
    }, 200);
  }

  /* ─── Tab Drag & Drop ────────────────────────────── */

  let dragTabId = null;

  /* ─── tab list ──────────────────────────────────── */

  function renderTabs() {
    tabsEl.innerHTML = "";
    for (const tab of state.tabs) {
      const el = document.createElement("button");
      let cls = "tab";
      if (tab.id === state.activeId) cls += " active";
      if (tab.status === "loading") cls += " loading";
      el.className = cls;
      el.title = tab.title || tab.url || "";
      el.draggable = true;

      // Favicon Container
      const favWrapper = document.createElement("div");
      favWrapper.className = "favicon-wrapper";

      if (tab.favIconUrl) {
        const img = document.createElement("img");
        img.className = "favicon";
        img.src = tab.favIconUrl;
        img.onerror = () => {
          img.className = "favicon placeholder";
          img.removeAttribute("src");
        };
        favWrapper.appendChild(img);
      } else {
        const dot = document.createElement("span");
        dot.className = "favicon placeholder";
        favWrapper.appendChild(dot);
      }
      el.appendChild(favWrapper);

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = tab.title || tab.url || "untitled";
      el.appendChild(title);

      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.title = "Close tab";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.tabs.remove(tab.id);
      });
      el.appendChild(close);

      el.addEventListener("click", () => {
        chrome.tabs.update(tab.id, { active: true });
      });
      el.addEventListener("auxclick", (e) => {
        if (e.button === 1) chrome.tabs.remove(tab.id);
      });

      // ── Preview on hover ──
      el.addEventListener("mouseenter", () => {
        if (tab.id !== state.activeId) {
          showTabPreview(tab, el);
        }
      });
      el.addEventListener("mouseleave", () => {
        hideTabPreview();
      });

      // ── Drag & Drop ──
      el.addEventListener("dragstart", (e) => {
        dragTabId = tab.id;
        el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        hideTabPreview();
      });

      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        document.querySelectorAll(".tab.drag-over").forEach(t => t.classList.remove("drag-over"));
        dragTabId = null;
      });

      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragTabId != null && tab.id !== dragTabId) {
          document.querySelectorAll(".tab.drag-over").forEach(t => t.classList.remove("drag-over"));
          el.classList.add("drag-over");
        }
      });

      el.addEventListener("dragleave", (e) => {
        if (!el.contains(e.relatedTarget)) {
          el.classList.remove("drag-over");
        }
      });

      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("drag-over");
        if (dragTabId == null || dragTabId === tab.id) return;
        const toIdx = state.tabs.findIndex(t => t.id === tab.id);
        if (toIdx !== -1) {
          chrome.tabs.move(dragTabId, { index: toIdx }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });

      tabsEl.appendChild(el);
    }
  }

  function isBlankTab(tab) {
    if (!tab) return true;
    const isBlankUrl = (url) =>
      !url ||
      url === "" ||
      url === "about:blank" ||
      url === "chrome://newtab/" ||
      url === "vivaldi://newtab/" ||
      url === "vivaldi://startpage/" ||
      url === "vivaldi://speeddial/";
    return isBlankUrl(tab.url) && (!tab.pendingUrl || isBlankUrl(tab.pendingUrl));
  }

  function syncViews() {
    const ids = new Set(state.tabs.map((t) => t.id));
    for (const node of viewportEl.querySelectorAll(".view")) {
      const id = Number(node.id.replace("view-", ""));
      if (!ids.has(id)) node.remove();
    }

    const activeTab = state.tabs.find((t) => t.id === state.activeId);
    const isNewTab = isBlankTab(activeTab);

    for (const tab of state.tabs) {
      const v = ensureView(tab.id);
      v.classList.toggle("active", tab.id === state.activeId && !isNewTab);
    }

    emptyEl.classList.toggle("show", state.tabs.length === 0);

    const zenPage = $("zen-page");
    if (zenPage) {
      const showZen = state.tabs.length > 0 && isNewTab;
      zenPage.classList.toggle("show", showZen);
      if (showZen) {
        updateZenClock();
        renderSpeedDials();
        if (clockInterval == null) {
          clockInterval = setInterval(updateZenClock, 1000);
        }
      } else {
        if (clockInterval != null) {
          clearInterval(clockInterval);
          clockInterval = null;
        }
      }
    }
  }

  function syncOmnibox() {
    if (document.activeElement === urlInput) return;
    const active = state.tabs.find((t) => t.id === state.activeId);
    urlInput.value = isBlankTab(active) ? "" : (active?.url || "");
  }

  async function refreshTabs() {
    const tabs = await chrome.tabs.query({ windowId: state.windowId });
    state.tabs = tabs;
    const active = tabs.find((t) => t.active);
    const prevActiveId = state.activeId;
    state.activeId = active ? active.id : null;

    // Capture screenshot of the tab we're leaving
    if (prevActiveId && prevActiveId !== state.activeId) {
      captureTabScreenshot(prevActiveId).catch(() => {});
    }

    renderTabs();
    syncViews();
    syncOmnibox();
    updateBookmarkButton();

    if (state.activeId !== lastActiveId) {
      lastActiveId = state.activeId;
      if (active && !suppressPaletteAutoOpen && isBlankTab(active)) {
        openPalette("", false);
      }
      suppressPaletteAutoOpen = false;
    }
  }

  /* ─── sidebar ───────────────────────────────────── */

  function toggleSidebar() {
    appEl.classList.toggle("collapsed");
  }

  function showSidebar() {
    appEl.classList.remove("collapsed");
  }

  /* ─── History Panel ──────────────────────────────── */

  function openHistoryPanel() {
    closeBookmarksPanel();
    $("history-panel").classList.add("open");
    loadHistoryItems($("history-search").value || "");
  }

  function closeHistoryPanel() {
    $("history-panel").classList.remove("open");
  }

  function loadHistoryItems(query) {
    if (!chrome.history) {
      renderHistoryItems([]);
      return;
    }
    chrome.history.search(
      { text: query, maxResults: 120, startTime: Date.now() - 30 * 24 * 60 * 60 * 1000 },
      (results) => renderHistoryItems(results || [])
    );
  }

  function renderHistoryItems(items) {
    const container = $("history-list");
    if (!container) return;
    container.innerHTML = "";

    if (items.length === 0) {
      const el = document.createElement("div");
      el.className = "panel-empty";
      el.textContent = "No history to show";
      container.appendChild(el);
      return;
    }

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const yesterdayMidnight = new Date(todayMidnight);
    yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);

    const groups = new Map();
    for (const item of items) {
      const d = new Date(item.lastVisitTime);
      d.setHours(0, 0, 0, 0);
      let key;
      if (d.getTime() === todayMidnight.getTime()) key = "Today";
      else if (d.getTime() === yesterdayMidnight.getTime()) key = "Yesterday";
      else key = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const [day, dayItems] of groups) {
      const header = document.createElement("div");
      header.className = "panel-group-header";
      header.textContent = day;
      container.appendChild(header);

      for (const item of dayItems) {
        const time = new Date(item.lastVisitTime).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        const el = createPanelItem({ title: item.title || item.url, url: item.url, time });

        const del = document.createElement("button");
        del.className = "panel-item-del";
        del.innerHTML = "&times;";
        del.title = "Remove from history";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          if (chrome.history) {
            chrome.history.deleteUrl({ url: item.url }, () => {
              loadHistoryItems($("history-search").value || "");
            });
          }
        });
        el.appendChild(del);

        el.addEventListener("click", () => {
          navigateTo(item.url);
          closeHistoryPanel();
        });
        container.appendChild(el);
      }
    }
  }

  /* ─── Bookmarks Panel ────────────────────────────── */

  function openBookmarksPanel() {
    closeHistoryPanel();
    $("bookmarks-panel").classList.add("open");
    loadBookmarkItems($("bookmarks-search").value || "");
  }

  function closeBookmarksPanel() {
    $("bookmarks-panel").classList.remove("open");
  }

  function loadBookmarkItems(query) {
    if (!chrome.bookmarks) {
      renderBookmarkItems([]);
      return;
    }
    if (query) {
      chrome.bookmarks.search(query, (results) => {
        renderBookmarkItems((results || []).filter(b => b.url));
      });
    } else {
      chrome.bookmarks.getTree((tree) => {
        const flat = [];
        function traverse(nodes) {
          for (const node of (nodes || [])) {
            if (node.url) flat.push(node);
            if (node.children) traverse(node.children);
          }
        }
        traverse(tree);
        renderBookmarkItems(flat);
      });
    }
  }

  function renderBookmarkItems(items) {
    const container = $("bookmarks-list");
    if (!container) return;
    container.innerHTML = "";

    if (items.length === 0) {
      const el = document.createElement("div");
      el.className = "panel-empty";
      el.textContent = "No bookmarks found";
      container.appendChild(el);
      return;
    }

    for (const item of items) {
      const el = createPanelItem({ title: item.title || item.url, url: item.url });

      const del = document.createElement("button");
      del.className = "panel-item-del";
      del.innerHTML = "&times;";
      del.title = "Remove bookmark";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.bookmarks.remove(item.id, () => {
          loadBookmarkItems($("bookmarks-search").value || "");
          updateBookmarkButton();
        });
      });
      el.appendChild(del);

      el.addEventListener("click", () => {
        navigateTo(item.url);
        closeBookmarksPanel();
      });
      container.appendChild(el);
    }
  }

  /* ─── Panel Item Factory ─────────────────────────── */

  function createPanelItem({ title, url, time }) {
    const el = document.createElement("div");
    el.className = "panel-item";

    const iconWrap = document.createElement("div");
    iconWrap.className = "panel-item-icon";
    const img = document.createElement("img");
    img.src = `chrome://favicon/size/16@1x/${url}`;
    img.alt = "";
    img.onerror = () => {
      img.remove();
      const dot = document.createElement("div");
      dot.className = "panel-item-dot";
      iconWrap.appendChild(dot);
    };
    iconWrap.appendChild(img);

    const textWrap = document.createElement("div");
    textWrap.className = "panel-item-text";

    const titleEl = document.createElement("span");
    titleEl.className = "panel-item-title";
    titleEl.textContent = title;

    const urlEl = document.createElement("span");
    urlEl.className = "panel-item-url";
    urlEl.textContent = url;

    textWrap.appendChild(titleEl);
    textWrap.appendChild(urlEl);

    el.appendChild(iconWrap);
    el.appendChild(textWrap);

    if (time) {
      const timeEl = document.createElement("span");
      timeEl.className = "panel-item-time";
      timeEl.textContent = time;
      el.appendChild(timeEl);
    }

    return el;
  }

  /* ─── Bookmark Current Page ──────────────────────── */

  async function checkIfBookmarked(url) {
    if (!url || !chrome.bookmarks) return false;
    return new Promise((resolve) => {
      chrome.bookmarks.search({ url }, (results) => {
        resolve(!!(results && results.length > 0));
      });
    });
  }

  async function updateBookmarkButton() {
    const btn = $("bookmark-btn");
    if (!btn) return;
    const active = state.tabs.find(t => t.id === state.activeId);
    if (!active || isBlankTab(active)) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "flex";
    const bookmarked = await checkIfBookmarked(active.url);
    btn.classList.toggle("bookmarked", bookmarked);
    btn.title = bookmarked ? "Remove bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)";
  }

  async function toggleBookmark() {
    const active = state.tabs.find(t => t.id === state.activeId);
    if (!active || isBlankTab(active) || !chrome.bookmarks) return;

    const url = active.url;
    const title = active.title || url;

    const results = await new Promise(resolve => chrome.bookmarks.search({ url }, resolve));

    if (results && results.length > 0) {
      for (const bm of results) {
        chrome.bookmarks.remove(bm.id, () => {});
      }
      showToast("Bookmark removed");
    } else {
      chrome.bookmarks.create({ title, url }, () => {});
      showToast("Bookmarked!");
    }

    setTimeout(updateBookmarkButton, 80);
  }

  /* ─── command palette ───────────────────────────── */

  function openPalette(prefill, newTabMode = false) {
    paletteNewTabMode = newTabMode;
    for (const wv of document.querySelectorAll("webview")) {
      try { wv.blur(); } catch (_) {}
    }
    if (document.activeElement && document.activeElement !== paletteInput) {
      try { document.activeElement.blur(); } catch (_) {}
    }

    paletteInput.value = prefill || "";
    if (!palette.open) palette.showModal();
    updatePaletteResults();

    clearInterval(paletteFocusTimer);
    const grab = () => {
      try { paletteInput.focus({ preventScroll: true }); } catch (_) {}
    };
    grab();
    requestAnimationFrame(grab);
    setTimeout(grab, 30);
    setTimeout(grab, 80);
    paletteFocusTimer = setInterval(grab, 60);
  }

  function closePalette() {
    clearInterval(paletteFocusTimer);
    if (palette.open) palette.close();
    paletteInput.value = "";
    paletteResultsList = [];
    paletteSelectedIndex = -1;
    paletteResults.innerHTML = "";
    paletteResults.classList.remove("has-results");
  }

  function submitPalette(openInNewTab = false) {
    const url = smartUrl(paletteInput.value);
    if (!url) return closePalette();
    suppressPaletteAutoOpen = true;

    if (openInNewTab || paletteNewTabMode || state.activeId == null) {
      chrome.tabs.create({ windowId: state.windowId, url, active: true });
    } else {
      chrome.tabs.update(state.activeId, { url });
    }
    closePalette();
  }

  /* ─── Spotlight Search Integration ────────────── */

  function searchHistory(query) {
    return new Promise((resolve) => {
      if (!chrome.history) return resolve([]);
      chrome.history.search({ text: query, maxResults: 5 }, (results) => {
        resolve(results || []);
      });
    });
  }

  function searchBookmarks(query) {
    return new Promise((resolve) => {
      if (!chrome.bookmarks) return resolve([]);
      chrome.bookmarks.search(query, (results) => {
        resolve((results || []).filter(b => b.url));
      });
    });
  }

  async function fetchSuggestions(query) {
    if (!query) return [];
    try {
      const res = await fetch(`https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data && Array.isArray(data[1])) return data[1].slice(0, 5);
    } catch (_) {}
    return [];
  }

  function looksLikeUrl(input) {
    const v = input.trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ||
           /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v) ||
           v.startsWith("localhost");
  }

  async function searchAll(query) {
    if (!query) return [];
    const results = [];
    const queryLower = query.toLowerCase();

    if (looksLikeUrl(query)) {
      results.push({
        type: "navigate",
        title: query.startsWith("http") ? query : "https://" + query,
        subtitle: "Navigate to URL",
        url: query.startsWith("http") ? query : "https://" + query,
      });
    }

    const openTabs = state.tabs.filter(t =>
      (t.title && t.title.toLowerCase().includes(queryLower)) ||
      (t.url && t.url.toLowerCase().includes(queryLower))
    );
    for (const tab of openTabs.slice(0, 4)) {
      results.push({
        type: "tab", title: tab.title || tab.url,
        subtitle: "Switch to Tab", url: tab.url,
        tabId: tab.id, icon: tab.favIconUrl || ""
      });
    }

    const [history, bookmarks] = await Promise.all([
      searchHistory(query),
      searchBookmarks(query)
    ]);

    for (const bm of bookmarks.slice(0, 4)) {
      results.push({ type: "bookmark", title: bm.title, subtitle: bm.url, url: bm.url });
    }

    for (const hist of history.slice(0, 4)) {
      results.push({ type: "history", title: hist.title || hist.url, subtitle: hist.url, url: hist.url });
    }

    results.push({
      type: "search", title: query,
      subtitle: `Search Google for "${query}"`,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`
    });

    return results;
  }

  async function updatePaletteResults() {
    const query = paletteInput.value.trim();
    lastQuery = query;

    if (!query) {
      renderPaletteResults([]);
      return;
    }

    const localResults = await searchAll(query);
    if (lastQuery !== query) return;

    renderPaletteResults(localResults);

    try {
      const suggestions = await fetchSuggestions(query);
      if (lastQuery !== query) return;

      const currentTitles = new Set(localResults.map(r => r.title.toLowerCase()));
      const sugResults = [];

      for (const sug of suggestions) {
        if (!currentTitles.has(sug.toLowerCase()) && sug.toLowerCase() !== query.toLowerCase()) {
          sugResults.push({
            type: "search", title: sug,
            subtitle: "Google Search Suggestion",
            url: `https://www.google.com/search?q=${encodeURIComponent(sug)}`
          });
        }
      }

      if (sugResults.length > 0) {
        const idx = localResults.findIndex(r => r.type === "search" && r.title === query);
        if (idx !== -1) localResults.splice(idx, 0, ...sugResults);
        else localResults.push(...sugResults);
        renderPaletteResults(localResults);
      }
    } catch (_) {}
  }

  function renderPaletteResults(results) {
    paletteResultsList = results;
    paletteResults.innerHTML = "";

    if (results.length === 0) {
      paletteSelectedIndex = -1;
      paletteResults.classList.remove("has-results");
      return;
    }

    paletteResults.classList.add("has-results");
    paletteSelectedIndex = 0;

    let currentType = null;

    results.forEach((item, idx) => {
      if (item.type !== currentType) {
        currentType = item.type;
        const header = document.createElement("div");
        header.className = "palette-result-header";
        header.textContent = getTypeName(currentType);
        paletteResults.appendChild(header);
      }

      const el = document.createElement("div");
      el.className = "palette-result-item";
      if (idx === paletteSelectedIndex) el.classList.add("selected");
      el.dataset.index = idx;

      const iconWrap = document.createElement("div");
      iconWrap.className = "item-icon";
      iconWrap.innerHTML = getIconSvg(item.type, item.icon);
      el.appendChild(iconWrap);

      const textStack = document.createElement("div");
      textStack.className = "item-text-stack";

      const title = document.createElement("span");
      title.className = "item-title";

      const query = paletteInput.value.trim().toLowerCase();
      const textStr = item.title;
      const qIdx = textStr.toLowerCase().indexOf(query);
      if (qIdx !== -1 && query.length > 0) {
        const p1 = textStr.substring(0, qIdx);
        const p2 = textStr.substring(qIdx, qIdx + query.length);
        const p3 = textStr.substring(qIdx + query.length);
        title.innerHTML = `${escapeHtml(p1)}<mark class="highlight">${escapeHtml(p2)}</mark>${escapeHtml(p3)}`;
      } else {
        title.textContent = textStr;
      }
      textStack.appendChild(title);

      if (item.subtitle) {
        const subtitle = document.createElement("span");
        subtitle.className = "item-subtitle";
        subtitle.textContent = item.subtitle;
        textStack.appendChild(subtitle);
      }
      el.appendChild(textStack);

      const tag = document.createElement("span");
      tag.className = "item-tag";
      tag.textContent = getTagText(item.type);
      el.appendChild(tag);

      el.addEventListener("click", () => {
        selectItem(idx);
        executeSelectedResult();
      });

      paletteResults.appendChild(el);
    });
  }

  function selectItem(idx) {
    if (idx < 0 || idx >= paletteResultsList.length) return;
    const items = document.querySelectorAll(".palette-result-item");
    if (items[paletteSelectedIndex]) items[paletteSelectedIndex].classList.remove("selected");
    paletteSelectedIndex = idx;
    if (items[paletteSelectedIndex]) {
      items[paletteSelectedIndex].classList.add("selected");
      items[paletteSelectedIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function executeSelectedResult(openInNewTab = false) {
    const item = paletteResultsList[paletteSelectedIndex];
    if (!item) {
      submitPalette(openInNewTab);
      return;
    }

    suppressPaletteAutoOpen = true;
    if (item.type === "tab" && !openInNewTab && !paletteNewTabMode) {
      chrome.tabs.update(item.tabId, { active: true });
    } else {
      const url = item.url;
      if (openInNewTab || paletteNewTabMode || state.activeId == null) {
        chrome.tabs.create({ windowId: state.windowId, url, active: true });
      } else {
        chrome.tabs.update(state.activeId, { url });
      }
    }
    closePalette();
  }

  function getTypeName(type) {
    switch (type) {
      case "navigate": return "URL";
      case "tab": return "Open Tabs";
      case "bookmark": return "Bookmarks";
      case "history": return "Recent History";
      case "search": return "Google Search";
      default: return "Results";
    }
  }

  function getTagText(type) {
    switch (type) {
      case "navigate": return "Go";
      case "tab": return "Tab";
      case "bookmark": return "Bookmark";
      case "history": return "History";
      case "search": return "Search";
      default: return "";
    }
  }

  function getIconSvg(type, iconUrl) {
    if (iconUrl) {
      return `<img src="${iconUrl}" onerror="this.outerHTML='<svg class=\\'svg-fallback\\' viewBox=\\'0 0 24 24\\' width=\\'14\\' height=\\'14\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\'><circle cx=\\'12\\' cy=\\'12\\' r=\\'10\\'/><path d=\\'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\\'/><path d=\\'M2 12h20\\'/></svg>'"/>`;
    }
    switch (type) {
      case "navigate":
        return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
      case "tab":
        return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`;
      case "bookmark":
        return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
      case "history":
        return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
      case "search":
        return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
      default:
        return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;
    }
  }

  /* ─── Zen Dashboard Controller ────────────────── */

  function updateZenClock() {
    const clockEl = $("zen-clock");
    const dateEl = $("zen-date");
    const greetingEl = $("zen-greeting");
    if (!clockEl) return;

    const now = new Date();

    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    clockEl.textContent = `${hours}:${minutes} ${ampm}`;

    dateEl.textContent = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

    const hr = now.getHours();
    let greet = "Good evening";
    if (hr < 12) greet = "Good morning";
    else if (hr < 18) greet = "Good afternoon";
    greetingEl.textContent = `${greet}, Gaurish`;
  }

  function renderSpeedDials() {
    const container = $("zen-speed-dial");
    if (!container) return;
    container.innerHTML = "";

    let dials = [];
    try {
      const stored = localStorage.getItem("eyebrow-speeddials");
      dials = stored ? JSON.parse(stored) : DEFAULT_SPEED_DIALS;
    } catch (_) {
      dials = DEFAULT_SPEED_DIALS;
    }

    dials.forEach((dial, idx) => {
      const card = document.createElement("div");
      card.className = "dial-card";

      const faviconUrl = `chrome://favicon/size/32@1x/${dial.url}`;

      const inner = document.createElement("div");
      inner.className = "dial-inner";

      const icon = document.createElement("img");
      icon.className = "dial-icon";
      icon.src = faviconUrl;
      icon.onerror = () => {
        icon.style.display = "none";
        const letter = document.createElement("span");
        letter.className = "dial-letter";
        letter.textContent = dial.name.charAt(0).toUpperCase();
        inner.insertBefore(letter, title);
      };

      const title = document.createElement("span");
      title.className = "dial-title";
      title.textContent = dial.name;

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "dial-delete";
      deleteBtn.title = "Delete favorite";
      deleteBtn.innerHTML = "&times;";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSpeedDial(idx);
      });

      inner.appendChild(icon);
      inner.appendChild(title);
      card.appendChild(inner);
      card.appendChild(deleteBtn);

      card.addEventListener("click", () => {
        const resolved = smartUrl(dial.url);
        if (state.activeId == null) {
          chrome.tabs.create({ windowId: state.windowId, url: resolved, active: true });
        } else {
          chrome.tabs.update(state.activeId, { url: resolved });
        }
      });

      container.appendChild(card);
    });
  }

  function deleteSpeedDial(index) {
    let dials = [];
    try {
      const stored = localStorage.getItem("eyebrow-speeddials");
      dials = stored ? JSON.parse(stored) : DEFAULT_SPEED_DIALS;
    } catch (_) {
      dials = [...DEFAULT_SPEED_DIALS];
    }
    dials.splice(index, 1);
    localStorage.setItem("eyebrow-speeddials", JSON.stringify(dials));
    renderSpeedDials();
  }

  function openDialDialog() {
    $("dial-name").value = "";
    $("dial-url").value = "";
    $("dial-dialog").showModal();
  }

  function closeDialDialog() {
    $("dial-dialog").close();
  }

  function saveDialDialog() {
    const name = $("dial-name").value.trim();
    let url = $("dial-url").value.trim();
    if (!name || !url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    let dials = [];
    try {
      const stored = localStorage.getItem("eyebrow-speeddials");
      dials = stored ? JSON.parse(stored) : DEFAULT_SPEED_DIALS;
    } catch (_) {
      dials = [...DEFAULT_SPEED_DIALS];
    }

    dials.push({ name, url });
    localStorage.setItem("eyebrow-speeddials", JSON.stringify(dials));
    closeDialDialog();
    renderSpeedDials();
  }

  /* ─── extensions ────────────────────────────────── */

  function pickIcon(ext) {
    if (!ext.icons || ext.icons.length === 0) return null;
    const sorted = ext.icons.slice().sort((a, b) => a.size - b.size);
    const at16 = sorted.find((i) => i.size >= 16);
    return (at16 || sorted[sorted.length - 1]).url;
  }

  async function loadExtensions() {
    if (!chrome.management) return;
    try {
      const all = await chrome.management.getAll();
      state.extensions = all
        .filter((e) => e.enabled && e.type === "extension")
        .sort((a, b) => a.name.localeCompare(b.name));
      renderExtensions();
    } catch (err) {
      console.warn("[eyebrow] could not load extensions:", err);
    }
  }

  function renderExtensions() {
    extensionsEl.innerHTML = "";
    for (const ext of state.extensions) {
      const btn = document.createElement("button");
      btn.className = "ext";
      btn.title = ext.name;
      btn.dataset.id = ext.id;

      const iconUrl = pickIcon(ext);
      if (iconUrl) {
        const img = document.createElement("img");
        img.src = iconUrl;
        img.alt = ext.name;
        btn.appendChild(img);
      } else {
        btn.textContent = ext.name.charAt(0).toUpperCase();
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerExtension(ext, btn);
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        chrome.tabs.create({
          windowId: state.windowId,
          url: "chrome://extensions/?id=" + ext.id,
          active: true,
        });
      });
      extensionsEl.appendChild(btn);
    }
  }

  function triggerExtension(ext, anchor) {
    if (typeof vivaldi === "undefined" || !vivaldi.extensionActionUtils) {
      console.warn("[eyebrow] vivaldi.extensionActionUtils missing");
      return;
    }

    if (state.popups.length > 0 && state.popups[0].anchor === anchor) {
      closeAllPopups();
      return;
    }

    vivaldi.extensionActionUtils.executeExtensionAction(
      ext.id,
      state.windowId,
      (data) => {
        if (!data || !data.popupUrl) return;
        showExtensionPopup(data.popupUrl, anchor, data.width || null, data.height || null);
      },
    );
  }

  function positionPopup(popup, anchor, w, h) {
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top - h - margin;

    if (top < margin) top = rect.bottom + margin;
    if (left + w > vw - margin) left = vw - w - margin;
    if (left < margin) left = margin;
    if (top + h > vh - margin) top = vh - h - margin;
    if (top < margin) top = margin;

    popup.style.left = left + "px";
    popup.style.top = top + "px";
  }

  function showExtensionPopup(url, anchor, preferredW, preferredH) {
    closeAllPopups();

    const MAX_W = 800;
    const MAX_H = 600;

    const popup = document.createElement("div");
    popup.className = "ext-popup";
    popup.style.width = "1px";
    popup.style.height = "1px";
    popup.style.visibility = "hidden";

    const wv = document.createElement("webview");
    wv.className = "ext-popup-view";
    wv.setAttribute("vivaldi_view_type", "extension_popup");
    wv.setAttribute("windowId", String(state.windowId));
    wv.src = url;
    popup.appendChild(wv);

    wv.addEventListener("loadstop", () => {
      setTimeout(() => {
        try {
          wv.executeScript({
            code: `(function(){
              var rect = document.body.getBoundingClientRect();
              var w = rect.width;
              var h = rect.height;
              if (w <= 1) w = document.documentElement.scrollWidth;
              if (h <= 1) h = document.documentElement.scrollHeight;
              return [Math.ceil(w), Math.ceil(h)];
            })()`
          }, (results) => {
            if (!chrome.runtime.lastError && results && results[0]) {
              const [cw, ch] = results[0];
              if (cw > 10 && ch > 10) {
                const fw = Math.min(cw, MAX_W);
                const fh = Math.min(ch, MAX_H);
                popup.style.width = fw + "px";
                popup.style.height = fh + "px";
                positionPopup(popup, anchor, fw, fh);
              }
            }
            popup.style.visibility = "";
            requestAnimationFrame(() => popup.classList.add("open"));
          });
        } catch (_) {
          popup.style.visibility = "";
          requestAnimationFrame(() => popup.classList.add("open"));
        }
      }, 150);
    }, { once: true });

    positionPopup(popup, anchor, 1, 1);
    appEl.appendChild(popup);

    const entry = { el: popup, anchor };
    state.popups.push(entry);

    const dismiss = (e) => {
      if (popup.contains(e.target) || anchor.contains(e.target)) return;
      dismissPopup(popup);
      document.removeEventListener("mousedown", dismiss, true);
    };
    setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
  }

  function dismissPopup(popup) {
    popup.classList.remove("open");
    popup.classList.add("closing");
    popup.addEventListener("animationend", () => popup.remove(), { once: true });
    setTimeout(() => popup.remove(), 220);
    state.popups = state.popups.filter((p) => p.el !== popup);
  }

  function closeAllPopups() {
    const toClose = state.popups.slice();
    state.popups = [];
    for (const p of toClose) {
      p.el.classList.remove("open");
      p.el.classList.add("closing");
      p.el.addEventListener("animationend", () => p.el.remove(), { once: true });
      setTimeout(() => p.el.remove(), 220);
    }
  }

  /* ─── context menu ──────────────────────────────── */

  const ctxMenu = $("ctx-menu");

  function openCtxMenu(x, y) {
    ctxMenu.style.left = "0px";
    ctxMenu.style.top = "0px";
    ctxMenu.style.display = "flex";

    const rect = ctxMenu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;

    let left = x;
    let top = y;

    if (left + rect.width > vw - pad) left = vw - rect.width - pad;
    if (left < pad) left = pad;
    if (top + rect.height > vh - pad) top = vh - rect.height - pad;
    if (top < pad) top = pad;

    ctxMenu.style.left = left + "px";
    ctxMenu.style.top = top + "px";

    requestAnimationFrame(() => ctxMenu.classList.add("open"));
  }

  function closeCtxMenu() {
    ctxMenu.classList.remove("open");
    setTimeout(() => {
      if (!ctxMenu.classList.contains("open")) ctxMenu.style.display = "none";
    }, 200);
  }

  function handleCtxAction(action) {
    switch (action) {
      case "new-tab":
        openPalette("", true);
        break;
      case "new-window":
        chrome.windows.create({ focused: true });
        break;
      case "back":
        withActiveView((v) => v.back && v.back());
        break;
      case "forward":
        withActiveView((v) => v.forward && v.forward());
        break;
      case "reload":
        if (state.activeId != null) chrome.tabs.reload(state.activeId);
        break;
      case "bookmark-page":
        toggleBookmark();
        break;
      case "copy-url":
        if (state.activeId != null) {
          const active = state.tabs.find((t) => t.id === state.activeId);
          if (active && active.url) {
            navigator.clipboard.writeText(active.url).catch(() => {});
            showToast("URL copied");
          }
        }
        break;
      case "toggle-sidebar":
        toggleSidebar();
        break;
      case "devtools":
        if (typeof vivaldi !== "undefined" && vivaldi.devtoolsPrivate) {
          vivaldi.devtoolsPrivate.toggleDevtools(state.windowId, "console");
        }
        break;
      case "close-tab":
        if (state.activeId != null) chrome.tabs.remove(state.activeId);
        break;
    }
    closeCtxMenu();
  }

  /* ─── bindings ──────────────────────────────────── */

  function bindUI() {
    $("back").addEventListener("click", () =>
      withActiveView((v) => v.back && v.back()),
    );
    $("forward").addEventListener("click", () =>
      withActiveView((v) => v.forward && v.forward()),
    );
    $("reload").addEventListener("click", () => {
      if (state.activeId != null) chrome.tabs.reload(state.activeId);
    });
    $("devtools").addEventListener("click", () => {
      if (typeof vivaldi !== "undefined" && vivaldi.devtoolsPrivate) {
        vivaldi.devtoolsPrivate.toggleDevtools(state.windowId, "console");
      }
    });
    $("toggle").addEventListener("click", toggleSidebar);
    $("reveal").addEventListener("click", showSidebar);
    $("newtab").addEventListener("click", () => openPalette("", true));
    $("empty-new").addEventListener("click", () => openPalette("", true));

    // History & Bookmarks toggles
    $("toggle-history").addEventListener("click", () => {
      if ($("history-panel").classList.contains("open")) {
        closeHistoryPanel();
      } else {
        openHistoryPanel();
      }
    });

    $("toggle-bookmarks").addEventListener("click", () => {
      if ($("bookmarks-panel").classList.contains("open")) {
        closeBookmarksPanel();
      } else {
        openBookmarksPanel();
      }
    });

    $("history-back").addEventListener("click", closeHistoryPanel);
    $("bookmarks-back").addEventListener("click", closeBookmarksPanel);

    $("history-search").addEventListener("input", () => {
      loadHistoryItems($("history-search").value);
    });

    $("bookmarks-search").addEventListener("input", () => {
      loadBookmarkItems($("bookmarks-search").value);
    });

    $("clear-history").addEventListener("click", () => {
      if (!chrome.history) return;
      chrome.history.deleteAll(() => {
        loadHistoryItems("");
        showToast("History cleared");
      });
    });

    $("bookmark-current").addEventListener("click", () => {
      toggleBookmark();
    });

    $("bookmark-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBookmark();
    });

    // Zen trigger
    $("zen-search-wrapper").addEventListener("click", () => openPalette("", false));
    $("add-dial-btn").addEventListener("click", openDialDialog);
    $("dial-cancel").addEventListener("click", closeDialDialog);
    $("dial-save").addEventListener("click", saveDialDialog);

    $("manage-ext").addEventListener("click", () => {
      chrome.tabs.create({ windowId: state.windowId, url: "chrome://extensions", active: true });
    });

    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const url = smartUrl(urlInput.value);
        if (!url) return;
        if (state.activeId == null) {
          chrome.tabs.create({ windowId: state.windowId, url });
        } else {
          chrome.tabs.update(state.activeId, { url });
        }
        urlInput.blur();
      } else if (e.key === "Escape") {
        urlInput.blur();
        syncOmnibox();
      }
    });
    urlInput.addEventListener("focus", () => urlInput.select());

    // Palette listeners
    paletteInput.addEventListener("input", updatePaletteResults);
    paletteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        executeSelectedResult(e.ctrlKey);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        selectItem((paletteSelectedIndex + 1) % paletteResultsList.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectItem((paletteSelectedIndex - 1 + paletteResultsList.length) % paletteResultsList.length);
      }
    });

    palette.addEventListener("cancel", (e) => {
      e.preventDefault();
      closePalette();
    });

    palette.addEventListener("click", (e) => {
      if (e.target === palette) closePalette();
    });

    $("palette-close").addEventListener("click", closePalette);

    // Escape listener
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        if (ctxMenu.classList.contains("open")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeCtxMenu();
        } else if (palette.open) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closePalette();
        } else if (state.popups.length) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeAllPopups();
        } else if ($("history-panel").classList.contains("open")) {
          e.preventDefault();
          closeHistoryPanel();
        } else if ($("bookmarks-panel").classList.contains("open")) {
          e.preventDefault();
          closeBookmarksPanel();
        }
      },
      true,
    );

    // Host page keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      switch (e.key) {
        case "t":
          e.preventDefault();
          openPalette("", true);
          break;
        case "w":
          e.preventDefault();
          if (state.activeId != null) chrome.tabs.remove(state.activeId);
          break;
        case "l":
          e.preventDefault();
          showSidebar();
          urlInput.focus();
          break;
        case "r":
          e.preventDefault();
          if (state.activeId != null) {
            if (e.shiftKey) chrome.tabs.reload(state.activeId, { bypassCache: true });
            else chrome.tabs.reload(state.activeId);
          }
          break;
        case "b":
          e.preventDefault();
          toggleSidebar();
          break;
        case "d":
          e.preventDefault();
          toggleBookmark();
          break;
        case "h":
          e.preventDefault();
          if ($("history-panel").classList.contains("open")) closeHistoryPanel();
          else openHistoryPanel();
          break;
        case "Tab":
          if (state.tabs.length < 2) break;
          e.preventDefault();
          {
            const idx = state.tabs.findIndex((t) => t.id === state.activeId);
            const dir = e.shiftKey ? -1 : 1;
            const next = state.tabs[(idx + dir + state.tabs.length) % state.tabs.length];
            if (next) chrome.tabs.update(next.id, { active: true });
          }
          break;
      }
    });

    window.addEventListener("resize", closeAllPopups);

    // Context menu
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY);
    });

    ctxMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".ctx-item");
      if (item) handleCtxAction(item.dataset.action);
    });

    document.addEventListener("mousedown", (e) => {
      if (!ctxMenu.contains(e.target)) closeCtxMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeCtxMenu();
    });
  }

  function handleForwardedKeyEvent(e) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (mod) {
      switch (key) {
        case "t":
          openPalette("", true);
          break;
        case "w":
          if (state.activeId != null) chrome.tabs.remove(state.activeId);
          break;
        case "l":
          showSidebar();
          urlInput.focus();
          break;
        case "r":
          if (state.activeId != null) {
            if (e.shiftKey) chrome.tabs.reload(state.activeId, { bypassCache: true });
            else chrome.tabs.reload(state.activeId);
          }
          break;
        case "b":
          toggleSidebar();
          break;
        case "d":
          toggleBookmark();
          break;
        case "h":
          if ($("history-panel").classList.contains("open")) closeHistoryPanel();
          else openHistoryPanel();
          break;
        case "Tab":
          if (state.tabs.length < 2) break;
          {
            const idx = state.tabs.findIndex((t) => t.id === state.activeId);
            const dir = e.shiftKey ? -1 : 1;
            const next = state.tabs[(idx + dir + state.tabs.length) % state.tabs.length];
            if (next) chrome.tabs.update(next.id, { active: true });
          }
          break;
      }
    } else if (key === "Escape") {
      if (ctxMenu.classList.contains("open")) {
        closeCtxMenu();
      } else if (palette.open) {
        closePalette();
      } else if (state.popups.length) {
        closeAllPopups();
      } else if ($("history-panel").classList.contains("open")) {
        closeHistoryPanel();
      } else if ($("bookmarks-panel").classList.contains("open")) {
        closeBookmarksPanel();
      }
    } else if (e.altKey) {
      if (key === "ArrowLeft") withActiveView((v) => v.back && v.back());
      else if (key === "ArrowRight") withActiveView((v) => v.forward && v.forward());
    } else if (key === "F5") {
      if (state.activeId != null) {
        if (e.shiftKey) chrome.tabs.reload(state.activeId, { bypassCache: true });
        else chrome.tabs.reload(state.activeId);
      }
    }
  }

  function bindBrowserEvents() {
    if (typeof vivaldi !== "undefined" && vivaldi.tabsPrivate && vivaldi.tabsPrivate.onKeyboardShortcut) {
      vivaldi.tabsPrivate.onKeyboardShortcut.addListener((windowId, shortcut) => {
        if (windowId !== state.windowId) return;
        const s = (shortcut || "").toLowerCase().replace(/\s/g, "");
        if (s === "ctrl+t") openPalette("", true);
      });
    }

    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.windowId !== state.windowId) return;
      if (suppressPaletteAutoOpen) return;
      openPalette("", true);
      suppressPaletteAutoOpen = true;
    });

    const tabEvts = [
      "onCreated", "onUpdated", "onRemoved", "onActivated",
      "onMoved", "onReplaced", "onAttached", "onDetached",
      "onHighlighted",
    ];
    for (const e of tabEvts) {
      try { chrome.tabs[e].addListener(refreshTabs); } catch (_) {}
    }

    // Capture screenshot when a tab becomes active
    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
      if (windowId !== state.windowId) return;
      setTimeout(() => captureTabScreenshot(tabId), 500);
    });

    if (chrome.management) {
      const extEvts = ["onInstalled", "onUninstalled", "onEnabled", "onDisabled"];
      for (const e of extEvts) {
        try { chrome.management[e].addListener(loadExtensions); } catch (_) {}
      }
    }
  }

  /* ─── boot ──────────────────────────────────────── */

  async function main() {
    try {
      state.windowId = await getWindowId();
      bindUI();
      bindBrowserEvents();
      await Promise.all([refreshTabs(), loadExtensions()]);
    } catch (err) {
      document.body.innerHTML =
        '<pre style="color:#fff;padding:20px;font:12px monospace">eyebrow boot error\n\n' +
        (err && (err.stack || err.message || err)) +
        "</pre>";
    }
  }

  window.addEventListener("load", main);
})();
