import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, Heart, Sparkle, SpinnerGap, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { T } from "./i18n.js";
import { api, assetUrl } from "./api.js";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { matchInspiration } from "./recommender.js";

const INSPIRATION_KEY = "wardrobe-inspirations-v1";
const LIKED_KEY = "wardrobe-liked-v1";

// 分阶段等待提示：长时间 AI 调用时轮播阶段文案，缓解等待焦虑
function useStageText(active, stages, interval = 3500) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (!active) return undefined;
    const timer = setInterval(() => setIndex((current) => Math.min(current + 1, stages.length - 1)), interval);
    return () => clearInterval(timer);
  }, [active, stages, interval]);
  return active ? stages[index] : "";
}

const SLOT_LABELS = {
  upperbody: T.singular.upperbody,
  lowerbody: T.singular.lowerbody,
  wholebody_up: T.singular.wholebody_up,
  shoes: T.singular.shoes,
  accessories_up: T.singular.accessories_up,
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(T.analyzing));
    reader.readAsDataURL(file);
  });
}

export function InspirationPanel({ items, onOpenItem }) {
  const [inspirations, setInspirations] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [matchResult, setMatchResult] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [liked, setLiked] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || "[]")); } catch { return new Set(); }
  });
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const tryonStageText = useStageText(generating, T.tryonStages);
  const analyzeStageText = useStageText(analyzing, T.analyzeStages);

  // 灵感详情打开时锁定 body 滚动，避免移动端上下层同时滚动导致手势冲突
  useEffect(() => {
    if (!selected) return undefined;
    document.body.classList.add("viewer-open");
    return () => document.body.classList.remove("viewer-open");
  }, [selected]);

  // 优先从服务端加载灵感库（本地 localStorage 仅作缓存）
  useEffect(() => {
    api.get("/api/style/inspirations")
      .then((records) => {
        if (Array.isArray(records) && records.length) persistInspirations(records);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(INSPIRATION_KEY) || "[]");
      if (stored.length) setInspirations(stored);
    } catch {}
  }, []);

  const persistInspirations = (next) => {
    setInspirations(next);
    localStorage.setItem(INSPIRATION_KEY, JSON.stringify(next));
  };

  const toggleLike = (id) => {
    const nextLiked = !liked.has(id);
    setLiked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(LIKED_KEY, JSON.stringify([...next]));
      return next;
    });
    api.patch(`/api/style/inspirations/${id}`, { liked: nextLiked }).catch(() => {});
  };

  const uploadImages = useCallback(async (files) => {
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    setAnalyzing(true); setError(""); setDragOver(false);
    try {
      const dataUrls = await Promise.all(images.map(fileToDataUrl));
      const newInspirations = [];
      for (const imageDataUrl of dataUrls) {
        const record = await api.post("/api/style/inspirations", { imageDataUrl });
        newInspirations.push(record);
      }
      persistInspirations([...newInspirations, ...inspirations]);
    } catch (e) { setError(e.message); }
    finally { setAnalyzing(false); }
  }, [inspirations]);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragOver(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragOver(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragOver(false); uploadImages(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); uploadImages(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [uploadImages]);

  const myStyle = useMemo(() => {
    const freq = new Map();
    for (const insp of inspirations) {
      if (!liked.has(insp.id)) continue;
      for (const tag of insp.styleTags || []) {
        freq.set(tag, (freq.get(tag) || 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag);
  }, [inspirations, liked]);

  const deleteInspiration = (id) => {
    api.delete(`/api/style/inspirations/${id}`).catch(() => {});
    persistInspirations(inspirations.filter((insp) => insp.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const runMatch = (inspiration) => {
    const result = matchInspiration(inspiration, items, rotation);
    setMatchResult({ ...result, inspirationId: inspiration.id });
    setRotation(0);
  };

  const refreshMatch = () => {
    const insp = inspirations.find((i) => i.id === matchResult?.inspirationId) || selected;
    if (!insp) return;
    setRotation((r) => r + 1);
    const result = matchInspiration(insp, items, rotation + 1);
    setMatchResult({ ...result, inspirationId: insp.id });
  };

  const generateLook = async () => {
    if (!selected) return;
    setGenerating(true); setGenError("");
    try {
      const match = matchResult?.inspirationId === selected.id ? matchResult : matchInspiration(selected, items, 0);
      const garmentIds = Object.values(match.slots || {}).map((piece) => piece?.id).filter(Boolean);
      if (!garmentIds.length) {
        setGenError(T.noMatchForLook);
        return;
      }
      const result = await api.post("/api/looks/generate", { type: "inspiration", inspirationId: selected.id, garmentIds });
      if (result.image || result.url) {
        const img = result.image || result.url;
        setInspirations((current) => current.map((insp) => insp.id === selected.id ? { ...insp, lookImage: img } : insp));
        setSelected((current) => current ? { ...current, lookImage: img } : current);
      }
    } catch (e) { setGenError(e.message); }
    finally { setGenerating(false); }
  };

  return (
    <main className="inspiration-panel">
      <header className="inspiration-header">
        <div className="inspiration-meta-row">
          <Sparkle size={28} weight="light" aria-hidden="true" />
          <h2>{T.tabInspiration}</h2>
        </div>
        {myStyle.length > 0 && (
          <div className="my-style">
            <span>{T.myStyle}</span>
            <div className="my-style-tags">
              {myStyle.map((tag) => <span className="my-style-tag" key={tag}>{tag}</span>)}
            </div>
          </div>
        )}
      </header>

      <div
        className={`inspiration-upload${dragOver ? " is-over" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); uploadImages(event.dataTransfer.files); }}
      >
        <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { uploadImages(event.target.files); event.target.value = ""; }} />
        <UploadSimple size={28} weight="light" />
        <p>{analyzing ? analyzeStageText || T.analyzingInspiration : T.uploadInspiration}</p>
        <small>{T.inspirationHint}</small>
      </div>

      {error && <p className="status error">{error}</p>}

      {inspirations.length === 0 && !analyzing ? (
        <p className="status empty">{T.noInspirations}</p>
      ) : (
        <div className="inspiration-grid">
          {inspirations.map((insp) => (
            <article
              className={`inspiration-card${liked.has(insp.id) ? " is-liked" : ""}`}
              key={insp.id}
              onClick={() => { setSelected(insp); setMatchResult(null); setRotation(0); }}
            >
              <OptimizedImage
                src={assetUrl(insp.image || insp.thumbnail)}
                alt={insp.summary || insp.styleSummary || ""}
                sizes="(max-width: 520px) 45vw, 200px"
                breakpoints={[120, 180, 240, 320]}
              />
              <div className="inspiration-card-body">
                {(insp.styleTags || []).slice(0, 3).map((tag) => <span className="style-tag" key={tag}>{tag}</span>)}
                <div className="palette-dots">
                  {(insp.palette || []).slice(0, 4).map((color) => <span className="palette-dot" key={color} style={{ backgroundColor: color }} />)}
                </div>
              </div>
              <button
                className="like-badge"
                type="button"
                onClick={(event) => { event.stopPropagation(); toggleLike(insp.id); }}
                aria-label={liked.has(insp.id) ? T.unlike : T.like}
              >
                <Heart size={16} weight={liked.has(insp.id) ? "fill" : "regular"} />
              </button>
            </article>
          ))}
        </div>
      )}

      {selected && (
        <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}>
          <div className="viewer-entry">
            <aside className="viewer editing inspiration-detail" role="dialog" aria-modal="true" aria-label={T.tabInspiration}>
              <button className="viewer-icon-close" type="button" onClick={() => setSelected(null)} aria-label={T.cancel}>
                <X size={24} weight="light" aria-hidden="true" />
              </button>
              <div className="inspiration-detail-image">
                <OptimizedImage
                  src={assetUrl(selected.image)}
                  alt={selected.summary || selected.styleSummary || ""}
                  sizes="(max-width: 860px) 100vw, 520px"
                  breakpoints={[320, 480, 640, 800, 1040]}
                  priority
                />
              </div>
              <div className="viewer-details editing">
                {(selected.summary || selected.styleSummary) && (
                  <div className="field">
                    <span>{T.styleSummary}</span>
                    <p className="inspiration-summary">{selected.summary || selected.styleSummary}</p>
                  </div>
                )}
                {(selected.styleTags || []).length > 0 && (
                  <div className="field">
                    <span>{T.styleTags}</span>
                    <div className="editable-tags">
                      {selected.styleTags.map((tag) => <span className="editable-tag" key={tag}>{tag}</span>)}
                    </div>
                  </div>
                )}
                {(selected.palette || []).length > 0 && (
                  <div className="field">
                    <span>{T.paletteColors}</span>
                    <div className="palette">
                      {selected.palette.map((color) => <span className="palette-swatch" key={color} style={{ backgroundColor: color }} />)}
                    </div>
                  </div>
                )}
                {(selected.garments || []).length > 0 && (
                  <div className="field">
                    <span>{T.outfitBreakdown}</span>
                    <ul className="inspiration-garments">
                      {selected.garments.map((g, i) => <li key={i}>{SLOT_LABELS[g.part] || g.part}：{g.name || g.description || ""}</li>)}
                    </ul>
                  </div>
                )}
                {selected.note && (
                  <div className="field">
                    <span>{T.note}</span>
                    <p className="inspiration-summary">{selected.note}</p>
                  </div>
                )}
                {selected.lookImage && (
                  <div className="look-preview">
                    <img src={assetUrl(selected.lookImage)} alt={T.generateLook} />
                  </div>
                )}
                {genError && <p className="status error">{genError}</p>}
                <div className="viewer-actions">
                  <button className="delete-button" type="button" onClick={() => { deleteInspiration(selected.id); setSelected(null); }}>
                    <Trash size={15} /> {T.delete}
                  </button>
                  <span className="action-spacer" />
                  <button className="secondary-button" type="button" onClick={() => { runMatch(selected); }}>
                    {T.matchFromWardrobe}
                  </button>
                  <button className="primary-button" type="button" onClick={generateLook} disabled={generating}>
                    {generating ? <SpinnerGap size={15} className="import-spinner" /> : <Sparkle size={15} />}
                    {generating ? tryonStageText || T.analyzing : T.generateLook}
                  </button>
                </div>
                {matchResult && (
                  <div className="match-result">
                    {matchResult.reasons?.length > 0 && (
                      <ul className="outfit-reasons">
                        {matchResult.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                      </ul>
                    )}
                    <div className="outfit-slots">
                      {["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"].map((slot) => {
                        const piece = matchResult.slots?.[slot];
                        if (!piece) return null;
                        return (
                          <button
                            type="button"
                            className="outfit-slot"
                            key={slot}
                            onClick={() => onOpenItem?.(piece.id)}
                            aria-label={piece.name || SLOT_LABELS[slot]}
                          >
                            <OptimizedImage
                              src={assetUrl(piece.thumbnail || piece.image)}
                              alt={piece.name || SLOT_LABELS[slot]}
                              sizes="80px"
                              breakpoints={[60, 80, 120]}
                            />
                            <span className="outfit-slot-label">{SLOT_LABELS[slot]}</span>
                            <span className="outfit-slot-name">{piece.name || piece.subtype || ""}</span>
                          </button>
                        );
                      })}
                    </div>
                    <button className="secondary-button" type="button" onClick={refreshMatch}>
                      <ArrowsClockwise size={15} /> {T.refreshOutfit}
                    </button>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      )}
    </main>
  );
}
