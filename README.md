# eyebrow

a tiny custom UI shell for [vivaldi](https://vivaldi.com/), built on the same
trick as [velzie/vivaldi-custom-ui-demo](https://github.com/velzie/vivaldi-custom-ui-demo).
no build step, no framework — just `window.html` + `ui.js` + `ui.css`
dropped on top of vivaldi's chromium fork while the stock react bundle is
emptied out.

## what's in here

```
resources/
  window.html   ← replaces vivaldi/resources/vivaldi/window.html
  ui.js         ← our UI (vanilla, uses chrome.* + vivaldi.* globals)
  ui.css        ← styles
install.sh      ← copy /opt/vivaldi → ./vivaldi, back up originals
deploy.sh      ← stage resources/* into ./vivaldi and blank bundle.js
run.sh         ← launch ./vivaldi/vivaldi with ./data as user-data-dir
restore.sh     ← put the stock UI back if you want it
```

## setup

```sh
./install.sh        # one-time: clones /opt/vivaldi → ./vivaldi
./run.sh            # launches with our UI
```

after editing anything in `resources/`:

```sh
./deploy.sh         # restage files
./run.sh
```

if vivaldi lives somewhere other than `/opt/vivaldi`:

```sh
VIVALDI_SRC=/path/to/vivaldi ./install.sh
```

## features

## features

- **floating glass sidebar** — sits on top of the webview, backdrop-blur + translucent, never reflows the page
- **vertical tabs** with favicons, loading spinner, middle-click close
- **omnibox** at the top of the sidebar navigates the *current* tab
- **zen-style new tab** — `+` and `Ctrl+T` open a centered command palette; you type a url/query and hit `↵` to spawn the tab. no `chrome://newtab` page.
- **extensions tray** in the sidebar footer — lists every enabled extension, click to fire its action / show its popup, right-click to open its `chrome://extensions` page
- **collapsible sidebar** — toggle pill on the top-right of the sidebar, floating hamburger button when collapsed, `Ctrl+B`
- **shortcuts**: `Ctrl+T` palette · `Ctrl+W` close tab · `Ctrl+L` focus omnibox · `Ctrl+R` reload · `Ctrl+B` toggle sidebar · `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs · `Esc` dismiss palette/popup
- the stock vivaldi react UI is gone — `bundle.js` is truncated to 0 bytes

## debugging

go to `chrome://inspect/#apps` in a regular browser and inspect
`chrome-extension://<vivaldi-id>/window.html` to get devtools on the
shell itself. or click the devtools button in the toolbar.
