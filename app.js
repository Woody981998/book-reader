/* My Book Reader: plays your converted audiobooks from Google Drive. It keeps the next few hours
   saved on the device for offline listening, clears what you have heard, and keeps your place in
   sync between devices through a small file in your Drive's private app folder. */
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
  const mb = (bytes) => !bytes ? "" : bytes < 1048576 ? "under 1 MB" : `${Math.round(bytes / 1048576)} MB`;
  const hoursText = (h, sentence) => sentence ? (h === 1 ? "The next hour is" : `The next ${h} hours are`) : (h === 1 ? "the next hour" : `the next ${h} hours`);
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
    local: store.get("local", {}),       // book key -> { chapter file -> bytes } saved on this device
    pinned: store.get("pinned", {}),     // books saved whole for a trip
    settings: Object.assign({ speed: 1, theme: "auto", ahead: 3 }, store.get("settings", {})),
    current: store.get("current", null),
    filter: "all",
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
  // Each book is a folder inside Audiobooks/Ready with book.json, cover.jpg and one small file per chapter.
  const COVERS = "mbr-covers", CHAPTER_CACHE = "mbr-chapters";
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
    const folders = (await listAll(`'${ready.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, "id,name"))
      .filter((f) => !f.name.endsWith("(saving)"));
    const children = {};
    for (let i = 0; i < folders.length; i += 25) {
      const part = folders.slice(i, i + 25);
      const files = await listAll(`(${part.map((f) => `'${f.id}' in parents`).join(" or ")}) and trashed=false`, "id,name,size,modifiedTime,parents");
      for (const f of files) (children[f.parents[0]] ||= {})[f.name] = f;
    }
    const books = [];
    for (const folder of folders) {
      const kids = children[folder.id] || {};
      const json = kids["book.json"];
      if (!json) continue;
      const key = folder.name, old = bookBy(key) || {};
      let info = old.info && old.infoMod === json.modifiedTime ? old.info : null;
      if (!info) { try { info = await (await gfetch(`${API}/files/${json.id}?alt=media`)).json(); } catch { continue; } }
      const jpg = info.cover && kids[info.cover];
      if (jpg && old.coverMod !== jpg.modifiedTime) {
        try {
          const blob = await (await gfetch(`${API}/files/${jpg.id}?alt=media`)).blob();
          await (await caches.open(COVERS)).put("covers/" + encodeURIComponent(key), new Response(blob, { headers: { "Content-Type": "image/jpeg" } }));
          if (coverUrls[key]) URL.revokeObjectURL(coverUrls[key]);
          delete coverUrls[key];
        } catch { /* cover is optional */ }
      }
      const files = {};
      for (const c of info.chapters || []) if (kids[c.file]) files[c.file] = { id: kids[c.file].id, size: Number(kids[c.file].size || c.size || 0) };
      books.push({ key, info, infoMod: json.modifiedTime, coverMod: jpg?.modifiedTime || old.coverMod || null, files });
    }
    books.sort((a, b) => a.info.title.localeCompare(b.info.title));
    S.books = books; saveBooks();
    renderLibrary();
    chip("");
    keepAhead();
  }
  const authorOf = (b) => (b.info.author && b.info.author !== "Unknown" ? b.info.author : "");
  const bookSize = (b) => (b.info.chapters || []).reduce((n, c) => n + (b.files[c.file]?.size || c.size || 0), 0);

  // ---------- chapters stored on this device ----------
  const dirName = (key) => key.replace(/[\\/:*?"<>|]/g, "_");
  const isLocal = (key, file) => !!S.local[key]?.[file];
  const saveLocalIndex = () => store.set("local", S.local);
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
  async function writeLocal(key, file, blob) {
    if (await canWriteFiles()) {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName(key), { create: true });
      const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
      await w.write(blob); await w.close();
    } else {
      await (await caches.open(CHAPTER_CACHE)).put(`ch/${encodeURIComponent(key)}/${file}`, new Response(blob, { headers: { "Content-Type": "audio/webm" } }));
    }
    (S.local[key] ||= {})[file] = blob.size; saveLocalIndex();
  }
  async function readLocal(key, file) {
    if (await canWriteFiles()) {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName(key));
      return (await dir.getFileHandle(file)).getFile();
    }
    const r = await (await caches.open(CHAPTER_CACHE)).match(`ch/${encodeURIComponent(key)}/${file}`);
    if (!r) throw new Error("missing");
    return r.blob();
  }
  async function deleteLocal(key, file) {
    try {
      if (await canWriteFiles()) await (await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName(key))).removeEntry(file);
      else await (await caches.open(CHAPTER_CACHE)).delete(`ch/${encodeURIComponent(key)}/${file}`);
    } catch { /* already gone */ }
    if (S.local[key]) { delete S.local[key][file]; if (!Object.keys(S.local[key]).length) delete S.local[key]; saveLocalIndex(); }
  }
  async function removeBookLocal(key) {
    for (const f of Object.keys(S.local[key] || {})) await deleteLocal(key, f);
    try { if (await canWriteFiles()) await (await navigator.storage.getDirectory()).removeEntry(dirName(key), { recursive: true }); } catch { /* ignore */ }
    delete S.local[key]; delete S.pinned[key]; saveLocalIndex(); store.set("pinned", S.pinned);
  }
  const inflight = {};
  function fetchChapter(book, i) {
    const c = book.info.chapters[i], id = book.files[c.file]?.id, k = book.key + "/" + c.file;
    if (isLocal(book.key, c.file)) return Promise.resolve();
    if (!id) return Promise.reject(new Error("missing on Drive"));
    return (inflight[k] ||= (async () => {
      try {
        const blob = await (await gfetch(`${API}/files/${id}?alt=media`)).blob();
        await writeLocal(book.key, c.file, blob);
      } finally { delete inflight[k]; }
    })());
  }
  const localBytes = (key) => Object.values(S.local[key] || {}).reduce((a, b) => a + b, 0);
  function aheadSeconds(book, fromTime) {
    // How much listening is saved on this device from fromTime onward, without gaps
    const chs = book.info.chapters || []; let i = chapterIndex(book, fromTime), secs = 0;
    for (; i < chs.length && isLocal(book.key, chs[i].file); i++) secs += chs[i].end - Math.max(chs[i].start, fromTime);
    return secs;
  }

  // Keep the next few hours of the current book on the device and clear what you've already heard.
  let keeping = false, keepAgain = false;
  async function keepAhead() {
    if (keeping) { keepAgain = true; return; }
    keeping = true;
    try {
      do {
        keepAgain = false;
        if (navigator.onLine && tokenValid()) navigator.storage?.persist?.();
        const want = (S.settings.ahead || 3) * 3600;
        // what each book should keep
        const keep = {};
        for (const b of S.books) {
          const chs = b.info.chapters || []; if (!chs.length) continue;
          const pos = b.key === cur?.book.key ? bookTime() : (S.progress[b.key]?.pos || 0);
          const first = chapterIndex(b, pos), set = new Set();
          if (S.pinned[b.key]) chs.forEach((c) => set.add(c.file));
          else if (b.key === S.current) {
            if (first > 0) set.add(chs[first - 1].file); // the chapter before, for rewinding
            let secs = 0;
            for (let i = first; i < chs.length && (secs < want || i === first); i++) { set.add(chs[i].file); secs += chs[i].end - chs[i].start; }
          } else if (S.progress[b.key] && !S.progress[b.key].done) set.add(chs[first].file); // enough to resume offline
          keep[b.key] = set;
        }
        // clear what isn't needed (also books that are no longer in Drive)
        for (const key of Object.keys(S.local)) {
          for (const f of Object.keys(S.local[key])) if (!keep[key]?.has(f)) await deleteLocal(key, f);
        }
        // fetch what's missing, in listening order
        if (navigator.onLine && tokenValid()) {
          const order = [];
          const curBook = bookBy(S.current);
          if (curBook && keep[curBook.key]) (curBook.info.chapters || []).forEach((c, i) => keep[curBook.key].has(c.file) && order.push([curBook, i]));
          for (const b of S.books) if (b !== curBook && keep[b.key]) (b.info.chapters || []).forEach((c, i) => keep[b.key].has(c.file) && order.push([b, i]));
          for (const [b, i] of order) {
            if (!navigator.onLine || !tokenValid() || keepAgain) break;
            if (isLocal(b.key, b.info.chapters[i].file)) continue;
            try { await fetchChapter(b, i); } catch (e) { if (e instanceof AuthError) { chip("Tap to sync", true); break; } }
            paintOffline();
          }
        }
        paintOffline();
      } while (keepAgain);
    } finally { keeping = false; }
  }
  function paintOffline() {
    if (!$("player").hidden) updatePlayerUI();
    const el = document.querySelector(".continue-offline");
    if (el) { const b = bookBy(el.dataset.key); if (b) el.textContent = offlineLabel(b); }
    document.querySelectorAll(".book[data-key]").forEach((n) => {
      const b = bookBy(n.dataset.key); const badge = n.querySelector(".book-badge");
      const full = b && S.pinned[b.key] && (b.info.chapters || []).every((c) => isLocal(b.key, c.file));
      if (badge) badge.hidden = !full;
    });
  }
  function offlineLabel(b) {
    const pos = b.key === cur?.book.key ? bookTime() : (S.progress[b.key]?.pos || 0);
    const a = aheadSeconds(b, pos);
    return a > 60 ? `${human(a)} saved for offline` : navigator.onLine ? "Plays online" : "Not saved for offline";
  }

  // ---------- rendering ----------
  function pct(key) {
    const b = bookBy(key), p = S.progress[key];
    const d = b?.info.duration || p?.dur || 0;
    if (!p || !d) return 0;
    return p.done ? 100 : Math.min(100, Math.round((p.pos / d) * 100));
  }
  function chapterIndex(book, t) {
    const ch = book?.info.chapters || [];
    let i = 0;
    for (let j = 0; j < ch.length; j++) if (ch[j].start <= t + 0.25) i = j;
    return i;
  }
  function chapterAt(book, t) {
    const ch = book?.info.chapters || [];
    if (!ch.length) return null;
    const i = chapterIndex(book, t);
    return { i, ...ch[i] };
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
    const pos = key === cur?.book.key ? bookTime() : p.pos;
    const ch = chapterAt(b, pos);
    const left = (b.info.duration || 0) - pos;
    el.hidden = false;
    el.innerHTML = `<h2 class="section-title" style="margin-bottom:12px">Continue listening</h2>
      <button class="continue-card" data-key="${esc(key)}">
        ${url ? `<img src="${url}" alt="">` : `<div class="placeholder-cover" style="width:80px;height:120px;border-radius:10px"><b style="font-size:12px">${esc(b.info.title)}</b></div>`}
        <span>
          <p class="continue-title">${esc(b.info.title)}</p>
          <p class="continue-ch">${esc(ch ? ch.title : authorOf(b))}${b.info.duration ? ` · ${human(left)} left` : ""}</p>
          <span class="continue-row"><span class="resume">${ICON.play}${pos > 5 ? "Resume" : "Play"}</span><span class="bar"><span style="width:${pct(key)}%"></span></span></span>
          <p class="continue-offline small muted" data-key="${esc(key)}">${esc(offlineLabel(b))}</p>
        </span>
      </button>`;
    el.querySelector(".continue-card").onclick = () => openBook(key);
  }
  async function renderGrid(emptyMsg) {
    const grid = $("grid"), empty = $("empty");
    let list = S.books;
    if (S.filter === "downloaded") list = list.filter((b) => Object.keys(S.local[b.key] || {}).length);
    if (!list.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = emptyMsg || (S.filter === "downloaded"
        ? "Nothing is saved on this device yet. Start a book and the next few hours are saved automatically."
        : "No books yet. Audiobooks you convert into Google Drive, in Audiobooks › Ready, will show up here.");
      return;
    }
    empty.hidden = true;
    const html = await Promise.all(list.map(async (b) => {
      const url = await coverUrl(b.key), p = pct(b.key);
      const full = S.pinned[b.key] && (b.info.chapters || []).every((c) => isLocal(b.key, c.file));
      return `<button class="book" data-key="${esc(b.key)}">
        <span class="book-cover">${coverHtml(b, url)}<span class="book-badge" title="Whole book on this device" ${full ? "" : "hidden"}>${ICON.check}</span></span>
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

  async function tapBook(key) {
    if (S.current === key && cur) return openBook(key);
    const b = bookBy(key); if (!b) return;
    sheetBook = key;
    const url = await coverUrl(key), p = S.progress[key];
    const size = bookSize(b), have = localBytes(key);
    const info = [authorOf(b), b.info.duration ? human(b.info.duration) : "", b.info.chapters?.length ? `${b.info.chapters.length} chapters` : ""].filter(Boolean).join(" · ");
    openSheet(`
      <div class="sheet-book">${coverHtml(b, url)}<div><h3>${esc(b.info.title)}</h3><p class="sheet-sub" style="margin:0">${esc(info)}</p></div></div>
      <div class="sheet-actions">
        <button class="btn btn-primary" data-act="play">${p?.pos > 5 && !p.done ? "Resume" : "Play"}</button>
        <p class="small muted" style="margin:0;text-align:center">${hoursText(S.settings.ahead, true)} saved on this device automatically while you listen.</p>
        ${S.pinned[key]
          ? `<button class="btn btn-ghost" data-act="unpin">Only keep ${hoursText(S.settings.ahead)} on this device</button>`
          : `<button class="btn btn-ghost" data-act="pin">Save the whole book for a trip${size ? ` (${mb(size)})` : ""}</button>`}
        ${p?.pos > 5 ? `<button class="btn btn-ghost" data-act="restart">Start from the beginning</button>` : ""}
        ${p && !p.done ? `<button class="btn btn-ghost" data-act="finish">Mark as finished</button>` : ""}
        ${have ? `<button class="btn btn-danger" data-act="remove">Remove from this device (${mb(have)})</button>` : ""}
      </div>`, (root) => {
      root.querySelectorAll("[data-act]").forEach((btn) => (btn.onclick = () => bookAction(key, btn.dataset.act)));
    });
  }
  async function bookAction(key, act) {
    if (act === "play") { closeSheet(); return openBook(key); }
    if (act === "pin") {
      if (!navigator.onLine) return toast("Connect to the internet to save the whole book.");
      if (!tokenValid()) { try { await signIn(); } catch { return toast("Google sign-in did not finish. Try again."); } }
      S.pinned[key] = true; store.set("pinned", S.pinned); closeSheet();
      toast("Saving the whole book in the background"); keepAhead(); return;
    }
    if (act === "unpin") { delete S.pinned[key]; store.set("pinned", S.pinned); closeSheet(); keepAhead(); toast("Keeping only the next few hours"); return; }
    if (act === "remove") {
      if (cur?.book.key === key) { audio.pause(); audio.removeAttribute("src"); audio.load(); cur = null; updatePlayerUI(); }
      if (S.current === key) { S.current = null; store.set("current", null); }
      await removeBookLocal(key); closeSheet(); renderLibrary(); toast("Removed from this device"); return;
    }
    if (act === "restart" || act === "finish") {
      S.progress[key] = { pos: 0, updated: Date.now(), dur: bookBy(key).info.duration, done: act === "finish" };
      saveProgress();
      if (cur?.book.key === key) seekBook(0);
      closeSheet(); renderLibrary(); pushSoon(); keepAhead(); return;
    }
  }

  // ---------- player (one small file per chapter) ----------
  let cur = null; // { book, i, url }
  let lastLocalSave = 0, lastPush = 0;
  const bookTime = () => (cur ? (cur.book.info.chapters[cur.i]?.start || 0) + (audio.currentTime || 0) : 0);
  function setPos(key, pos, extra = {}) {
    const b = bookBy(key);
    S.progress[key] = { ...(S.progress[key] || {}), pos, updated: Date.now(), dur: b?.info.duration || 0, done: false, ...extra };
    saveProgress();
  }
  function once(el, ev) { return new Promise((r) => el.addEventListener(ev, r, { once: true })); }

  // Loads chapter i of a book and moves to `offset` seconds into it.
  async function loadChapter(book, i, offset, autoplay) {
    const c = book.info.chapters[i];
    if (!c) return false;
    if (!isLocal(book.key, c.file)) {
      if (!navigator.onLine) { toast("This part isn't saved on this device. Connect to the internet to play it.", 4500); return false; }
      if (!tokenValid()) { chip("Tap to sync", true); toast("Tap \"Tap to sync\" at the top to reconnect Google, then press play.", 4500); return false; }
      $("player-chapter").textContent = "Loading…";
      try { await fetchChapter(book, i); } catch { toast("Could not load this chapter. Check your connection.", 4000); return false; }
    }
    let blob;
    try { blob = await readLocal(book.key, c.file); }
    catch { await deleteLocal(book.key, c.file); return loadChapter(book, i, offset, autoplay); }
    const url = URL.createObjectURL(blob);
    if (cur?.url) URL.revokeObjectURL(cur.url);
    cur = { book, i, url };
    audio.src = url;
    const ok = await Promise.race([once(audio, "loadedmetadata").then(() => true), once(audio, "error").then(() => false), sleep(15000).then(() => false)]);
    if (!ok) { toast("This chapter could not be opened on this device.", 4000); return false; }
    audio.currentTime = Math.max(0, Math.min(offset, (audio.duration || c.end - c.start) - 0.3));
    audio.playbackRate = S.settings.speed;
    setMediaSession(); updatePlayerUI();
    if (autoplay) play();
    keepAhead();
    return true;
  }
  async function loadBook(key, autoplay) {
    const b = bookBy(key);
    if (!b || !(b.info.chapters || []).length) return false;
    if (cur?.book.key === key) { if (autoplay && audio.paused) play(); return true; }
    if (cur) { setPos(cur.book.key, bookTime()); audio.pause(); }
    const p = S.progress[key], pos = p && !p.done ? p.pos : 0;
    S.current = key; store.set("current", key);
    const i = chapterIndex(b, pos);
    return loadChapter(b, i, pos - b.info.chapters[i].start, autoplay);
  }
  async function openBook(key, { autoplay = true } = {}) {
    closeSheet();
    openPlayerShell(key);
    if (!(await loadBook(key, autoplay))) { updatePlayerUI(); return; }
    if (tokenValid()) syncNow({ quiet: true });
  }
  function play() { audio.playbackRate = S.settings.speed; audio.play().catch(() => toast("Tap play to start")); }
  function toggle() { if (!cur) return; audio.paused ? play() : audio.pause(); }
  async function seekBook(t) {
    if (!cur) return;
    const b = cur.book, d = b.info.duration || 0;
    t = Math.max(0, Math.min(t, d - 0.5));
    const i = chapterIndex(b, t), c = b.info.chapters[i];
    if (i === cur.i) { audio.currentTime = t - c.start; updatePlayerUI(); return; }
    const wasPlaying = !audio.paused;
    setPos(b.key, t);
    await loadChapter(b, i, t - c.start, wasPlaying);
  }
  function jumpChapter(dir) {
    if (!cur) return;
    const chs = cur.book.info.chapters;
    if (dir < 0 && audio.currentTime > 4) return seekBook(chs[cur.i].start);
    const n = Math.max(0, Math.min(chs.length - 1, cur.i + dir));
    seekBook(chs[n].start + 0.01);
  }
  function openPlayerShell(key) {
    if ($("player").hidden) history.pushState({ o: 1 }, "");
    $("player").hidden = false;
    if (!cur || cur.book.key !== key) {
      const b = bookBy(key);
      $("player-title").textContent = b?.info.title || "";
      $("player-author").textContent = b ? authorOf(b) : "";
      $("player-chapter").textContent = "Loading…";
      coverUrl(key).then((u) => { $("player-cover").dataset.k = key; if (u) { $("player-cover").src = u; $("player-bg").style.backgroundImage = `url("${u}")`; } });
    }
    updatePlayerUI();
  }
  function openPlayer() { if (cur) openPlayerShell(cur.book.key); }
  function closePlayer() { $("player").hidden = true; renderLibrary(); updatePlayerUI(); }

  async function updatePlayerUI() {
    const has = !!cur;
    $("mini").hidden = !has || !$("player").hidden;
    if (!has) return;
    const b = cur.book, c = b.info.chapters[cur.i], t = bookTime(), d = b.info.duration || 0;
    const within = audio.currentTime || 0, len = Math.max(1, audio.duration || (c.end - c.start));
    const rate = S.settings.speed;
    const playing = !audio.paused;
    const url = await coverUrl(b.key);
    $("player-title").textContent = b.info.title;
    $("player-author").textContent = authorOf(b);
    $("player-chapter").textContent = c.title;
    $("player-chapter").hidden = false;
    if ($("player-cover").dataset.k !== b.key || ($("mini-cover").dataset.k !== b.key)) {
      $("player-cover").dataset.k = b.key; $("mini-cover").dataset.k = b.key;
      if (url) { $("player-cover").src = url; $("player-bg").style.backgroundImage = `url("${url}")`; }
      else { $("player-cover").removeAttribute("src"); $("player-bg").style.backgroundImage = "none"; }
      $("mini-cover").src = url || "icon-192.png";
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
    const ahead = aheadSeconds(b, t);
    $("book-left").textContent = (d ? `${human((d - t) / rate)} left in the book${rate !== 1 ? ` at ${rate}×` : ""}` : "") +
      (ahead > 60 ? ` · ${human(ahead)} saved for offline` : "");
    $("mini-title").textContent = b.info.title;
    $("mini-sub").textContent = c.title;
    $("mini-toggle").innerHTML = playing ? ICON.pause : ICON.play;
    $("mini-bar").style.width = d ? `${(t / d) * 100}%` : "0";
  }

  let seeking = false;
  $("seek").addEventListener("input", () => {
    seeking = true;
    const v = Number($("seek").value); $("seek").style.setProperty("--fill", v / 10 + "%");
    if (!cur) return;
    $("t-elapsed").textContent = clock((v / 1000) * (audio.duration || 0));
  });
  $("seek").addEventListener("change", () => {
    if (cur && audio.duration) { audio.currentTime = (Number($("seek").value) / 1000) * audio.duration; updatePlayerUI(); }
    seeking = false;
  });

  // Audio events
  let lastPaint = 0;
  audio.addEventListener("timeupdate", () => {
    if (!cur) return;
    const now = Date.now();
    if (now - lastPaint > 250) { lastPaint = now; if (!$("player").hidden || !$("mini").hidden) updatePlayerUI(); }
    if (now - lastLocalSave > 5000) { lastLocalSave = now; setPos(cur.book.key, bookTime()); }
    if (now - lastPush > 60000 && tokenValid()) { lastPush = now; pushRemote().catch(() => {}); }
    checkSleep();
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && audio.duration) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* ignore */ }
    }
  });
  audio.addEventListener("play", () => { updatePlayerUI(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; });
  audio.addEventListener("pause", () => {
    if (cur) setPos(cur.book.key, bookTime());
    updatePlayerUI(); pushSoon();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  });
  audio.addEventListener("ended", async () => {
    if (!cur) return;
    const b = cur.book, next = cur.i + 1;
    if (S.sleep?.chapterEnd) { S.sleep = null; setPos(b.key, b.info.chapters[Math.min(next, b.info.chapters.length - 1)].start); updatePlayerUI(); return; }
    if (next < b.info.chapters.length) {
      setPos(b.key, b.info.chapters[next].start);
      const ok = await loadChapter(b, next, 0, true);
      if (!ok) updatePlayerUI();
      return;
    }
    setPos(b.key, 0, { done: true }); pushSoon();
    toast(`You finished "${b.info.title}"`, 4000); updatePlayerUI();
  });

  async function setMediaSession() {
    if (!("mediaSession" in navigator) || !cur) return;
    const url = await coverUrl(cur.book.key);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.book.info.chapters[cur.i].title, artist: authorOf(cur.book), album: cur.book.info.title,
      artwork: url ? [{ src: url, sizes: "600x900", type: "image/jpeg" }] : [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
    });
    const h = {
      play: () => play(), pause: () => audio.pause(),
      seekbackward: () => seekBook(bookTime() - SKIP), seekforward: () => seekBook(bookTime() + SKIP),
      previoustrack: () => jumpChapter(-1), nexttrack: () => jumpChapter(1),
      seekto: (e) => { audio.currentTime = e.seekTime; updatePlayerUI(); },
    };
    for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch { /* unsupported */ } }
  }

  // Sleep timer
  function checkSleep() {
    if (!S.sleep?.until || audio.paused || !cur) return;
    if (Date.now() >= S.sleep.until) { S.sleep = null; fadeOutAndPause(); }
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
        else if (v === "ch") S.sleep = cur ? { chapterEnd: true } : null;
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
    const chs = cur.book.info.chapters;
    openSheet(`<h3>Chapters</h3><p class="sheet-sub">${chs.length} chapters</p><ul class="list">${chs.map((c, i) =>
      `<li><button data-i="${i}" class="${i === cur.i ? "current" : ""}"><span class="name">${esc(c.title)}</span><span class="meta">${clock(c.end - c.start)}</span></button></li>`).join("")}</ul>`, (root) => {
      root.querySelectorAll("[data-i]").forEach((b) => (b.onclick = async () => { closeSheet(); await seekBook(chs[Number(b.dataset.i)].start + 0.01); if (audio.paused) play(); }));
      root.querySelector(".current")?.scrollIntoView({ block: "center" });
    });
  }
  async function settingsSheet() {
    const used = Object.keys(S.local).reduce((n, k) => n + localBytes(k), 0);
    const t = S.settings.theme, a = S.settings.ahead;
    openSheet(`<h3>Settings</h3>
      <div class="setting"><span>Appearance</span><span class="choice-row">${[["auto", "Auto"], ["dark", "Dark"], ["light", "Light"]].map(([v, l]) => `<button class="pill ${t === v ? "on" : ""}" data-theme="${v}">${l}</button>`).join("")}</span></div>
      <div class="setting" style="flex-wrap:wrap"><span>Keep saved for offline<br><span class="small muted">About 11 MB per hour</span></span><span class="choice-row">${[1, 3, 6, 12].map((h) => `<button class="pill ${a === h ? "on" : ""}" data-ahead="${h}">${h}h</button>`).join("")}</span></div>
      <div class="setting"><span>On this device<br><span class="small muted">${used ? mb(used) || "Under 1 MB" : "Nothing saved yet"}</span></span><button class="pill" data-act="sync">Sync now</button></div>
      <div class="setting"><span>Google account<br><span class="small muted">${tokenValid() ? "Connected" : "Not connected right now"}</span></span><button class="pill" data-act="signout">Sign out</button></div>`, (root) => {
      root.querySelectorAll("[data-theme]").forEach((b) => (b.onclick = () => { S.settings.theme = b.dataset.theme; store.set("settings", S.settings); applyTheme(); settingsSheet(); }));
      root.querySelectorAll("[data-ahead]").forEach((b) => (b.onclick = () => { S.settings.ahead = Number(b.dataset.ahead); store.set("settings", S.settings); keepAhead(); settingsSheet(); }));
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
          if (cur?.book.key === k && audio.paused && !r.done && Math.abs(bookTime() - r.pos) > 3) { seekBook(r.pos); moved = true; }
        }
      }
      saveProgress();
      if (moved) toast("Picked up where you left off on your other device", 3500);
      await pushRemote();
      chip("Synced", false, true);
      renderContinue(); if ($("player").hidden) renderGrid(); else updatePlayerUI();
      keepAhead();
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
    if (document.hidden) { if (cur) setPos(cur.book.key, bookTime()); if (tokenValid() && navigator.onLine) pushRemote().catch(() => {}); }
    else if (store.get("signedIn")) syncNow({ quiet: true });
  });
  addEventListener("online", () => syncNow({ quiet: true }));
  addEventListener("offline", () => chip("Offline"));
  addEventListener("pagehide", () => { if (cur) setPos(cur.book.key, bookTime()); });


  // ---------- wiring ----------
  $("play").onclick = toggle;
  $("back").onclick = () => seekBook(bookTime() - SKIP);
  $("fwd").onclick = () => seekBook(bookTime() + SKIP);
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
    if (e.key === "ArrowLeft" && cur) seekBook(bookTime() - SKIP);
    if (e.key === "ArrowRight" && cur) seekBook(bookTime() + SKIP);
  });
  // The phone's back button closes the sheet or the player instead of leaving the app
  addEventListener("popstate", (e) => {
    if (!$("sheet").hidden) closeSheet();
    else if (!$("player").hidden) closePlayer();
    else if (e.state?.o) history.back();
  });
  addEventListener("online", () => keepAhead());

  // ---------- start ----------
  function showWelcome() {
    $("welcome").hidden = false; $("library").hidden = true; $("mini").hidden = true;
    if (!CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_CLIENT_ID.includes("PASTE")) $("welcome-note").textContent = "Setup is not finished: the Google Client ID still needs to go into config.js.";
  }
  async function cleanOldDownloads() {
    // Earlier versions saved whole books as single .m4b files. Remove them to free space.
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name, h] of root.entries()) if (h.kind === "file" && name.endsWith(".m4b")) await root.removeEntry(name);
    } catch { /* nothing to clean */ }
    store.del("downloaded");
  }
  async function showLibrary() {
    $("welcome").hidden = true; $("library").hidden = false;
    renderLibrary();
    const b = bookBy(S.current);
    if (b && (b.info.chapters || []).length) {
      const pos = S.progress[b.key]?.done ? 0 : (S.progress[b.key]?.pos || 0), i = chapterIndex(b, pos);
      if (isLocal(b.key, b.info.chapters[i].file)) await loadChapter(b, i, pos - b.info.chapters[i].start, false);
    }
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
    if (store.get("downloaded")) cleanOldDownloads();
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
  window.__mbr = { S, syncNow, refreshLibrary, keepAhead, audio, bookTime: () => bookTime(), cur: () => cur };
})();
