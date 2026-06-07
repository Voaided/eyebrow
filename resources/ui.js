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

  /* ─── webviews ──────────────────────────────────── */

  const KEYBOARD_INJECT_CODE = `(function(){
    if(window.__eyebrow_keys_injected)return;
    window.__eyebrow_keys_injected=true;
    window.addEventListener("keydown",function(e){
      var isMod=e.ctrlKey||e.metaKey;
      var key=e.key;
      var isShortcut=
        (isMod&&["t","w","l","r","b","Tab"].indexOf(key)!==-1)||
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
  })();`;

  function injectKeyboardListener(view) {
    try {
      view.executeScript({ code: KEYBOARD_INJECT_CODE }, () => {
        if (chrome.runtime.lastError) {
          // silently ignore — some pages (chrome://, about:) block injection
        }
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

    // Intercept console messages from the injected keyboard script
    view.addEventListener("consolemessage", (e) => {
      if (e.message && e.message.startsWith("eyebrow-keydown:")) {
        try {
          const data = JSON.parse(e.message.substring("eyebrow-keydown:".length));
          handleForwardedKeyEvent(data);
        } catch (err) {}
      }
    });

    // Inject keyboard listener script after each page load inside the webview
    view.addEventListener("loadstop", () => {
      injectKeyboardListener(view);
    });
    // Also try on contentload (fires earlier on some pages)
    view.addEventListener("contentload", () => {
      injectKeyboardListener(view);
    });

    viewportEl.appendChild(view);
    return view;
  }

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
      close.textContent = "\u00d7";
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
    
    // Zen New Tab Page toggle
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
    state.activeId = active ? active.id : null;

    renderTabs();
    syncViews();
    syncOmnibox();

    // Auto-open palette when focusing on a new blank tab
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

  /* ─── command palette (zen-style "new tab") ─────── */

  function openPalette(prefill, newTabMode = false) {
    paletteNewTabMode = newTabMode;
    // blur webviews
    for (const wv of document.querySelectorAll("webview")) {
      try { wv.blur(); } catch (_) {}
    }
    if (document.activeElement && document.activeElement !== paletteInput) {
      try { document.activeElement.blur(); } catch (_) {}
    }

    paletteInput.value = prefill || "";
    if (!palette.open) palette.showModal();
    updatePaletteResults(); // Initial render

    // focus palette
    clearInterval(paletteFocusTimer);
    const grab = () => {
      try {
        paletteInput.focus({ preventScroll: true });
      } catch (_) {}
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
      chrome.tabs.create({
        windowId: state.windowId,
        url,
        active: true,
      });
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
      if (data && Array.isArray(data[1])) {
        return data[1].slice(0, 5);
      }
    } catch (e) {
      console.warn("[eyebrow] suggestion error:", e);
    }
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

    // URL navigate result at the top
    if (looksLikeUrl(query)) {
      results.push({
        type: "navigate",
        title: query.startsWith("http") ? query : "https://" + query,
        subtitle: "Navigate to URL",
        url: query.startsWith("http") ? query : "https://" + query,
      });
    }

    // 1. Matches in open tabs
    const openTabs = state.tabs.filter(t => 
      (t.title && t.title.toLowerCase().includes(queryLower)) ||
      (t.url && t.url.toLowerCase().includes(queryLower))
    );
    for (const tab of openTabs.slice(0, 4)) {
      results.push({
        type: "tab",
        title: tab.title || tab.url,
        subtitle: "Switch to Tab",
        url: tab.url,
        tabId: tab.id,
        icon: tab.favIconUrl || ""
      });
    }

    // 2. Local Bookmarks & History
    const [history, bookmarks] = await Promise.all([
      searchHistory(query),
      searchBookmarks(query)
    ]);

    for (const bm of bookmarks.slice(0, 4)) {
      results.push({
        type: "bookmark",
        title: bm.title,
        subtitle: bm.url,
        url: bm.url
      });
    }

    for (const hist of history.slice(0, 4)) {
      results.push({
        type: "history",
        title: hist.title || hist.url,
        subtitle: hist.url,
        url: hist.url
      });
    }

    // 3. Fallback direct google search item
    results.push({
      type: "search",
      title: query,
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

    // Local results phase
    const localResults = await searchAll(query);
    if (lastQuery !== query) return;

    renderPaletteResults(localResults);

    // Dynamic Google suggestions merge phase
    try {
      const suggestions = await fetchSuggestions(query);
      if (lastQuery !== query) return;

      const currentTitles = new Set(localResults.map(r => r.title.toLowerCase()));
      const sugResults = [];

      for (const sug of suggestions) {
        if (!currentTitles.has(sug.toLowerCase()) && sug.toLowerCase() !== query.toLowerCase()) {
          sugResults.push({
            type: "search",
            title: sug,
            subtitle: "Google Search Suggestion",
            url: `https://www.google.com/search?q=${encodeURIComponent(sug)}`
          });
        }
      }

      if (sugResults.length > 0) {
        const searchFallbackIndex = localResults.findIndex(r => r.type === "search" && r.title === query);
        if (searchFallbackIndex !== -1) {
          localResults.splice(searchFallbackIndex, 0, ...sugResults);
        } else {
          localResults.push(...sugResults);
        }
        renderPaletteResults(localResults);
      }
    } catch (err) {
      console.warn("[eyebrow] suggestion merge failed:", err);
    }
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
    paletteSelectedIndex = 0; // Default first selection

    let currentType = null;

    results.forEach((item, idx) => {
      // Create type headers
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

      // Icon
      const iconWrap = document.createElement("div");
      iconWrap.className = "item-icon";
      iconWrap.innerHTML = getIconSvg(item.type, item.icon);
      el.appendChild(iconWrap);

      // Text Stack
      const textStack = document.createElement("div");
      textStack.className = "item-text-stack";

      const title = document.createElement("span");
      title.className = "item-title";
      
      // Highlight matching query text
      const query = paletteInput.value.trim().toLowerCase();
      const textStr = item.title;
      const qIdx = textStr.toLowerCase().indexOf(query);
      if (qIdx !== -1 && query.length > 0) {
        const part1 = textStr.substring(0, qIdx);
        const part2 = textStr.substring(qIdx, qIdx + query.length);
        const part3 = textStr.substring(qIdx + query.length);
        
        title.innerHTML = `${escapeHtml(part1)}<mark class="highlight">${escapeHtml(part2)}</mark>${escapeHtml(part3)}`;
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

      // Tag
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
    if (items[paletteSelectedIndex]) {
      items[paletteSelectedIndex].classList.remove("selected");
    }
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
        return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
    }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  /* ─── Zen Dashboard Controller ────────────────── */

  function updateZenClock() {
    const clockEl = $("zen-clock");
    const dateEl = $("zen-date");
    const greetingEl = $("zen-greeting");
    if (!clockEl) return;

    const now = new Date();

    // Time
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours ? hours : 12;
    clockEl.textContent = `${hours}:${minutes} ${ampm}`;

    // Date
    const dateOpts = { weekday: "long", month: "long", day: "numeric" };
    dateEl.textContent = now.toLocaleDateString("en-US", dateOpts);

    // Greeting (hardcoded to Gaurish per approved plan)
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

      // Vivaldi favicon resolver API
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

    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

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

    // Toggle: if the same anchor is already open, close it
    if (state.popups.length > 0 && state.popups[0].anchor === anchor) {
      closeAllPopups();
      return;
    }

    vivaldi.extensionActionUtils.executeExtensionAction(
      ext.id,
      state.windowId,
      (data) => {
        if (!data || !data.popupUrl) return;
        const preferredW = data.width || null;
        const preferredH = data.height || null;
        showExtensionPopup(data.popupUrl, anchor, preferredW, preferredH);
      },
    );
  }

  function positionPopup(popup, anchor, w, h) {
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Try to place above the anchor, left-aligned with button
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top - h - margin;

    // If it would go above the screen, place below instead
    if (top < margin) top = rect.bottom + margin;

    // Clamp horizontally
    if (left + w > vw - margin) left = vw - w - margin;
    if (left < margin) left = margin;

    // Clamp vertically
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
    popup.addEventListener("animationend", () => {
      popup.remove();
    }, { once: true });
    // Fallback in case animationend doesn't fire
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
    
    // Zen trigger
    $("zen-search-wrapper").addEventListener("click", () => openPalette("", false));
    $("add-dial-btn").addEventListener("click", openDialDialog);
    $("dial-cancel").addEventListener("click", closeDialDialog);
    $("dial-save").addEventListener("click", saveDialDialog);
    
    $("manage-ext").addEventListener("click", () => {
      chrome.tabs.create({
        windowId: state.windowId,
        url: "chrome://extensions",
        active: true,
      });
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
        if (palette.open) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closePalette();
        } else if (state.popups.length) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeAllPopups();
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
            if (e.shiftKey) {
              chrome.tabs.reload(state.activeId, { bypassCache: true });
            } else {
              chrome.tabs.reload(state.activeId);
            }
          }
          break;
        case "b":
          e.preventDefault();
          toggleSidebar();
          break;
        case "Tab":
          if (state.tabs.length < 2) break;
          e.preventDefault();
          {
            const idx = state.tabs.findIndex((t) => t.id === state.activeId);
            const dir = e.shiftKey ? -1 : 1;
            const next =
              state.tabs[(idx + dir + state.tabs.length) % state.tabs.length];
            if (next) chrome.tabs.update(next.id, { active: true });
          }
          break;
      }
    });

    window.addEventListener("resize", closeAllPopups);
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
            if (e.shiftKey) {
              chrome.tabs.reload(state.activeId, { bypassCache: true });
            } else {
              chrome.tabs.reload(state.activeId);
            }
          }
          break;
        case "b":
          toggleSidebar();
          break;
        case "Tab":
          if (state.tabs.length < 2) break;
          {
            const idx = state.tabs.findIndex((t) => t.id === state.activeId);
            const dir = e.shiftKey ? -1 : 1;
            const next =
              state.tabs[(idx + dir + state.tabs.length) % state.tabs.length];
            if (next) chrome.tabs.update(next.id, { active: true });
          }
          break;
      }
    } else if (key === "Escape") {
      if (palette.open) {
        closePalette();
      } else if (state.popups.length) {
        closeAllPopups();
      }
    } else if (e.altKey) {
      if (key === "ArrowLeft") {
        withActiveView((v) => v.back && v.back());
      } else if (key === "ArrowRight") {
        withActiveView((v) => v.forward && v.forward());
      }
    } else if (key === "F5") {
      if (state.activeId != null) {
        if (e.shiftKey) {
          chrome.tabs.reload(state.activeId, { bypassCache: true });
        } else {
          chrome.tabs.reload(state.activeId);
        }
      }
    }
  }

  function bindBrowserEvents() {
    if (typeof vivaldi !== "undefined" && vivaldi.tabsPrivate && vivaldi.tabsPrivate.onKeyboardShortcut) {
      vivaldi.tabsPrivate.onKeyboardShortcut.addListener((windowId, shortcut) => {
        if (windowId !== state.windowId) return;
        const s = (shortcut || "").toLowerCase().replace(/\s/g, "");
        if (s === "ctrl+t") {
          openPalette("", true);
        }
      });
    }

    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.windowId !== state.windowId) return;
      if (suppressPaletteAutoOpen) return;
      openPalette("", true);
      suppressPaletteAutoOpen = true;
    });

    const tabEvts = [
      "onCreated",
      "onUpdated",
      "onRemoved",
      "onActivated",
      "onMoved",
      "onReplaced",
      "onAttached",
      "onDetached",
      "onHighlighted",
    ];
    for (const e of tabEvts) {
      try {
        chrome.tabs[e].addListener(refreshTabs);
      } catch (_) {}
    }
    if (chrome.management) {
      const extEvts = ["onInstalled", "onUninstalled", "onEnabled", "onDisabled"];
      for (const e of extEvts) {
        try {
          chrome.management[e].addListener(loadExtensions);
        } catch (_) {}
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
