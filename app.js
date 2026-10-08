/* My Book Reader: plays your converted audiobooks from Google Drive, offline, and keeps your
   place in sync between devices through a small file in your Drive's private app folder. */
(() => {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata";
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2];
  const SKIP = 30;
  const $ = (id) => document.getElementById(id);
  const audio = $("audio");

  // ---------- small helpers ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("mbr." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("mbr." + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem("mbr." + k); } catch { /* ignore */ } },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clock = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const human = (sec) => {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  };
  const mb = (bytes) => bytes ? `${Math.round(bytes / 1048576)} MB` : "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deviceId = store.get("device") || (() => { const id = Math.random().toString(36).slice(2, 10); store.set("device", id); return id; })();

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };

  // ---------- state ----------
  const S = {
    books: store.get("books", []),
    progress: store.get("progress", {}),
    downloaded: store.get("downloaded", {}),
    settings: Object.assign({ speed: 1, theme: "auto" }, store.get("settings", {})),
    current: store.get("current", null),
    filter: "all",
    dl: {},          // key -> fraction while downloading
    token: null, tokenExp: 0,
    sleep: null,     // {until} or {chapterEnd}
    remoteId: null,
  };
  const saved = store.get("token", null);
  if (saved && saved.exp > Date.now()) { S.token = saved.token; S.tokenExp = saved.exp; }
  const bookBy = (key) => S.books.find((b) => b.key === key);
  const saveBooks = () => store.set("books", S.books);
  const saveProgress = () => store.set("progress", S.progress);

  // ---------- theme ----------
  const lightQuery = matchMedia("(prefers-color-scheme: light)");
  function applyTheme() {
    const t = S.settings.theme === "auto" ? (lightQuery.matches ? "light" : "dark") : S.settings.theme;
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", t === "light" ? "#F3EFE7" : "#0B1427"));
  }
  lightQuery.addEventListener?.("change", applyTheme);

  // ---------- toast and sync chip ----------
  let toastTimer;
  function toast(msg, ms = 2800) {
    const el = $("toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms);
  }
  let chipTimer;
  function chip(text, warn = false, fade = false) {
    const el = $("sync-status"); el.textContent = text; el.classList.toggle("warn", warn);
    clearTimeout(chipTimer); if (fade) chipTimer = setTimeout(() => (el.textContent = ""), 2500);
  }

  // ---------- Google sign-in (token only, no server) ----------
  class AuthError extends Error {}
  let tokenClient = null, waiters = [];
  const tokenValid = () => S.token && S.tokenExp > Date.now();
  function loadGis() {
    return new Promise((res, rej) => {
      if (window.google?.accounts?.oauth2) return res();
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error("Could not reach Google. Check your connection."));
      document.head.appendChild(s);
    });
  }
  async function initAuth() {
    if (tokenClient) return;
    await loadGis();
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPES,
      callback: (r) => {
        const ws = waiters; waiters = [];
        if (r.error) { ws.forEach((w) => w.reject(new AuthError(r.error))); return; }
        S.token = r.access_token; S.tokenExp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
        store.set("token", { token: S.token, exp: S.tokenExp });
        store.set("signedIn", true);
        ws.forEach((w) => w.resolve(S.token));
      },
      error_callback: (e) => { const ws = waiters; waiters = []; ws.forEach((w) => w.reject(new AuthError(e?.type || "popup_closed"))); },
    });
  }
  // Must be called from a tap, because Google shows a small pop-up.
  async function signIn() {
    await initAuth();
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      tokenClient.requestAccessToken({ prompt: store.get("signedIn") ? "" : "consent" });
    });
  }
  async function gfetch(url, opts = {}) {
    if (!tokenValid()) throw new AuthError("expired");
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + S.token } });
    if (r.status === 401) { S.token = null; store.del("token"); throw new AuthError("expired"); }
    if (!r.ok) throw new Error(`Google Drive said ${r.status}`);
    return r;
  }
  const q = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  async function listAll(query, fields, spaces = "drive") {
    let out = [], page = "";
    do {
      const u = `${API}/files?spaces=${spaces}&pageSize=1000&q=${encodeURIComponent(query)}&fields=${encodeURIComponent("nextPageToken,files(" + fields + ")")}` + (page ? `&pageToken=${page}` : "");
      const j = await (await gfetch(u)).json();
      out = out.concat(j.files || []); page = j.nextPageToken || "";
    } while (page);
    return out;
  }
  async function findFolder(name, parent) {
    const f = await listAll(`name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : ""), "id,name");
    return f[0] || null;
  }

  // ---------- library ----------
  const COVERS = "mbr-covers", BOOKS = "mbr-books";
  const coverUrls = {};
  async function coverUrl(key) {
    if (key in coverUrls) return coverUrls[key];
    try {
      const r = await (await caches.open(COVERS)).match("covers/" + encodeURIComponent(key));
      coverUrls[key] = r ? URL.createObjectURL(await r.blob()) : null;
    } catch { coverUrls[key] = null; }
    return coverUrls[key];
  }
  async function refreshLibrary() {
    chip("Updating library");
    const root = await findFolder(CFG.DRIVE_FOLDER || "Audiobooks");
    if (!root) { chip(""); renderGrid(`There is no "${esc(CFG.DRIVE_FOLDER)}" folder in your Google Drive yet. Run the converter once and it will appear.`); return; }
    const ready = await findFolder(CFG.READY_FOLDER || "Ready", root.id);
    if (!ready) { chip(""); renderGrid(`Your Drive has an "${esc(CFG.DRIVE_FOLDER)}" folder but no "Ready" folder inside it yet.`); return; }
    const files = await listAll(`'${ready.id}' in parents and trashed=false`, "id,name,size,modifiedTime");
    const groups = {};
    for (const f of files) {
      const m = f.name.match(/^(.*)\.(m4b|json|jpg)$/i);
      if (!m) continue;
      (groups[m[1]] ||= {})[m[2].toLowerCase()] = f;
    }
    const books = [];
    for (const [key, g] of Object.entries(groups)) {
      if (!g.m4b) continue;
      const old = bookBy(key) || {};
      let info = old.info && old.infoMod === g.json?.modifiedTime ? old.info : null;
      if (!info && g.json) { try { info = await (await gfetch(`${API}/files/${g.json.id}?alt=media`)).json(); } catch { info = null; } }
      info ||= { title: key, author: "", duration: 0, chapters: [] };
      if (g.jpg && old.coverMod !== g.jpg.modifiedTime) {
        try {
          const blob = await (await gfetch(`${API}/files/${g.jpg.id}?alt=media`)).blob();
          await (await caches.open(COVERS)).put("covers/" + encodeURIComponent(key), new Response(blob, { headers: { "Content-Type": "image/jpeg" } }));
          if (coverUrls[key]) URL.revokeObjectURL(coverUrls[key]);
          delete coverUrls[key];
        } catch { /* cover is optional */ }
      }
      books.push({
        key, info, infoMod: g.json?.modifiedTime || null, coverMod: g.jpg?.modifiedTime || old.coverMod || null,
        m4b: { id: g.m4b.id, size: Number(g.m4b.size || 0), modified: g.m4b.modifiedTime },
      });
    }
    books.sort((a, b) => a.info.title.localeCompare(b.info.title));
    S.books = books; saveBooks();
    renderLibrary();
    chip("");
  }
  const authorOf = (b) => (b.info.author && b.info.author !== "Unknown" ? b.info.author : "");

  // ---------- rendering ----------
  function pct(key) {
    const b = bookBy(key), p = S.progress[key];
    const d = b?.info.duration || p?.dur || 0;
    if (!p || !d) return 0;
    return p.done ? 100 : Math.min(100, Math.round((p.pos / d) * 100));
  }
  function chapterAt(book, t) {
    const ch = book?.info.chapters || [];
    let i = 0;
    for (let j = 0; j < ch.length; j++) if (ch[j].start <= t + 0.25) i = j;
    return ch.length ? { i, ...ch[i] } : null;
  }
  function coverHtml(b, url) {
    return url ? `<img src="${url}" alt="" loading="lazy">`
      : `<div class="placeholder-cover"><b>${esc(b.info.title)}</b><i>${esc(authorOf(b))}</i></div>`;
  }
  async function renderContinue() {
    const el = $("continue");
    const keys = Object.keys(S.progress).filter((k) => bookBy(k) && !S.progress[k].done);
    keys.sort((a, b) => (S.progress[b].updated || 0) - (S.progress[a].updated || 0));
    const key = S.current && bookBy(S.current) && !S.progress[S.current]?.done ? S.current : keys[0];
    if (!key) { el.hidden = true; return; }
    const b = bookBy(key), p = S.progress[key] || { pos: 0 }, url = await coverUrl(key);
    const ch = chapterAt(b, p.pos);
    const left = (b.info.duration || 0) - p.pos;
    el.hidden = false;
    el.innerHTML = `<h2 class="section-title" style="margin-bottom:12px">Continue listening</h2>
      <button class="continue-card" data-key="${esc(key)}">
        ${url ? `<img src="${url}" alt="">` : `<div class="placeholder-cover" style="width:80px;height:120px;border-radius:10px"><b style="font-size:12px">${esc(b.info.title)}</b></div>`}
        <span>
          <p class="continue-title">${esc(b.info.title)}</p>
          <p class="continue-ch">${esc(ch ? ch.title : authorOf(b))}${b.info.duration ? ` · ${human(left)} left` : ""}</p>
          <span class="continue-row"><span class="resume">${ICON.play}${p.pos > 5 ? "Resume" : "Play"}</span><span class="bar"><span style="width:${pct(key)}%"></span></span></span>
        </span>
      </button>`;
    el.querySelector(".continue-card").onclick = () => tapBook(key, true);
  }
  async function renderGrid(emptyMsg) {
    const grid = $("grid"), empty = $("empty");
    let list = S.books;
    if (S.filter === "downloaded") list = list.filter((b) => S.downloaded[b.key]);
    if (!list.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = emptyMsg || (S.filter === "downloaded"
        ? "Nothing is downloaded on this device yet. Open a book and tap Download to listen offline."
        : "No books yet. Audiobooks you convert into Google Drive, in Audiobooks › Ready, will show up here.");
      return;
    }
    empty.hidden = true;
    const html = await Promise.all(list.map(async (b) => {
      const url = await coverUrl(b.key), p = pct(b.key), dl = S.dl[b.key];
      let badge = "";
      if (dl !== undefined) badge = `<span class="book-badge ring" style="--p:${Math.round(dl * 100)}"></span>`;
      else if (S.downloaded[b.key]) badge = `<span class="book-badge" title="On this device">${ICON.check}</span>`;
      return `<button class="book" data-key="${esc(b.key)}">
        <span class="book-cover">${coverHtml(b, url)}${badge}</span>
        ${p ? `<span class="bar"><span style="width:${p}%"></span></span>` : ""}
        <p class="book-title">${esc(b.info.title)}</p>
        <p class="book-author">${esc(authorOf(b) || (b.info.duration ? human(b.info.duration) : ""))}</p>
      </button>`;
    }));
    grid.innerHTML = html.join("");
    grid.querySelectorAll(".book").forEach((el) => (el.onclick = () => tapBook(el.dataset.key)));
  }
  function renderLibrary() { renderContinue(); renderGrid(); }

  // ---------- sheets ----------
  function openSheet(html, onMount) {
    if ($("sheet").hidden) history.pushState({ o: 1 }, "");
    $("sheet-body").innerHTML = html; $("sheet").hidden = false; $("scrim").hidden = false;
    onMount && onMount($("sheet-body"));
  }
  function closeSheet() { $("sheet").hidden = true; $("scrim").hidden = true; $("sheet-body").innerHTML = ""; sheetBook = null; }
  $("scrim").onclick = closeSheet;
  let sheetBook = null;

  async function tapBook(key, fromContinue = false) {
    if (S.downloaded[key] && (fromContinue || S.current === key)) return openBook(key);
    const b = bookBy(key); if (!b) return;
    sheetBook = key;
    const url = await coverUrl(key), p = S.progress[key];
    const isDl = !!S.downloaded[key], busy = S.dl[key] !== undefined;
    const info = [authorOf(b), b.info.duration ? human(b.info.duration) : "", b.info.chapters?.length ? `${b.info.chapters.length} chapters` : ""].filter(Boolean).join(" · ");
    openSheet(`
      <div class="sheet-book">${coverHtml(b, url)}<div><h3>${esc(b.info.title)}</h3><p class="sheet-sub" style="margin:0">${esc(info)}</p></div></div>
      <div class="sheet-actions">
        ${isDl ? `<button class="btn btn-primary" data-act="play">${p?.pos > 5 && !p.done ? "Resume" : "Play"}</button>` : ""}
        ${!isDl && !busy ? `<button class="btn btn-primary" data-act="download">Download to this device${b.m4b.size ? ` (${mb(b.m4b.size)})` : ""}</button>` : ""}
        ${busy ? `<div><div class="progress-line"><span id="sheet-dl" style="width:${Math.round(S.dl[key] * 100)}%"></span></div><p class="small muted" id="sheet-dl-text">Downloading…</p></div>` : ""}
        ${!isDl && !busy ? `<p class="small muted" style="margin:0;text-align:center">Downloading lets you listen offline. Use Wi-Fi for big books.</p>` : ""}
        ${p?.pos > 5 ? `<button class="btn btn-ghost" data-act="restart">Start from the beginning</button>` : ""}
        ${p && !p.done ? `<button class="btn btn-ghost" data-act="finish">Mark as finished</button>` : ""}
        ${isDl ? `<button class="btn btn-danger" data-act="remove">Remove from this device</button>` : ""}
      </div>`, (root) => {
      root.querySelectorAll("[data-act]").forEach((btn) => (btn.onclick = () => bookAction(key, btn.dataset.act)));
    });
  }
  async function bookAction(key, act) {
    if (act === "play") { closeSheet(); return openBook(key); }
    if (act === "download") { downloadBook(key); return tapBook(key); }
    if (act === "remove") {
      if (cur?.book.key === key) { audio.pause(); audio.removeAttribute("src"); audio.load(); cur = null; updatePlayerUI(); }
      await removeDownload(key); closeSheet(); renderLibrary(); toast("Removed from this device"); return;
    }
    if (act === "restart" || act === "finish") {
      S.progress[key] = { pos: 0, updated: Date.now(), dur: bookBy(key).info.duration, done: act === "finish" };
      saveProgress();
      if (cur?.book.key === key) audio.currentTime = 0;
      closeSheet(); renderLibrary(); pushSoon(); return;
    }
  }

  // ---------- downloads (stored in the browser's private file storage) ----------
  const fname = (key) => key.replace(/[\\/:*?"<>|]/g, "_") + ".m4b";
  let writeCheck = null;
  function canWriteFiles() {
    return (writeCheck ||= (async () => {
      try {
        if (!navigator.storage?.getDirectory) return false;
        const dir = await navigator.storage.getDirectory();
        const fh = await dir.getFileHandle(".write-test", { create: true });
        if (!fh.createWritable) return false;
        const w = await fh.createWritable(); await w.write(new Uint8Array([1])); await w.close();
        await dir.removeEntry(".write-test");
        return true;
      } catch { return false; }
    })());
  }
  async function downloadBook(key) {
    const b = bookBy(key); if (!b || S.dl[key] !== undefined) return;
    if (!navigator.onLine) return toast("You are offline. Connect to download.");
    if (!tokenValid()) { try { await signIn(); } catch { return toast("Google sign-in did not finish. Try again."); } }
    navigator.storage?.persist?.();
    S.dl[key] = 0; renderGrid();
    try {
      const r = await gfetch(`${API}/files/${b.m4b.id}?alt=media`);
      const total = b.m4b.size || Number(r.headers.get("Content-Length")) || 0;
      let got = 0, lastPaint = 0;
      const onChunk = (n) => {
        got += n;
        if (total && Date.now() - lastPaint > 400) {
          lastPaint = Date.now(); S.dl[key] = got / total;
          const ring = document.querySelector(`.book[data-key="${CSS.escape(key)}"] .ring`);
          if (ring) ring.style.setProperty("--p", Math.round(S.dl[key] * 100));
          if (sheetBook === key && $("sheet-dl")) { $("sheet-dl").style.width = `${Math.round(S.dl[key] * 100)}%`; $("sheet-dl-text").textContent = `Downloading… ${mb(got)} of ${mb(total)}`; }
        }
      };
      const where = (await canWriteFiles()) ? "opfs" : "cache";
      if (where === "opfs") {
        const dir = await navigator.storage.getDirectory();
        const fh = await dir.getFileHandle(fname(key), { create: true });
        const w = await fh.createWritable();
        const reader = r.body.getReader();
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; await w.write(value); onChunk(value.byteLength); }
          await w.close();
        } catch (e) { try { await w.abort(); await dir.removeEntry(fname(key)); } catch { /* ignore */ } throw e; }
      } else {
        // Older browsers: keep the file in the browser's cache storage instead
        const counted = r.body.pipeThrough(new TransformStream({ transform(c, ctl) { onChunk(c.byteLength); ctl.enqueue(c); } }));
        await (await caches.open(BOOKS)).put("books/" + encodeURIComponent(key), new Response(counted, { headers: { "Content-Type": "audio/mp4" } }));
      }
      S.downloaded[key] = { where, size: total, modified: b.m4b.modified };
      store.set("downloaded", S.downloaded);
      delete S.dl[key];
      toast(`"${b.info.title}" is ready to play offline`);
    } catch (e) {
      delete S.dl[key];
      toast(e instanceof AuthError ? "Google sign-in expired. Tap Download again." : "Download stopped. Check your connection and try again.");
    }
    renderLibrary();
    if (sheetBook === key) tapBook(key);
  }
  async function removeDownload(key) {
    const d = S.downloaded[key];
    try {
      if (d?.where === "cache") await (await caches.open(BOOKS)).delete("books/" + encodeURIComponent(key));
      else await (await navigator.storage.getDirectory()).removeEntry(fname(key));
    } catch { /* already gone */ }
    delete S.downloaded[key]; store.set("downloaded", S.downloaded);
  }
  async function localFileUrl(key) {
    const d = S.downloaded[key];
    if (d?.where === "cache") {
      const r = await (await caches.open(BOOKS)).match("books/" + encodeURIComponent(key));
      if (!r) throw new Error("missing");
      return URL.createObjectURL(await r.blob());
    }
    const fh = await (await navigator.storage.getDirectory()).getFileHandle(fname(key));
    return URL.createObjectURL(await fh.getFile());
  }

  // ---------- player ----------
  let cur = null; // { book, url }
  let lastLocalSave = 0, lastPush = 0;
  function setPos(key, pos, extra = {}) {
    const b = bookBy(key);
    S.progress[key] = { ...(S.progress[key] || {}), pos, updated: Date.now(), dur: b?.info.duration || audio.duration || 0, done: false, ...extra };
    saveProgress();
  }
  function once(el, ev) { return new Promise((r) => el.addEventListener(ev, r, { once: true })); }

  async function loadBook(key) {
    const b = bookBy(key);
    if (cur?.book.key === key) return true;
    if (cur) { setPos(cur.book.key, audio.currentTime); URL.revokeObjectURL(cur.url); }
    let url;
    try { url = await localFileUrl(key); }
    catch {
      await removeDownload(key); renderLibrary();
      toast("That download was cleared by your phone. Download it again."); return false;
    }
    cur = { book: b, url };
    audio.src = url;
    S.current = key; store.set("current", key);
    const ok = await Promise.race([
      once(audio, "loadedmetadata").then(() => true),
      once(audio, "error").then(() => false),
      sleep(15000).then(() => false),
    ]);
    if (!ok) {
      URL.revokeObjectURL(url); cur = null; audio.removeAttribute("src");
      toast("This book could not be opened on this device. Try removing and downloading it again.", 5000);
      updatePlayerUI(); return false;
    }
    if (!b.info.duration && audio.duration) { b.info.duration = audio.duration; saveBooks(); }
    const p = S.progress[key];
    audio.currentTime = p && !p.done ? p.pos : 0;
    audio.playbackRate = S.settings.speed;
    setMediaSession();
    updatePlayerUI();
    return true;
  }
  async function openBook(key, { autoplay = true } = {}) {
    closeSheet();
    if (!(await loadBook(key))) return;
    openPlayer();
    if (autoplay) play();
    if (tokenValid()) syncNow({ quiet: true });
  }
  function play() { audio.playbackRate = S.settings.speed; audio.play().catch(() => toast("Tap play to start")); }
  function toggle() { if (!cur) return; audio.paused ? play() : audio.pause(); }
  function seekTo(t) { if (!cur) return; audio.currentTime = Math.max(0, Math.min(t, (audio.duration || 1e9) - 0.5)); updatePlayerUI(); }
  function jumpChapter(dir) {
    if (!cur) return;
    const chs = cur.book.info.chapters || [];
    if (!chs.length) return seekTo(audio.currentTime + dir * SKIP);
    const c = chapterAt(cur.book, audio.currentTime);
    if (dir < 0 && audio.currentTime - c.start > 4) return seekTo(c.start);
    const n = Math.max(0, Math.min(chs.length - 1, c.i + dir));
    seekTo(chs[n].start);
  }
  function openPlayer() { if ($("player").hidden) history.pushState({ o: 1 }, ""); $("player").hidden = false; updatePlayerUI(); }
  function closePlayer() { $("player").hidden = true; renderLibrary(); updatePlayerUI(); }

  async function updatePlayerUI() {
    const has = !!cur;
    $("mini").hidden = !has || !$("player").hidden;
    if (!has) return;
    const b = cur.book, t = audio.currentTime || 0, d = audio.duration || b.info.duration || 0;
    const ch = chapterAt(b, t);
    const start = ch ? ch.start : 0, end = ch ? Math.min(ch.end, d || ch.end) : d;
    const within = Math.max(0, t - start), len = Math.max(1, end - start);
    const rate = S.settings.speed;
    const playing = !audio.paused;
    const url = await coverUrl(b.key);
    // full player
    $("player-title").textContent = b.info.title;
    $("player-author").textContent = authorOf(b);
    $("player-chapter").textContent = ch ? ch.title : "";
    $("player-chapter").hidden = !ch;
    if ($("player-cover").dataset.k !== b.key) {
      $("player-cover").dataset.k = b.key;
      if (url) { $("player-cover").src = url; $("player-bg").style.backgroundImage = `url("${url}")`; }
      else { $("player-cover").removeAttribute("src"); $("player-bg").style.backgroundImage = "none"; }
      $("mini-cover").src = url || "icons/icon-192.png";
    }
    if (!seeking) { const v = Math.round((within / len) * 1000); $("seek").value = v; $("seek").style.setProperty("--fill", v / 10 + "%"); }
    $("t-elapsed").textContent = clock(within);
    $("t-left").textContent = "-" + clock((len - within) / rate);
    $("play").innerHTML = playing ? ICON.pause : ICON.play;
    $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
    $("speed-btn").textContent = `${rate}×`;
    const sl = $("sleep-btn");
    if (S.sleep?.until) { sl.textContent = `Sleep in ${Math.max(1, Math.ceil((S.sleep.until - Date.now()) / 60000))}m`; sl.classList.add("on"); }
    else if (S.sleep?.chapterEnd) { sl.textContent = "Sleep at chapter end"; sl.classList.add("on"); }
    else { sl.textContent = "Sleep timer"; sl.classList.remove("on"); }
    $("book-left").textContent = d ? `${human((d - t) / rate)} left in the book${rate !== 1 ? ` at ${rate}×` : ""}` : "";
    // mini player
    $("mini-title").textContent = b.info.title;
    $("mini-sub").textContent = ch ? ch.title : authorOf(b);
    $("mini-toggle").innerHTML = playing ? ICON.pause : ICON.play;
    $("mini-bar").style.width = d ? `${(t / d) * 100}%` : "0";
  }

  let seeking = false;
  $("seek").addEventListener("input", () => {
    seeking = true;
    const v = Number($("seek").value); $("seek").style.setProperty("--fill", v / 10 + "%");
    if (!cur) return;
    const ch = chapterAt(cur.book, audio.currentTime), d = audio.duration || 0;
    const start = ch ? ch.start : 0, end = ch ? Math.min(ch.end, d || ch.end) : d;
    $("t-elapsed").textContent = clock((v / 1000) * (end - start));
  });
  $("seek").addEventListener("change", () => {
    if (cur) {
      const ch = chapterAt(cur.book, audio.currentTime), d = audio.duration || 0;
      const start = ch ? ch.start : 0, end = ch ? Math.min(ch.end, d || ch.end) : d;
      seekTo(start + (Number($("seek").value) / 1000) * (end - start));
    }
    seeking = false;
  });

  // Audio events
  let lastPaint = 0;
  audio.addEventListener("timeupdate", () => {
    if (!cur) return;
    const now = Date.now();
    if (now - lastPaint > 250) { lastPaint = now; if (!$("player").hidden || !$("mini").hidden) updatePlayerUI(); }
    if (now - lastLocalSave > 5000) { lastLocalSave = now; setPos(cur.book.key, audio.currentTime); }
    if (now - lastPush > 60000 && tokenValid()) { lastPush = now; pushRemote().catch(() => {}); }
    checkSleep();
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && audio.duration) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* ignore */ }
    }
  });
  audio.addEventListener("play", () => { updatePlayerUI(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; });
  audio.addEventListener("pause", () => {
    if (cur) setPos(cur.book.key, audio.currentTime);
    updatePlayerUI(); pushSoon();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  });
  audio.addEventListener("ended", () => {
    if (!cur) return;
    setPos(cur.book.key, 0, { done: true }); pushSoon();
    toast(`You finished "${cur.book.info.title}"`, 4000); updatePlayerUI();
  });

  async function setMediaSession() {
    if (!("mediaSession" in navigator) || !cur) return;
    const url = await coverUrl(cur.book.key);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.book.info.title, artist: authorOf(cur.book), album: "My Book Reader",
      artwork: url ? [{ src: url, sizes: "600x600", type: "image/jpeg" }] : [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    const h = {
      play: () => play(), pause: () => audio.pause(),
      seekbackward: () => seekTo(audio.currentTime - SKIP), seekforward: () => seekTo(audio.currentTime + SKIP),
      previoustrack: () => jumpChapter(-1), nexttrack: () => jumpChapter(1),
      seekto: (e) => seekTo(e.seekTime),
    };
    for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch { /* unsupported */ } }
  }

  // Sleep timer
  function checkSleep() {
    if (!S.sleep || audio.paused || !cur) return;
    let fire = false;
    if (S.sleep.until && Date.now() >= S.sleep.until) fire = true;
    if (S.sleep.chapterEnd !== undefined && audio.currentTime >= S.sleep.chapterEnd - 0.3) fire = true;
    if (fire) {
      S.sleep = null;
      fadeOutAndPause();
    }
  }
  async function fadeOutAndPause() {
    const v0 = audio.volume;
    for (let i = 10; i > 0; i--) { audio.volume = (v0 * i) / 10; await sleep(400); }
    audio.pause(); audio.volume = v0; updatePlayerUI();
  }
  function sleepSheet() {
    const opts = [[15, "15 minutes"], [30, "30 minutes"], [45, "45 minutes"], [60, "1 hour"], ["ch", "End of this chapter"], [0, "Off"]];
    openSheet(`<h3>Sleep timer</h3><p class="sheet-sub">The book fades out and pauses.</p><ul class="list">${opts.map(([v, l]) => `<li><button data-v="${v}"><span class="name">${l}</span></button></li>`).join("")}</ul>`, (root) => {
      root.querySelectorAll("button").forEach((b) => (b.onclick = () => {
        const v = b.dataset.v;
        if (v === "0") S.sleep = null;
        else if (v === "ch") { const c = cur && chapterAt(cur.book, audio.currentTime); S.sleep = c ? { chapterEnd: c.end } : null; }
        else S.sleep = { until: Date.now() + Number(v) * 60000 };
        closeSheet(); updatePlayerUI();
        if (S.sleep) toast(v === "ch" ? "Pausing at the end of this chapter" : `Pausing in ${b.textContent.trim()}`);
      }));
    });
  }
  function speedSheet() {
    openSheet(`<h3>Playback speed</h3><p class="sheet-sub">Applies to every book.</p><div class="choice-row">${SPEEDS.map((s) => `<button class="pill ${s === S.settings.speed ? "on" : ""}" data-s="${s}">${s}×</button>`).join("")}</div>`, (root) => {
      root.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => {
        S.settings.speed = Number(b.dataset.s); store.set("settings", S.settings);
        audio.playbackRate = S.settings.speed; closeSheet(); updatePlayerUI();
      }));
    });
  }
  function chaptersSheet() {
    if (!cur) return;
    const chs = cur.book.info.chapters || [];
    if (!chs.length) return toast("This book has no chapter list");
    const now = chapterAt(cur.book, audio.currentTime);
    openSheet(`<h3>Chapters</h3><p class="sheet-sub">${chs.length} chapters</p><ul class="list">${chs.map((c, i) =>
      `<li><button data-i="${i}" class="${i === now.i ? "current" : ""}"><span class="name">${esc(c.title)}</span><span class="meta">${clock(c.end - c.start)}</span></button></li>`).join("")}</ul>`, (root) => {
      root.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { seekTo(chs[Number(b.dataset.i)].start); closeSheet(); if (audio.paused) play(); }));
      root.querySelector(".current")?.scrollIntoView({ block: "center" });
    });
  }
  async function settingsSheet() {
    let used = "";
    try { const e = await navigator.storage.estimate(); used = `${mb(e.usage)} used on this device`; } catch { /* ignore */ }
    const t = S.settings.theme;
    openSheet(`<h3>Settings</h3>
      <div class="setting"><span>Appearance</span><span class="choice-row">${[["auto", "Auto"], ["dark", "Dark"], ["light", "Light"]].map(([v, l]) => `<button class="pill ${t === v ? "on" : ""}" data-theme="${v}">${l}</button>`).join("")}</span></div>
      <div class="setting"><span>Downloads<br><span class="small muted">${used}</span></span><button class="pill" data-act="sync">Sync now</button></div>
      <div class="setting"><span>Google account<br><span class="small muted">${tokenValid() ? "Connected" : "Not connected right now"}</span></span><button class="pill" data-act="signout">Sign out</button></div>`, (root) => {
      root.querySelectorAll("[data-theme]").forEach((b) => (b.onclick = () => { S.settings.theme = b.dataset.theme; store.set("settings", S.settings); applyTheme(); settingsSheet(); }));
      root.querySelector('[data-act="sync"]').onclick = () => { closeSheet(); manualSync(); };
      root.querySelector('[data-act="signout"]').onclick = () => {
        if (S.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(S.token, () => {});
        S.token = null; store.del("token"); store.del("signedIn"); closeSheet(); showWelcome();
      };
    });
  }

  // ---------- position sync through Drive's private app folder ----------
  async function pullRemote() {
    const f = await listAll("name='progress.json'", "id,modifiedTime", "appDataFolder");
    if (!f.length) { S.remoteId = null; return {}; }
    S.remoteId = f[0].id;
    const j = await (await gfetch(`${API}/files/${S.remoteId}?alt=media`)).json();
    return j.progress || {};
  }
  async function pushRemote() {
    const body = JSON.stringify({ progress: S.progress, savedAt: Date.now(), device: deviceId });
    if (S.remoteId) {
      await gfetch(`${UPLOAD}/files/${S.remoteId}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000 });
    } else {
      const boundary = "mbr" + Math.random().toString(36).slice(2);
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: "progress.json", parents: ["appDataFolder"] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const r = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
      S.remoteId = (await r.json()).id;
    }
  }
  let pushTimer;
  function pushSoon() { clearTimeout(pushTimer); pushTimer = setTimeout(() => { if (tokenValid() && navigator.onLine) pushRemote().catch(() => {}); }, 800); }
  let syncing = false;
  async function syncNow({ quiet = false } = {}) {
    if (syncing) return;
    if (!navigator.onLine) { chip("Offline"); return; }
    if (!tokenValid()) { chip("Tap to sync", true); return; }
    syncing = true;
    if (!quiet) chip("Syncing");
    try {
      const remote = await pullRemote();
      let moved = false;
      for (const [k, r] of Object.entries(remote)) {
        const l = S.progress[k];
        if (!l || (r.updated || 0) > (l.updated || 0)) {
          S.progress[k] = r;
          if (cur?.book.key === k && audio.paused && !r.done && Math.abs(audio.currentTime - r.pos) > 3) { audio.currentTime = r.pos; moved = true; }
        }
      }
      saveProgress();
      if (moved) toast("Picked up where you left off on your other device", 3500);
      await pushRemote();
      chip("Synced", false, true);
      renderContinue(); if ($("player").hidden) renderGrid(); else updatePlayerUI();
    } catch (e) {
      chip(e instanceof AuthError ? "Tap to sync" : "Sync failed", true);
    } finally { syncing = false; }
  }
  async function manualSync() {
    if (!navigator.onLine) return toast("You are offline. Your place is saved on this device.");
    if (!tokenValid()) { try { await signIn(); } catch { return toast("Google sign-in did not finish."); } }
    try { await refreshLibrary(); } catch (e) { toast(e instanceof AuthError ? "Please sign in again." : "Could not reach Google Drive."); }
    await syncNow();
  }
  $("sync-status").onclick = () => { if ($("sync-status").classList.contains("warn")) manualSync(); };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (cur) setPos(cur.book.key, audio.currentTime); if (tokenValid() && navigator.onLine) pushRemote().catch(() => {}); }
    else if (store.get("signedIn")) syncNow({ quiet: true });
  });
  addEventListener("online", () => syncNow({ quiet: true }));
  addEventListener("offline", () => chip("Offline"));
  addEventListener("pagehide", () => { if (cur) setPos(cur.book.key, audio.currentTime); });

  // ---------- wiring ----------
  $("play").onclick = toggle;
  $("back").onclick = () => seekTo(audio.currentTime - SKIP);
  $("fwd").onclick = () => seekTo(audio.currentTime + SKIP);
  $("prev-ch").onclick = () => jumpChapter(-1);
  $("next-ch").onclick = () => jumpChapter(1);
  $("speed-btn").onclick = speedSheet;
  $("sleep-btn").onclick = sleepSheet;
  $("chapters-btn").onclick = chaptersSheet;
  $("player-close").onclick = closePlayer;
  $("mini").onclick = (e) => { if (e.target.closest("#mini-toggle")) { e.stopPropagation(); toggle(); } else openPlayer(); };
  $("refresh").onclick = manualSync;
  $("settings-btn").onclick = settingsSheet;
  document.querySelectorAll(".filter").forEach((f) => (f.onclick = () => {
    document.querySelectorAll(".filter").forEach((x) => x.classList.toggle("active", x === f));
    S.filter = f.dataset.filter; renderGrid();
  }));
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input")) return;
    if (e.key === "Escape") { if (!$("sheet").hidden) closeSheet(); else if (!$("player").hidden) closePlayer(); }
    if (e.code === "Space" && cur) { e.preventDefault(); toggle(); }
    if (e.key === "ArrowLeft" && cur) seekTo(audio.currentTime - SKIP);
    if (e.key === "ArrowRight" && cur) seekTo(audio.currentTime + SKIP);
  });
  // The phone's back button closes the sheet or the player instead of leaving the app
  addEventListener("popstate", (e) => {
    if (!$("sheet").hidden) closeSheet();
    else if (!$("player").hidden) closePlayer();
    else if (e.state?.o) history.back();
  });

  // ---------- start ----------
  function showWelcome() {
    $("welcome").hidden = false; $("library").hidden = true; $("mini").hidden = true;
    if (!CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_CLIENT_ID.includes("PASTE")) $("welcome-note").textContent = "Setup is not finished: the Google Client ID still needs to go into config.js.";
  }
  async function showLibrary() {
    $("welcome").hidden = true; $("library").hidden = false;
    renderLibrary();
    if (S.current && S.downloaded[S.current] && bookBy(S.current)) { await loadBook(S.current); }
  }
  $("signin").onclick = async () => {
    $("welcome-note").textContent = "";
    try {
      await signIn();
      await showLibrary();
      await refreshLibrary();
      await syncNow();
    } catch (e) {
      $("welcome-note").textContent = e instanceof AuthError ? "Sign-in was cancelled. Tap the button to try again." : (e.message || "Something went wrong.");
    }
  };

  async function start() {
    applyTheme();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    if (!store.get("signedIn")) return showWelcome();
    await showLibrary();
    if (!navigator.onLine) return chip("Offline");
    try { await initAuth(); } catch { /* offline or blocked: library still works from this device */ }
    if (tokenValid()) {
      try { await refreshLibrary(); } catch (e) { if (e instanceof AuthError) chip("Tap to sync", true); }
      syncNow({ quiet: true });
    } else chip("Tap to sync", true);
  }
  start();

  // Exposed for testing only
  window.__mbr = { S, syncNow, refreshLibrary, audio };
})();
