import React, { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { motion } from "framer-motion";
import { Search, Star, Play, X, Tv2, Settings, ChevronLeft, ChevronRight, Info, Gamepad2, Sun, Moon, CalendarClock } from "lucide-react";

/**
 * NetIPTV – Netflix‑style IPTV Player (Windows 11 ready)
 * ------------------------------------------------------
 * ✅ Spelar M3U/M3U8 (URL eller fil) med hls.js
 * ✅ EPG (XMLTV) – URL eller fil, visar "Nu/Nästa" och programguide
 * ✅ Gamepad/fjärr – D‑pad/axlar navigerar rader/kort, A=Spela, B=Stäng
 * ✅ Tema‑växling – Mörkt/Ljust (sparas i localStorage)
 * ✅ Favoriter + senast spelad (localStorage)
 * ✅ Electron‑guide för Windows 11 .exe (längst ned)
 *
 * OBS: Vissa strömmar kan kräva Electron p.g.a. CORS. DRM stöds ej.
 */

// --- Tiny UI primitives (så vi slipper externa UI-paket här) ---
function UIButton({ className = "", ...props }) {
  return <button {...props} className={("inline-flex items-center justify-center rounded-xl px-3 py-2 border text-sm transition hover:opacity-90 " + className).trim()} />;
}
function UICard({ className = "", children }) {
  return <div className={("rounded-2xl border overflow-hidden " + className).trim()}>{children}</div>;
}
function UICardContent({ className = "", children }) {
  return <div className={("p-0 " + className).trim()}>{children}</div>;
}

// ------------------------ M3U Parser ------------------------
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let currentMeta = null;
  const parseAttrs = (s) => {
    const attrs = {};
    const attrRegex = /(\w[\w-]*)\s*=\s*"([^"]*)"/g; // tvg-id=".." tvg-logo=".." group-title=".."
    let m; while ((m = attrRegex.exec(s))) attrs[m[1]] = m[2];
    return attrs;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const metaPart = line.substring(line.indexOf(":") + 1);
      const lastComma = metaPart.lastIndexOf(",");
      const attrsPart = lastComma !== -1 ? metaPart.substring(0, lastComma) : metaPart;
      const titlePart = lastComma !== -1 ? metaPart.substring(lastComma + 1).trim() : "";
      const attrs = parseAttrs(attrsPart);
      currentMeta = {
        title: titlePart || attrs["tvg-name"] || "Unknown",
        group: attrs["group-title"] || "Other",
        logo: attrs["tvg-logo"] || "",
        tvgId: attrs["tvg-id"] || "",
        chno: attrs["tvg-chno"] || "",
        rawAttrs: attrs,
      };
    } else if (currentMeta && !line.startsWith("#")) {
      channels.push({ ...currentMeta, url: line });
      currentMeta = null;
    }
  }
  return channels;
}

// ------------------------ XMLTV (EPG) Parser ------------------------
function parseXmltvDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s?([+-]\d{4}))?/);
  if (!m) return null;
  const [_, Y, Mo, D, H, Mi, S, tz] = m;
  const iso = `${Y}-${Mo}-${D}T${H}:${Mi}:${S}` + (tz ? tz.replace(/(\d{2})(\d{2})/, "$1:$2") : "Z");
  return new Date(iso);
}
function parseXMLTV(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  const channelIdToName = new Map();
  dom.querySelectorAll("channel").forEach((ch) => {
    const id = ch.getAttribute("id") || "";
    const name = ch.querySelector("display-name")?.textContent?.trim() || id;
    channelIdToName.set(id, name);
  });
  const progs = new Map();
  dom.querySelectorAll("programme").forEach((p) => {
    const channel = p.getAttribute("channel") || "";
    const start = parseXmltvDate(p.getAttribute("start"));
    const stop = parseXmltvDate(p.getAttribute("stop"));
    if (!start || !stop) return;
    const title = p.querySelector("title")?.textContent?.trim() || "(okänt)";
    const desc = p.querySelector("desc")?.textContent?.trim() || "";
    const category = p.querySelector("category")?.textContent?.trim() || "";
    const ep = { start, stop, title, desc, category };
    if (!progs.has(channel)) progs.set(channel, []);
    progs.get(channel).push(ep);
  });
  for (const arr of progs.values()) arr.sort((a, b) => a.start - b.start);
  return { channelIdToName, progs };
}
function normalizeName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function buildNameIndex(channelIdToName) {
  const byName = new Map();
  for (const [id, name] of channelIdToName.entries()) {
    const key = normalizeName(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(id);
  }
  return byName;
}
function getEpgForChannel(ch, epg) {
  if (!epg) return null;
  const { channelIdToName, progs } = epg;
  if (ch.tvgId && progs.has(ch.tvgId)) return { id: ch.tvgId, progs: progs.get(ch.tvgId) };
  const nameIndex = buildNameIndex(channelIdToName);
  const key = normalizeName(ch.title || ch.rawAttrs?.["tvg-name"]);
  const ids = nameIndex.get(key);
  if (ids) {
    for (const id of ids) if (progs.has(id)) return { id, progs: progs.get(id) };
  }
  return null;
}
function nowNextForChannel(ch, epg, now = new Date()) {
  const hit = getEpgForChannel(ch, epg);
  if (!hit) return { now: null, next: null };
  const arr = hit.progs;
  let current = null, next = null;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (p.start <= now && now < p.stop) { current = p; next = arr[i + 1] || null; break; }
    if (p.start > now) { next = p; break; }
  }
  return { now: current, next };
}

// ------------------------ Storage helpers ------------------------
const LS_KEYS = {
  FAVORITES: "iptv.favorites",
  LAST: "iptv.last",
  PLAYLIST_META: "iptv.playlist.meta",
  EPG_META: "iptv.epg.meta",
  THEME: "iptv.theme",
};
function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : initialValue; } catch { return initialValue; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }, [key, value]);
  return [value, setValue];
}

// ------------------------ Player ------------------------
function HlsPlayer({ src, onClose, title, logo }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  useEffect(() => {
    const video = videoRef.current; if (!video) return;
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
      hlsRef.current = hls; hls.loadSource(src); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src; // Safari
    }
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      if (e.key.toLowerCase() === "f") video.requestFullscreen?.();
      if (e.key === " ") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
      if (e.key === "ArrowRight") video.currentTime += 10;
      if (e.key === "ArrowLeft") video.currentTime -= 10;
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [src, onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur">
      <div className="absolute top-4 left-4 flex items-center gap-3 text-white opacity-90">
        {logo ? <img src={logo} alt="logo" className="h-8 w-8 rounded"/> : <Tv2 className="h-8 w-8"/>}
        <div className="text-xl font-semibold">{title}</div>
      </div>
      <UIButton onClick={onClose} className="absolute top-3 right-3 text-white border-transparent hover:border-white/20 bg-white/10"><X className="h-5 w-5"/></UIButton>
      <div className="h-full w-full flex items-center justify-center p-4">
        <video ref={videoRef} controls autoPlay className="w-full h-full max-w-[1200px] max-h-[70vh] rounded-2xl shadow-2xl bg-black" />
      </div>
    </div>
  );
}

// ------------------------ EPG Modal ------------------------
function EpgModal({ channel, epg, onClose }) {
  const [dayOffset, setDayOffset] = useState(0);
  const baseDate = new Date(); baseDate.setHours(0,0,0,0);
  const dayStart = new Date(baseDate.getTime() + dayOffset * 86400000);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const hit = getEpgForChannel(channel, epg);
  const items = useMemo(() => hit ? hit.progs.filter(p => p.stop > dayStart && p.start < dayEnd) : [], [hit, dayStart, dayEnd]);
  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur">
      <div className="absolute top-4 left-4 right-4 mx-auto max-w-3xl" style={{ color: 'var(--fg)' }}>
        <div className="rounded-2xl border shadow-2xl" style={{ backgroundColor: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
          <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--card-border)' }}>
            <div className="flex items-center gap-3">
              {channel.logo ? <img src={channel.logo} className="h-8 w-8 rounded"/> : <Tv2 className="h-6 w-6"/>}
              <div className="text-lg font-semibold">Programguide · {channel.title}</div>
            </div>
            <div className="flex items-center gap-2">
              <UIButton onClick={() => setDayOffset(o => o - 1)}><ChevronLeft className="h-4 w-4"/></UIButton>
              <div className="text-sm opacity-80 w-40 text-center">
                {dayStart.toLocaleDateString()} – {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(dayStart)}
              </div>
              <UIButton onClick={() => setDayOffset(o => o + 1)}><ChevronRight className="h-4 w-4"/></UIButton>
              <UIButton onClick={onClose}><X className="h-4 w-4"/></UIButton>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto divide-y" style={{ borderColor: 'var(--card-border)' }}>
            {items.length === 0 && <div className="p-6 text-sm opacity-80">Ingen EPG-data för vald dag.</div>}
            {items.map((p, i) => (
              <div key={i} className="p-4 hover:bg-black/20">
                <div className="text-sm opacity-80">
                  {p.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {p.stop.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                <div className="font-medium">{p.title}</div>
                {p.desc && <div className="text-sm opacity-80 mt-1 line-clamp-2">{p.desc}</div>}
                {p.category && <div className="text-xs opacity-60 mt-1">{p.category}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------ Row ------------------------
function Row({ title, items, rowIndex, selected, onSelect, onPlay, favorites, toggleFavorite, epg }) {
  const scrollerRef = useRef(null);
  const scrollBy = (delta) => { const el = scrollerRef.current; if (el) el.scrollBy({ left: delta, behavior: "smooth" }); };
  useEffect(() => {
    if (!selected || selected.row !== rowIndex) return;
    const el = scrollerRef.current; const child = el?.children[selected.col];
    if (child && el) {
      const childRect = child.getBoundingClientRect(); const elRect = el.getBoundingClientRect();
      if (childRect.left < elRect.left) el.scrollBy({ left: childRect.left - elRect.left - 20, behavior: 'smooth' });
      if (childRect.right > elRect.right) el.scrollBy({ left: childRect.right - elRect.right + 20, behavior: 'smooth' });
    }
  }, [selected, rowIndex]);
  const now = new Date();
  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between pr-2">
        <h2 className="text-xl font-semibold">{title}</h2>
        <div className="flex gap-2">
          <UIButton onClick={() => scrollBy(-600)}><ChevronLeft className="h-5 w-5"/></UIButton>
          <UIButton onClick={() => scrollBy(600)}><ChevronRight className="h-5 w-5"/></UIButton>
        </div>
      </div>
      <div ref={scrollerRef} className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
        {items.map((ch, colIndex) => {
          const isSelected = selected && selected.row === rowIndex && selected.col === colIndex;
          const nn = epg ? nowNextForChannel(ch, epg, now) : { now: null, next: null };
          return (
            <motion.div key={ch.url + colIndex} whileHover={{ scale: 1.03 }} className="shrink-0" onMouseEnter={() => onSelect({ row: rowIndex, col: colIndex })}>
              <UICard className={(isSelected ? 'ring-2 ring-red-500 ' : '') + 'w-48'} style={{ backgroundColor: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
                <UICardContent>
                  <div className="relative">
                    {ch.logo ? (
                      <img src={ch.logo} alt={ch.title} className="h-28 w-48 object-cover rounded-t-2xl bg-black" />
                    ) : (
                      <div className="h-28 w-48 rounded-t-2xl bg-gradient-to-br from-neutral-800 to-neutral-900 flex items-center justify-center">
                        <Tv2 className="h-10 w-10 opacity-60" />
                      </div>
                    )}
                    <button className="absolute bottom-2 left-2 bg-white/90 hover:bg-white text-black rounded-full p-2 shadow" onClick={() => onPlay(ch)} title="Spela"><Play className="h-4 w-4" /></button>
                    <button className={`absolute bottom-2 right-2 rounded-full p-2 shadow ${favorites.has(ch.url) ? "bg-yellow-400 text-black" : "bg-black/60 text-white hover:bg-black/80"}`} onClick={() => toggleFavorite(ch)} title="Favorit"><Star className="h-4 w-4" /></button>
                    {nn.now && (<div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded-full bg-black/70 text-white">Nu: {nn.now.title}</div>)}
                    {!nn.now && nn.next && (<div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded-full bg-black/60 text-white">Nästa: {nn.next.title}</div>)}
                  </div>
                  <div className="p-3 space-y-1">
                    <div className="font-medium leading-tight truncate" title={ch.title}>{ch.title}</div>
                    <div className="text-xs opacity-70 truncate" title={ch.group}>{ch.group}</div>
                    <button className="mt-1 text-xs inline-flex items-center gap-1 opacity-80 hover:opacity-100" onClick={() => onSelect({ row: rowIndex, col: colIndex, openEpgFor: ch })}>
                      <CalendarClock className="h-3 w-3"/> Guide
                    </button>
                  </div>
                </UICardContent>
              </UICard>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------ Main App ------------------------
export default function IPTVNetflixApp() {
  const [channels, setChannels] = useState([]);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState(null);
  const [epg, setEpg] = useState(null);
  const [epgMeta, setEpgMeta] = useLocalStorage(LS_KEYS.EPG_META, { sourceType: "", sourceName: "" });
  const [favorites, setFavorites] = useLocalStorage(LS_KEYS.FAVORITES, []);
  const favSet = useMemo(() => new Set(favorites.map((f) => f.url)), [favorites]);
  const [playlistMeta, setPlaylistMeta] = useLocalStorage(LS_KEYS.PLAYLIST_META, { sourceType: "", sourceName: "" });
  const [theme, setTheme] = useLocalStorage(LS_KEYS.THEME, "dark");
  const [selected, setSelected] = useState({ row: 0, col: 0 });
  const [epgFor, setEpgFor] = useState(null);

  // Theme CSS vars
  useEffect(() => {
    document.documentElement.style.setProperty('--bg', theme === 'dark' ? '#0a0a0a' : '#fafafa');
    document.documentElement.style.setProperty('--fg', theme === 'dark' ? '#e5e5e5' : '#111111');
    document.documentElement.style.setProperty('--muted', theme === 'dark' ? '#a3a3a3' : '#4a4a4a');
    document.documentElement.style.setProperty('--card-bg', theme === 'dark' ? '#0f0f10' : '#ffffff');
    document.documentElement.style.setProperty('--card-border', theme === 'dark' ? '#27272a' : '#e5e7eb');
  }, [theme]);

  // Build rows
  const renderedRows = useMemo(() => {
    const filtered = channels.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));
    const byGroup = new Map();
    for (const c of filtered) { const g = c.group || "Other"; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(c); }
    const groupRows = Array.from(byGroup.entries()).sort((a,b)=>b[1].length - a[1].length).map(([name, items]) => ({ title: name, items }));
    const rows = []; if (favorites.length > 0) rows.push({ title: "Fortsätt & favoriter", items: favorites });
    return rows.concat(groupRows);
  }, [channels, query, favorites]);

  // Keep selected in bounds
  useEffect(() => {
    if (!renderedRows.length) return;
    const r = Math.max(0, Math.min(selected.row, renderedRows.length - 1));
    const c = Math.max(0, Math.min(selected.col, (renderedRows[r]?.items?.length || 1) - 1));
    if (r !== selected.row || c !== selected.col) setSelected({ row: r, col: c });
  }, [renderedRows, selected]);

  const onPlay = (ch) => { setPlaying(ch); localStorage.setItem(LS_KEYS.LAST, JSON.stringify(ch)); };
  const toggleFavorite = (ch) => setFavorites((prev) => {
    const exists = prev.find((p) => p.url === ch.url);
    if (exists) return prev.filter((p) => p.url !== ch.url);
    return [{ title: ch.title, url: ch.url, logo: ch.logo, group: ch.group }, ...prev].slice(0, 500);
  });

  // Loaders
  const loadFromFile = async (file) => { const text = await file.text(); const chs = parseM3U(text); setChannels(chs); setPlaylistMeta({ sourceType: "file", sourceName: file.name }); };
  const loadFromUrl = async (url) => { const res = await fetch(url); if (!res.ok) throw new Error("Kunde inte ladda playlist: " + res.status); const text = await res.text(); const chs = parseM3U(text); setChannels(chs); setPlaylistMeta({ sourceType: "url", sourceName: url }); };
  const loadEpgFile = async (file) => { const text = await file.text(); const data = parseXMLTV(text); setEpg(data); setEpgMeta({ sourceType: "file", sourceName: file.name }); };
  const loadEpgUrl = async (url) => { const res = await fetch(url); if (!res.ok) throw new Error("Kunde inte ladda EPG: " + res.status); const text = await res.text(); const data = parseXMLTV(text); setEpg(data); setEpgMeta({ sourceType: "url", sourceName: url }); };

  // Gamepad navigation
  useEffect(() => {
    let raf = 0; let prev = { axes: [], buttons: [] }; const threshold = 0.5; let lastMove = 0; const repeatDelayMs = 180;
    function step() {
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
      if (pads.length) {
        const p = pads[0]; const axes = p.axes || []; const buttons = p.buttons || []; const now = performance.now();
        const press = (cond, fn) => { if (cond && now - lastMove > repeatDelayMs) { fn(); lastMove = now; } };
        const leftX = axes[0] || 0, leftY = axes[1] || 0;
        const dUp = buttons[12]?.pressed, dDown = buttons[13]?.pressed, dLeft = buttons[14]?.pressed, dRight = buttons[15]?.pressed;
        press(leftY < -threshold || dUp, () => setSelected((s) => ({ row: Math.max(0, s.row - 1), col: 0 })));
        press(leftY > threshold || dDown, () => setSelected((s) => ({ row: Math.min(renderedRows.length - 1, s.row + 1), col: 0 })));
        press(leftX < -threshold || dLeft, () => setSelected((s) => ({ ...s, col: Math.max(0, s.col - 1) })));
        press(leftX > threshold || dRight, () => setSelected((s) => ({ ...s, col: Math.min((renderedRows[s.row]?.items?.length || 1) - 1, s.col + 1) })));
        if (buttons[0]?.pressed && !prev.buttons[0]?.pressed) { const ch = renderedRows[selected.row]?.items?.[selected.col]; if (ch) onPlay(ch); }
        if (buttons[1]?.pressed && !prev.buttons[1]?.pressed) { if (playing) setPlaying(null); else if (epgFor) setEpgFor(null); }
        prev = { axes: [...axes], buttons: buttons.map(b => ({ pressed: !!b.pressed })) };
      }
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [renderedRows, selected, playing, epgFor]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }} onDragOver={(e)=>e.preventDefault()} onDrop={async (e)=>{ e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (!f) return; if (f.name.endsWith('.m3u') || f.name.endsWith('.m3u8')) await loadFromFile(f); if (f.name.endsWith('.xml') || f.name.endsWith('.xmltv')) await loadEpgFile(f); }}>
      <header className="sticky top-0 z-40 border-b" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.8), rgba(0,0,0,0.2))', borderColor: 'var(--card-border)' }}>
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2 mr-2">
            <div className="h-7 w-7 rounded bg-red-600"/>
            <span className="text-xl font-bold tracking-wide">NetIPTV</span>
          </div>
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 opacity-60"/>
            <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Sök kanaler..." className="w-full rounded-xl px-9 pr-3 py-2 outline-none" style={{ backgroundColor: 'var(--card-bg)', border: `1px solid var(--card-border)`, color: 'var(--fg)' }} />
          </div>
          <UIButton onClick={()=>setTheme(theme === 'dark' ? 'light' : 'dark')} className="ml-2" title="Byt tema">{theme === 'dark' ? <Sun className="h-4 w-4"/> : <Moon className="h-4 w-4"/>}</UIButton>
          <label className="ml-2">
            <input type="file" accept=".m3u,.m3u8" className="hidden" onChange={(e)=>e.target.files && loadFromFile(e.target.files[0])} />
            <UIButton>Importera M3U</UIButton>
          </label>
          <label className="ml-2">
            <input type="file" accept=".xml,.xmltv" className="hidden" onChange={(e)=>e.target.files && loadEpgFile(e.target.files[0])} />
            <UIButton>Importera EPG</UIButton>
          </label>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4 space-y-8">
        <HeroLoadSources onLoadUrl={loadFromUrl} onLoadEpgUrl={loadEpgUrl} playlistMeta={playlistMeta} epgMeta={epgMeta} count={channels.length} hasEpg={!!epg} />
        {renderedRows.length === 0 && (<div className="opacity-70 text-sm">Tips: Dra & släpp din .m3u eller .xmltv hit, eller klistra in URL:er ovan.</div>)}
        {renderedRows.map((row, rowIndex) => (
          <Row key={row.title} title={row.title} items={row.items} rowIndex={rowIndex} selected={selected} onSelect={(sel)=>{ setSelected({ row: sel.row, col: sel.col }); if (sel.openEpgFor) setEpgFor(sel.openEpgFor); }} onPlay={onPlay} favorites={favSet} toggleFavorite={toggleFavorite} epg={epg} />
        ))}
      </main>

      {playing && (<HlsPlayer src={playing.url} title={playing.title} logo={playing.logo} onClose={() => setPlaying(null)} />)}
      {epgFor && (<EpgModal channel={epgFor} epg={epg} onClose={()=>setEpgFor(null)} />)}

      <footer className="py-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
        <div>Byggd i React + Tailwind + hls.js. Gamepad‑stöd aktivt <Gamepad2 className="inline h-3 w-3"/>. EPG via XMLTV.</div>
      </footer>
    </div>
  );
}

function HeroLoadSources({ onLoadUrl, onLoadEpgUrl, playlistMeta, epgMeta, count, hasEpg }) {
  const [url, setUrl] = useState("");
  const [epgUrl, setEpgUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingEpg, setLoadingEpg] = useState(false);
  const [err, setErr] = useState("");
  const [epgErr, setEpgErr] = useState("");
  const load = async () => { setErr(""); setLoading(true); try { await onLoadUrl(url); setUrl(""); } catch (e) { setErr(String(e.message || e)); } finally { setLoading(false); } };
  const loadEpg = async () => { setEpgErr(""); setLoadingEpg(true); try { await onLoadEpgUrl(epgUrl); setEpgUrl(""); } catch (e) { setEpgErr(String(e.message || e)); } finally { setLoadingEpg(false); } };
  return (
    <div className="relative rounded-2xl p-6 border" style={{ backgroundColor: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <div className="text-2xl font-semibold">Ladda spellista</div>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>Klistra in en .m3u/.m3u8‑URL eller importera en fil. {count ? `Laddade kanaler: ${count}` : ""}</div>
          {playlistMeta?.sourceName && (<div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Källa: {playlistMeta.sourceType} · {playlistMeta.sourceName}</div>)}
          <div className="mt-3 flex gap-2">
            <input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://exempel.com/playlist.m3u8" className="flex-1 rounded-xl px-3 py-2 outline-none" style={{ backgroundColor: 'var(--card-bg)', border: `1px solid var(--card-border)`, color: 'var(--fg)' }} />
            <UIButton onClick={load} disabled={loading || !url}>{loading ? "Laddar..." : "Ladda"}</UIButton>
          </div>
          {err && <div className="text-red-400 text-xs mt-2">{err}</div>}
        </div>
        <div>
          <div className="text-2xl font-semibold flex items-center gap-2">Ladda EPG <Info className="h-4 w-4 opacity-60"/></div>
          <div className="text-sm" style={{ color: 'var(--muted)' }}>XMLTV (.xml/.xmltv). Visar nu/nästa + guide. {hasEpg ? "EPG inläst" : "Ingen EPG inläst"}</div>
          {epgMeta?.sourceName && (<div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Källa: {epgMeta.sourceType} · {epgMeta.sourceName}</div>)}
          <div className="mt-3 flex gap-2">
            <input value={epgUrl} onChange={(e)=>setEpgUrl(e.target.value)} placeholder="https://exempel.com/epg.xml" className="flex-1 rounded-xl px-3 py-2 outline-none" style={{ backgroundColor: 'var(--card-bg)', border: `1px solid var(--card-border)`, color: 'var(--fg)' }} />
            <UIButton onClick={loadEpg} disabled={loadingEpg || !epgUrl}>{loadingEpg ? "Laddar..." : "Ladda EPG"}</UIButton>
          </div>
          {epgErr && <div className="text-red-400 text-xs mt-2">{epgErr}</div>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------
   Electron (Windows 11) – guide för .exe
   ------------------------------------------------------
1) Init (Vite + React)
   npm create vite@latest netiptv-desktop -- --template react
   cd netiptv-desktop
   npm i
   npm i hls.js framer-motion lucide-react tailwindcss postcss autoprefixer
   npx tailwindcss init -p
   // index.css: @tailwind base; @tailwind components; @tailwind utilities;

2) Lägg in denna komponent i src/App.jsx och importera index.css

3) Electron
   npm i -D electron electron-builder concurrently wait-on

   // package.json
   {
     "name": "netiptv",
     "version": "1.0.0",
     "main": "electron/main.js",
     "scripts": {
       "dev": "concurrently "vite" "wait-on http://localhost:5173 && electron ."",
       "build": "vite build",
       "electron": "electron .",
       "dist": "vite build && electron-builder"
     },
     "build": {
       "appId": "com.example.netiptv",
       "productName": "NetIPTV",
       "files": ["dist/**", "electron/**"],
       "directories": { "buildResources": "build" },
       "win": { "target": [{ "target": "nsis", "arch": ["x64"] }], "publisherName": "Your Name" },
       "nsis": { "oneClick": false, "perMachine": false, "allowToChangeInstallationDirectory": true }
     }
   }

   // electron/main.js
   const { app, BrowserWindow, session } = require('electron');
   const path = require('path');
   function createWindow() {
     const win = new BrowserWindow({
       width: 1280, height: 800,
       backgroundColor: '#0a0a0a',
       autoHideMenuBar: true,
       webPreferences: { contextIsolation: true, sandbox: true, webSecurity: false }
     });
     session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
       details.requestHeaders['User-Agent'] = details.requestHeaders['User-Agent'] || 'Mozilla/5.0';
       cb({ cancel: false, requestHeaders: details.requestHeaders });
     });
     if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
     else win.loadFile(path.join(__dirname, '../dist/index.html'));
   }
   app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
   app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

4) Bygg installerare
   npm run dist

Tips
- Om vissa strömmar kräver referer/cookie: lägg headers i webRequest ovan.
- DRM-strömmar funkar inte i hls.js.
- Gamepad: standard Gamepad API (Xbox/PS). Fjärr som mappar D‑pad fungerar.
*/
