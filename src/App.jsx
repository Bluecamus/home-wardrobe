import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckSquare, CloudSun, CoatHanger, Plus, Sparkle, Trash, X } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { WeatherPanel } from "./WeatherPanel.jsx";
import { InspirationPanel } from "./InspirationPanel.jsx";
import { T, colorLabel } from "./i18n.js";
import { api, assetUrl } from "./api.js";

const STORAGE_KEY = "open-wardrobe-edits-v1";
const DELETED_STORAGE_KEY = "open-wardrobe-deleted-v1";

const TYPES = [
  { id: "all", label: T.categories.all },
  { id: "upperbody", label: T.categories.upperbody, singular: T.singular.upperbody },
  { id: "wholebody_up", label: T.categories.wholebody_up, singular: T.singular.wholebody_up },
  { id: "lowerbody", label: T.categories.lowerbody, singular: T.singular.lowerbody },
  { id: "accessories_up", label: T.categories.accessories_up, singular: T.singular.accessories_up },
  { id: "shoes", label: T.categories.shoes, singular: T.singular.shoes },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));

const SEASONS = [
  { id: "all", label: T.seasonAll },
  { id: "spring", label: T.seasons.spring },
  { id: "summer", label: T.seasons.summer },
  { id: "autumn", label: T.seasons.autumn },
  { id: "winter", label: T.seasons.winter },
];

const SEASON_KEYS = ["spring", "summer", "autumn", "winter"];

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

function readEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function persistEdit(item) {
  const edits = readEdits();
  edits[item.id] = {
    name: item.name || "",
    part: item.part,
    subtype: item.subtype || "",
    color: item.color || null,
    secondaryColor: item.secondaryColor || null,
    tags: item.tags || [],
    season: item.season || [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function removePersistedEdit(id) {
  const edits = readEdits();
  delete edits[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
}

function readDeletedItems() {
  try {
    const value = JSON.parse(localStorage.getItem(DELETED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistDeletedItem(id) {
  const deleted = readDeletedItems();
  deleted.add(id);
  localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify([...deleted]));
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

function GalleryItem({ item, selected, onOpen, manageMode, checked, onToggleCheck }) {
  const type = TYPE_MAP[item.part]?.singular || T.categories.all;

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}${manageMode ? " manage-mode" : ""}`}
      type="button"
      onClick={() => (manageMode ? onToggleCheck(item.id) : onOpen(item.id))}
      aria-label={`${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={assetUrl(item.thumbnail || item.image)}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
      {item.color ? <span className="gallery-item-color" style={{ backgroundColor: item.color }} /> : null}
      {item.subtype ? <span className="gallery-item-badge">{item.subtype}</span> : null}
      {manageMode && <span className="gallery-item-check" aria-hidden="true" />}
    </button>
  );
}

function SeasonPicker({ value = [], onChange }) {
  return (
    <div className="season-picker">
      {SEASON_KEYS.map((s) => (
        <label key={s} className={`season-chip${value.includes(s) ? " active" : ""}`}>
          <input
            type="checkbox"
            checked={value.includes(s)}
            onChange={(e) => {
              if (e.target.checked) onChange([...value, s]);
              else onChange(value.filter((v) => v !== s));
            }}
          />
          {T.seasons[s]}
        </label>
      ))}
    </div>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`${T.delete} ${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder={T.addDetail}
          aria-label={T.addDetail}
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label={T.add}>
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>{T.optional}</small>
        </div>
        <p>{T.noSecondary}</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>{T.addSecondary}</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>{T.cancel}</button>}
      </div>
      <label className="selected-color-control">
        <span className="color-swatch-box" style={{ backgroundColor: value || "#9a9286" }} />
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
          className="color-input-hidden"
        />
        <span className="selected-color-copy">
          <small>{T.selected}</small>
          <strong>{value ? colorLabel(value) : T.optional}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>{T.imageSuggestions}</span>
        <small>{T.clickToApply}</small>
      </div>
      <div className="palette" aria-label={label}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={colorLabel(color)}
            title={colorLabel(color)}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? T.cancelPicking : T.pickFromImage}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>{T.name}</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder={TYPE_MAP[draft.part]?.singular || T.categories.all}
        />
      </label>

      <label className="field">
        <span>{T.category}</span>
        <select value={draft.part} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value }))}>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <label className="field">
        <span>{T.subtype}</span>
        <input
          list="subtype-options"
          value={draft.subtype || ""}
          placeholder={T.subtypePlaceholder}
          onChange={(event) => setDraft((current) => ({ ...current, subtype: event.target.value }))}
        />
        <datalist id="subtype-options">
          {T.subtypeSuggestions.map((option) => <option value={option} key={option} />)}
        </datalist>
      </label>

      <fieldset className="color-field">
        <legend>{T.colors}</legend>
        <div className="colors-editor">
          <ColorControl
            label={T.primaryColor}
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label={T.secondaryColor}
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? T.clickGarmentHint : sampleStatus || T.primaryColor}</p>
      </fieldset>

      <div className="field season-field">
        <span>季节</span>
        <SeasonPicker value={draft.season || []} onChange={(season) => setDraft((current) => ({ ...current, season }))} />
      </div>

      <div className="field details-field">
        <span>{T.details}</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>

      {draft.sourceUrl && (
        <div className="field source-link-field">
          <a className="source-link" href={draft.sourceUrl} target="_blank" rel="noreferrer">{T.viewSource}</a>
        </div>
      )}
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part, subtype: item.subtype || "", color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], season: [...(item.season || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || T.categories.all;
  const hasModeledImage = Boolean(item.modeledImage);
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    const sortedSeason = (s) => [...(s || [])].sort();
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part,
      subtype: (draft.subtype || "").trim(),
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
      season: sortedSeason(draft.season),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part,
      subtype: (item.subtype || "").trim(),
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
      season: sortedSeason(item.season),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
    setDraft({ name: item.name || "", part: item.part, subtype: item.subtype || "", color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], season: [...(item.season || [])] });
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part, subtype: item.subtype || "", color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])], season: [...(item.season || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = () => {
    onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
    setSampling(null);
    setSampleStatus(T.changesSaved);
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus(T.transparentSpot);
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`${T.pickFromImage} ${color}`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={assetUrl(item.image)}
        alt={type}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">{T.clickGarmentHint}</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onClick={(event) => event.target === event.currentTarget && requestClose()} onTouchStart={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div className="viewer-entry">
      <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label={type}>
        <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label={T.cancel} ref={closeButtonRef}>
          <X size={24} weight="light" aria-hidden="true" />
        </button>

        {hasModeledImage ? (
          <div className="modeled-hero">
            <OptimizedImage
              className="modeled-hero-photo"
              src={assetUrl(item.modeledImage)}
              alt={`${draft.name || type}`}
              sizes="(max-width: 860px) 100vw, 520px"
              breakpoints={[320, 480, 640, 800, 1040, 1280]}
              quality={82}
              priority
            />
            <div className="viewer-heading modeled-heading">
              <div>
                <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
              </div>
            </div>
            {garmentArtwork}
          </div>
        ) : (
          <>
            <div className="viewer-heading">
              <div>
                <h2>{draft.name || TYPE_MAP[draft.part]?.singular}</h2>
              </div>
            </div>
            {garmentArtwork}
          </>
        )}

        <div className="viewer-details editing">
          <ItemEditor
            draft={draft}
            setDraft={setDraft}
            palette={palette}
            sampling={sampling}
            setSampling={setSampling}
            sampleStatus={sampleStatus}
          />

          {closeBlocked && <p className="unsaved-notice" role="status">{T.unsavedNotice}</p>}

          <div className="viewer-actions">
            <button className="delete-button" type="button" onClick={() => onDelete(item.id)}>
              <Trash size={15} weight="regular" aria-hidden="true" /> {T.delete}
            </button>
            <span className="action-spacer" />
            <button className="secondary-button" type="button" onClick={cancelEditing}>{T.cancel}</button>
            <button className="primary-button" type="button" onClick={saveEditing}>
              <Check size={15} weight="bold" aria-hidden="true" /> {T.save}
            </button>
          </div>
        </div>
      </aside>
      </div>
    </div>
  );
}

function LinkImportDialog({ onClose, onAdded }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [phase, setPhase] = useState(null); // "analyze" | "commit" | null
  const [confirmData, setConfirmData] = useState(null);
  const [error, setError] = useState("");
  const [fetchedPreview, setFetchedPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const analyzing = phase !== null;
  const stageText = useStageText(analyzing, phase === "commit" ? T.commitStages : T.analyzeStages);

  const handleFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result);
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    const onPaste = (event) => {
      const files = [...event.clipboardData.files];
      const image = files.find((file) => file.type.startsWith("image/"));
      if (image) { event.preventDefault(); handleFile(image); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const analyze = async () => {
    if (!url.trim()) { setError(T.pasteLink); return; }
    setPhase("analyze"); setError(""); setFetchedPreview(null);
    try {
      const result = await api.post("/api/wardrobe/link-analyze", { sourceUrl: url.trim(), imageDataUrl, name: name.trim() });
      if (result.noClothingDetected) {
        setError(result.message || T.noClothingDetected);
        setFetchedPreview(result.previewUrl || null);
        return;
      }
      const draft = result.draft || {};
      setConfirmData({
        token: result.token,
        previewUrl: result.previewUrl,
        sourceUrl: result.sourceUrl || url.trim(),
        name: draft.name || name.trim(),
        part: draft.part || "upperbody",
        subtype: draft.subtype || "",
        color: draft.color || "#9a9286",
        season: Array.isArray(draft.season) ? draft.season : [],
        tags: Array.isArray(draft.tags) ? draft.tags.join(", ") : (draft.tags || ""),
        boundingBox: draft.boundingBox || null,
        candidates: Array.isArray(result.candidates) ? result.candidates : [],
        candidateIndex: 0,
      });
    } catch (e) { setError(e.message); }
    finally { setPhase(null); }
  };

  const commit = async () => {
    setPhase("commit"); setError("");
    try {
      const payload = {
        token: confirmData.token,
        sourceUrl: confirmData.sourceUrl,
        metadata: {
          name: confirmData.name?.trim() || "",
          part: confirmData.part || "upperbody",
          subtype: confirmData.subtype?.trim() || "",
          color: confirmData.color || "#9a9286",
          season: confirmData.season || [],
          tags: (confirmData.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
          boundingBox: confirmData.boundingBox || undefined,
        },
      };
      const result = await api.post("/api/wardrobe/link-commit", payload);
      const item = result.item || result;
      onAdded({ ...item, source: "link", sourceUrl: confirmData.sourceUrl });
      onClose();
    } catch (e) { setError(e.message); }
    finally { setPhase(null); }
  };

  const updateConfirm = (patch) => setConfirmData((current) => ({ ...current, ...patch }));

  const selectCandidate = (index) => {
    const candidate = confirmData.candidates[index];
    if (!candidate) return;
    updateConfirm({
      candidateIndex: index,
      name: candidate.name || confirmData.name,
      part: candidate.part || confirmData.part,
      subtype: candidate.subtype || "",
      color: candidate.color || confirmData.color,
      season: Array.isArray(candidate.season) ? candidate.season : confirmData.season,
      tags: Array.isArray(candidate.tags) ? candidate.tags.join(", ") : confirmData.tags,
      boundingBox: candidate.boundingBox || confirmData.boundingBox,
    });
  };

  return (
    <div className="link-import-dialog viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-entry">
        <aside className="viewer editing" role="dialog" aria-modal="true" aria-label={T.linkImport}>
          <button className="viewer-icon-close" type="button" onClick={onClose} aria-label={T.cancel}>
            <X size={24} weight="light" aria-hidden="true" />
          </button>
          <div className="viewer-heading"><div><h2>{confirmData ? T.confirmInfo : T.linkImport}</h2></div></div>
          <div className="viewer-details editing">
            {error && <p className="status error">{error}</p>}
            {fetchedPreview && (
              <div className="link-fetched-preview">
                <p className="link-fetched-label">从链接抓取到的图片：</p>
                <img src={assetUrl(fetchedPreview)} alt="抓取预览" className="link-fetched-img" />
              </div>
            )}
            {!confirmData ? (
              <div className="link-import-form">
                <label className="field">
                  <span>{T.pasteLink} *</span>
                  <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={T.linkPlaceholder} />
                </label>
                <div
                  className={`link-drop-zone${dragOver ? " is-over" : ""}`}
                  onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(event) => { event.preventDefault(); setDragOver(false); handleFile(event.dataTransfer.files[0]); }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => { handleFile(event.target.files[0]); event.target.value = ""; }} />
                  {imageDataUrl ? (
                    <img src={imageDataUrl} alt={T.productImage} className="link-drop-preview" />
                  ) : (
                    <div className="link-drop-placeholder">
                      <Plus size={28} weight="light" />
                      <p>{T.productImage}</p>
                    </div>
                  )}
                </div>
                <label className="field">
                  <span>{T.productName}</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <div className="viewer-actions">
                  <span className="action-spacer" />
                  <button className="primary-button" type="button" onClick={analyze} disabled={analyzing || !url.trim()}>
                    {analyzing ? stageText || T.analyzing : "识别"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="confirm-card">
                <p className="confirm-hint">{T.confirmHint}</p>
                {confirmData.previewUrl && <img className="confirm-preview" src={assetUrl(confirmData.previewUrl)} alt={T.productImage} />}
                {confirmData.candidates.length > 1 && (
                  <div className="field">
                    <span>{T.candidatesHint}</span>
                    <div className="candidate-chips">
                      {confirmData.candidates.map((candidate, index) => (
                        <button
                          key={`${candidate.name}-${index}`}
                          type="button"
                          className={`candidate-chip${index === confirmData.candidateIndex ? " active" : ""}`}
                          onClick={() => selectCandidate(index)}
                        >
                          {candidate.subtype || candidate.name || `${index + 1}`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <label className="field">
                  <span>{T.name}</span>
                  <input value={confirmData.name || ""} onChange={(event) => updateConfirm({ name: event.target.value })} />
                </label>
                <label className="field">
                  <span>{T.category}</span>
                  <select value={confirmData.part || "upperbody"} onChange={(event) => updateConfirm({ part: event.target.value })}>
                    {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>{T.subtype}</span>
                  <input
                    list="link-subtype-options"
                    value={confirmData.subtype || ""}
                    placeholder={T.subtypePlaceholder}
                    onChange={(event) => updateConfirm({ subtype: event.target.value })}
                  />
                  <datalist id="link-subtype-options">
                    {T.subtypeSuggestions.map((option) => <option value={option} key={option} />)}
                  </datalist>
                </label>
                <div className="field">
                  <span>季节</span>
                  <SeasonPicker value={confirmData.season || []} onChange={(season) => updateConfirm({ season })} />
                </div>
                <label className="field">
                  <span>{T.primaryColor}</span>
                  <div className="import-color-row">
                    <span className="color-swatch-box" style={{ backgroundColor: confirmData.color || "#9a9286" }} />
                    <input type="color" value={confirmData.color || "#9a9286"} onChange={(event) => updateConfirm({ color: event.target.value })} className="color-input-hidden" />
                    <input value={confirmData.color ? colorLabel(confirmData.color) : ""} readOnly aria-label={T.primaryColor} />
                  </div>
                </label>
                <label className="field">
                  <span>{T.details}</span>
                  <input value={confirmData.tags || ""} onChange={(event) => updateConfirm({ tags: event.target.value })} />
                </label>
                <div className="viewer-actions">
                  <span className="action-spacer" />
                  <button className="secondary-button" type="button" onClick={() => setConfirmData(null)} disabled={analyzing}>{T.cancel}</button>
                  <button className="primary-button" type="button" onClick={commit} disabled={analyzing}>
                    <Check size={15} weight="bold" aria-hidden="true" /> {analyzing ? stageText || T.analyzing : T.confirm}
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function App() {
  const [items, setItems] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [activeSubtype, setActiveSubtype] = useState("all");
  const [activeSeason, setActiveSeason] = useState("all");
  const [activeTab, setActiveTab] = useState("wardrobe");
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [manageMode, setManageMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState(() => new Set());

  useEffect(() => {
    api.get("/api/import/wardrobe")
      .then((loadedItems) => {
        const edits = readEdits();
        const deleted = readDeletedItems();
        const visibleItems = loadedItems.filter((item) => !deleted.has(item.id));
        setItems(visibleItems.map((item) => ({ ...item, ...(edits[item.id] || {}) })));
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  // 当前分类下可用的 subtype 列表（从实际衣物中提取，去重排序）
  const availableSubtypes = useMemo(() => {
    if (activeType === "all") return [];
    const subtypeSet = new Set();
    for (const item of items) {
      if (item.part === activeType && item.subtype) subtypeSet.add(item.subtype);
    }
    return [...subtypeSet].sort((a, b) => a.localeCompare(b, "zh-Hans"));
  }, [activeType, items]);

  const visibleItems = useMemo(() => {
    let filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    if (activeSubtype !== "all") {
      filtered = filtered.filter((item) => item.subtype === activeSubtype);
    }
    if (activeSeason !== "all") {
      filtered = filtered.filter((item) => Array.isArray(item.season) && item.season.includes(activeSeason));
    }
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, activeSubtype, activeSeason, items]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setActiveSubtype("all");
    setSelectedId(null);
  };

  const chooseSeason = (seasonId) => {
    setActiveSeason(seasonId);
    setSelectedId(null);
  };

  const saveItem = (updatedItem) => {
    setItems((current) => current.map((item) => item.id === updatedItem.id ? updatedItem : item));
    persistEdit(updatedItem);
  };

  const deleteItem = async (id) => {
    if (id.startsWith("import-")) {
      try {
        await api.delete(`/api/import/wardrobe/${id}`);
      } catch {
        // 404 is acceptable — item may already be removed server-side
      }
    } else if (id.startsWith("link-")) {
      try {
        await api.delete(`/api/wardrobe/items/${id}`);
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    }
    setItems((current) => current.filter((item) => item.id !== id));
    removePersistedEdit(id);
    persistDeletedItem(id);
    setSelectedId(null);
  };

  const toggleChecked = useCallback((id) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allVisibleSelected = useMemo(() => {
    if (!visibleItems.length) return false;
    return visibleItems.every((item) => checkedIds.has(item.id));
  }, [visibleItems, checkedIds]);

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setCheckedIds((current) => {
        const next = new Set(current);
        for (const item of visibleItems) next.delete(item.id);
        return next;
      });
    } else {
      setCheckedIds((current) => {
        const next = new Set(current);
        for (const item of visibleItems) next.add(item.id);
        return next;
      });
    }
  };

  const deleteChecked = async () => {
    const ids = [...checkedIds];
    if (!ids.length) return;
    const ok = window.confirm(T.deleteConfirm(ids.length));
    if (!ok) return;
    await Promise.all(ids.map((id) => deleteItem(id)));
    setCheckedIds(new Set());
    setManageMode(false);
  };

  const exitManageMode = () => {
    setManageMode(false);
    setCheckedIds(new Set());
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
  }, []);

  return (
    <div className={`app-shell${selectedItem ? " has-selection" : ""}${activeTab !== "wardrobe" ? " tab-active" : ""}${manageMode ? " manage-active" : ""}`}>
      {activeTab === "wardrobe" && (
        <main className="gallery-pane">
          <header className="gallery-header">
            <div className="gallery-meta-row">
              <p className="piece-count">{items.length} {items.length === 1 ? T.piece : T.pieces}</p>
              <div className="gallery-header-actions">
                <button className="link-import-trigger" type="button" onClick={() => setLinkDialogOpen(true)}>
                  {T.linkImportTab}
                </button>
                <button
                  className={`manage-toggle${manageMode ? " active" : ""}`}
                  type="button"
                  onClick={() => (manageMode ? exitManageMode() : setManageMode(true))}
                  aria-pressed={manageMode}
                >
                  {manageMode ? T.doneManaging : T.manage}
                </button>
              </div>
            </div>
            <nav className="category-nav" aria-label={T.categories.all}>
              {TYPES.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  className={activeType === type.id ? "active" : ""}
                  onClick={() => chooseType(type.id)}
                  aria-pressed={activeType === type.id}
                >
                  {type.label}
                </button>
              ))}
            </nav>
            {availableSubtypes.length > 0 && (
              <nav className="subtype-nav" aria-label={T.subtype}>
                <button
                  type="button"
                  className={activeSubtype === "all" ? "active" : ""}
                  onClick={() => { setActiveSubtype("all"); setSelectedId(null); }}
                  aria-pressed={activeSubtype === "all"}
                >
                  {T.categories.all}
                </button>
                {availableSubtypes.map((subtype) => (
                  <button
                    key={subtype}
                    type="button"
                    className={activeSubtype === subtype ? "active" : ""}
                    onClick={() => { setActiveSubtype(subtype); setSelectedId(null); }}
                    aria-pressed={activeSubtype === subtype}
                  >
                    {subtype}
                  </button>
                ))}
              </nav>
            )}
            <nav className="season-nav" aria-label={T.seasonAll}>
              {SEASONS.map((season) => (
                <button
                  key={season.id}
                  type="button"
                  className={activeSeason === season.id ? "active" : ""}
                  onClick={() => chooseSeason(season.id)}
                  aria-pressed={activeSeason === season.id}
                >
                  {season.label}
                </button>
              ))}
            </nav>
          </header>

          {error && <p className="status error">{error}</p>}
          {!error && loading && <p className="status">{T.loadingWardrobe}</p>}
          {!error && !loading && !items.length && <p className="status empty">{T.emptyWardrobe}</p>}
          {!error && !loading && !!items.length && !visibleItems.length && (
            <p className="status empty">{T.seasonUnlabeled}</p>
          )}

          {!!visibleItems.length && (
            <section className="gallery-grid" aria-label={TYPE_MAP[activeType]?.label || T.categories.all}>
              {visibleItems.map((item) => (
                <GalleryItem
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id || (manageMode && checkedIds.has(item.id))}
                  onOpen={setSelectedId}
                  manageMode={manageMode}
                  checked={checkedIds.has(item.id)}
                  onToggleCheck={toggleChecked}
                />
              ))}
            </section>
          )}
        </main>
      )}

      {manageMode && (
        <div className="manage-action-bar" role="toolbar" aria-label={T.manage}>
          <button type="button" className="select-all-toggle" onClick={toggleSelectAll}>
            {allVisibleSelected ? T.deselectAll : T.selectAll}
          </button>
          <span className="spacer" />
          <button type="button" className="cancel-manage" onClick={exitManageMode}>
            {T.doneManaging}
          </button>
          <button
            type="button"
            className="delete-selected"
            onClick={deleteChecked}
            disabled={!checkedIds.size}
          >
            <Trash size={14} weight="regular" aria-hidden="true" />
            {T.deleteSelected} ({checkedIds.size})
          </button>
        </div>
      )}

      {activeTab === "weather" && <WeatherPanel items={items} />}
      {activeTab === "inspiration" && <InspirationPanel items={items} onOpenItem={setSelectedId} />}

      {selectedItem && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} />}
      {activeTab === "wardrobe" && <WardrobeImportFlow onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} />}
      {linkDialogOpen && <LinkImportDialog onClose={() => setLinkDialogOpen(false)} onAdded={addImportedItem} />}

      <nav className="tab-bar" aria-label="导航">
        <button type="button" className={activeTab === "wardrobe" ? "active" : ""} onClick={() => setActiveTab("wardrobe")} aria-pressed={activeTab === "wardrobe"}>
          <CoatHanger size={22} weight={activeTab === "wardrobe" ? "fill" : "regular"} aria-hidden="true" />
          <span>{T.tabWardrobe}</span>
        </button>
        <button type="button" className={activeTab === "weather" ? "active" : ""} onClick={() => setActiveTab("weather")} aria-pressed={activeTab === "weather"}>
          <CloudSun size={22} weight={activeTab === "weather" ? "fill" : "regular"} aria-hidden="true" />
          <span>{T.tabWeather}</span>
        </button>
        <button type="button" className={activeTab === "inspiration" ? "active" : ""} onClick={() => setActiveTab("inspiration")} aria-pressed={activeTab === "inspiration"}>
          <Sparkle size={22} weight={activeTab === "inspiration" ? "fill" : "regular"} aria-hidden="true" />
          <span>{T.tabInspiration}</span>
        </button>
      </nav>
    </div>
  );
}
