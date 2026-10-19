import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CloudSun, MapPin, MagnifyingGlass, Sparkle, SpinnerGap } from "@phosphor-icons/react";
import { T } from "./i18n.js";
import { api, assetUrl } from "./api.js";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { recommendOutfit } from "./recommender.js";

const CITY_KEY = "wardrobe-weather-city";

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

export function WeatherPanel({ items }) {
  const [weather, setWeather] = useState(null);
  const [city, setCity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [cityResults, setCityResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [lookImage, setLookImage] = useState(null);
  const [genError, setGenError] = useState("");
  const tryonStageText = useStageText(generating, T.tryonStages);

  const fetchWeather = useCallback(async (lat, lon, cityName) => {
    setLoading(true); setError("");
    try {
      const data = await api.get(`/api/weather?lat=${lat}&lon=${lon}`);
      setWeather(data);
      if (cityName) {
        const c = { name: cityName, lat, lon };
        setCity(c);
        localStorage.setItem(CITY_KEY, JSON.stringify(c));
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(CITY_KEY);
    if (saved) {
      try {
        const c = JSON.parse(saved);
        fetchWeather(c.lat, c.lon, c.name);
        return;
      } catch {}
    }
    if (!navigator.geolocation) {
      setError(T.locationDenied);
      setLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => fetchWeather(pos.coords.latitude, pos.coords.longitude, null),
      () => { setError(T.locationDenied); setLoading(false); },
      { timeout: 10000 },
    );
  }, [fetchWeather]);

  const searchCities = async () => {
    if (!searchQ.trim()) return;
    setSearching(true); setError("");
    try {
      const results = await api.get(`/api/weather/cities?q=${encodeURIComponent(searchQ.trim())}`);
      setCityResults(Array.isArray(results) ? results : results.cities || []);
    } catch (e) { setError(e.message); }
    finally { setSearching(false); }
  };

  const pickCity = (c) => {
    setCityResults([]); setSearchQ("");
    fetchWeather(c.lat, c.lon, c.name);
  };

  const outfit = useMemo(() => {
    if (!weather) return null;
    return recommendOutfit(items, weather, rotation);
  }, [items, weather, rotation]);

  const refreshOutfit = () => setRotation((r) => r + 1);

  const generateLook = async () => {
    if (!outfit?.complete) return;
    setGenerating(true); setGenError(""); setLookImage(null);
    try {
      const garmentIds = Object.values(outfit.slots || {}).map((piece) => piece?.id).filter(Boolean);
      const weatherDesc = [city?.name || weather.city, weather.text, weather.temp != null ? `${weather.temp}°C` : ""]
        .filter(Boolean)
        .join("，");
      const result = await api.post("/api/looks/generate", {
        type: "daily",
        garmentIds,
        prompt: weatherDesc ? `今日天气：${weatherDesc}` : "",
      });
      setLookImage(result.image || result.lookImage || result.url);
    } catch (e) { setGenError(e.message); }
    finally { setGenerating(false); }
  };

  const missingLabels = outfit?.missing?.map((m) => SLOT_LABELS[m] || m) || [];

  return (
    <main className="weather-panel">
      <header className="weather-header">
        <div className="weather-meta-row">
          <CloudSun size={28} weight="light" aria-hidden="true" />
          <h2>{T.tabWeather}</h2>
        </div>
      </header>

      {loading && <p className="status">{T.locating}</p>}
      {error && !loading && (
        <div className="weather-search">
          <p className="status error">{error}</p>
          <div className="weather-search-row">
            <input
              value={searchQ}
              onChange={(event) => setSearchQ(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") searchCities(); }}
              placeholder={T.searchCityPlaceholder}
              aria-label={T.searchCity}
            />
            <button type="button" onClick={searchCities} disabled={searching}>
              {searching ? <SpinnerGap size={18} className="import-spinner" /> : <MagnifyingGlass size={18} />}
            </button>
          </div>
          {!!cityResults.length && (
            <ul className="city-results">
              {cityResults.map((c) => (
                <li key={`${c.lat}-${c.lon}`}>
                  <button type="button" onClick={() => pickCity(c)}>
                    <MapPin size={16} weight="regular" /> {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {weather && !loading && (
        <div className="weather-card">
          <div className="weather-city">{city?.name || weather.city || T.tabWeather}</div>
          <div className="weather-temp">{weather.temp ?? weather.temperature ?? "--"}°</div>
          <div className="weather-detail-grid">
            <span><small>{T.feelsLike}</small> {weather.feelsLike ?? weather.temp ?? "--"}°</span>
            <span><small>{T.wind}</small> {weather.wind ?? "--"}</span>
            <span><small>{T.todayHigh}</small> {weather.tempMax ?? "--"}°</span>
            <span><small>{T.todayLow}</small> {weather.tempMin ?? "--"}°</span>
          </div>
          <div className="weather-condition">{weather.text || weather.condition || ""}</div>
        </div>
      )}

      {weather && !loading && outfit && (
        <div className="outfit-card">
          <div className="outfit-card-header">
            <h3>{T.outfitRecommend}</h3>
            <button type="button" onClick={refreshOutfit} className="outfit-refresh">
              <ArrowsClockwise size={18} /> {T.refreshOutfit}
            </button>
          </div>

          {outfit.reasons?.length > 0 && (
            <ul className="outfit-reasons">
              {outfit.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
            </ul>
          )}

          {!outfit.complete && (
            <p className="status error">{T.noOutfitReason}：{missingLabels.join("、")}</p>
          )}

          <div className="outfit-slots">
            {["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"].map((slot) => {
              const piece = outfit.slots?.[slot];
              if (!piece) return null;
              return (
                <div className="outfit-slot" key={slot}>
                  <OptimizedImage
                    src={assetUrl(piece.thumbnail || piece.image)}
                    alt={piece.name || SLOT_LABELS[slot]}
                    sizes="(max-width: 520px) 25vw, 120px"
                    breakpoints={[80, 120, 160, 240]}
                  />
                  <span className="outfit-slot-label">{SLOT_LABELS[slot]}</span>
                  <span className="outfit-slot-name">{piece.name || SLOT_LABELS[slot]}</span>
                </div>
              );
            })}
          </div>

          <div className="outfit-actions">
            <button
              type="button"
              className="primary-button"
              onClick={generateLook}
              disabled={!outfit.complete || generating}
            >
              {generating ? <SpinnerGap size={15} className="import-spinner" /> : <Sparkle size={15} />}
              {generating ? tryonStageText || T.analyzing : T.generateTryon}
            </button>
          </div>

          {genError && <p className="status error">{genError}</p>}
          {lookImage && (
            <div className="look-preview">
              <img src={assetUrl(lookImage)} alt={T.generateTryon} />
            </div>
          )}
        </div>
      )}
    </main>
  );
}
