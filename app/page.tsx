"use client";

import { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_STUDIO_API_URL ?? "http://127.0.0.1:8787";

type Generation = {
  id: string;
  prompt: string;
  createdAt: string;
  duration: number;
  width: number;
  height: number;
  seed: number;
  referenceUsed: boolean;
  cached?: boolean;
  url: string;
  thumbnailUrl?: string;
};

type ChatItem =
  | { id: string; role: "user"; prompt: string; referenceName?: string }
  | { id: string; role: "assistant"; generation: Generation }
  | { id: string; role: "error"; text: string };

type ModelStatus = {
  serverOnline: boolean;
  connected: boolean;
  loaded: boolean;
  model: string | null;
  modelState: string;
  bytesResident: number;
};

const FORMATS = [
  { value: "864x480", label: "864 × 480", shape: "LANDSCAPE" },
  { value: "480x864", label: "480 × 864", shape: "PORTRAIT" },
  { value: "1024x576", label: "1024 × 576", shape: "16:9" },
  { value: "576x1024", label: "576 × 1024", shape: "9:16" },
  { value: "1280x704", label: "1280 × 704", shape: "WIDE HD" },
  { value: "704x1280", label: "704 × 1280", shape: "TALL HD" },
  { value: "640x480", label: "640 × 480", shape: "4:3" },
] as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function absolutize(path: string) {
  return path.startsWith("http") ? path : `${API_URL}${path}`;
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("864x480");
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 10_000_000));
  const [useCache, setUseCache] = useState(true);
  const [reference, setReference] = useState<{ name: string; dataUrl: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [history, setHistory] = useState<Generation[]>([]);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);

  async function refreshModelStatus() {
    const response = await fetch(`${API_URL}/api/health`);
    const health: ModelStatus = await response.json();
    setModelStatus(health);
    setConnected(Boolean(health.connected));
    return health;
  }

  useEffect(() => {
    Promise.all([
      refreshModelStatus(),
      fetch(`${API_URL}/api/generations`).then((response) => response.json()),
    ])
      .then(([, saved]) => {
        setHistory(saved.generations ?? []);
      })
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => {
    if (!generating) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, generating]);

  const stage = useMemo(() => {
    if (elapsed < 20) return "Encoding your direction";
    if (elapsed < 90) return "Diffusing picture and sound";
    if (elapsed < 180) return "Resolving motion and detail";
    return "Finishing the local render";
  }, [elapsed]);

  const selectedFormat = FORMATS.find((format) => format.value === resolution) ?? FORMATS[0];
  const [width, height] = resolution.split("x").map(Number);

  function acceptFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setChat((items) => [...items, { id: crypto.randomUUID(), role: "error", text: "Please choose a PNG, JPEG, or WebP image." }]);
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setChat((items) => [...items, { id: crypto.randomUUID(), role: "error", text: "Reference images must be smaller than 15 MB." }]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setReference({ name: file.name, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  }

  function onDragEnter(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    acceptFile(event.dataTransfer.files[0]);
  }

  async function generate(event?: FormEvent) {
    event?.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || generating) return;

    setGenerating(true);
    setElapsed(0);
    setChat((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", prompt: cleanPrompt, referenceName: reference?.name },
    ]);

    try {
      const response = await fetch(`${API_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleanPrompt,
          duration,
          seed,
          useCache,
          referenceImage: reference?.dataUrl ?? null,
          width,
          height,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Generation failed");

      const generation: Generation = payload.generation;
      setChat((items) => [...items, { id: crypto.randomUUID(), role: "assistant", generation }]);
      setHistory((items) => [generation, ...items.filter((item) => item.id !== generation.id)]);
      setSeed(Math.floor(Math.random() * 10_000_000));
    } catch (error) {
      setChat((items) => [
        ...items,
        { id: crypto.randomUUID(), role: "error", text: error instanceof Error ? error.message : "Generation failed" },
      ]);
      setConnected(false);
    } finally {
      setGenerating(false);
    }
  }

  function onPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void generate();
    }
  }

  async function toggleModel() {
    if (!modelStatus?.serverOnline || modelBusy || generating) return;
    const shouldLoad = !modelStatus.loaded;
    setModelBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/model/${shouldLoad ? "load" : "unload"}`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not change model memory state");
      setModelStatus(payload);
      setConnected(Boolean(payload.connected));
    } catch (error) {
      setChat((items) => [
        ...items,
        { id: crypto.randomUUID(), role: "error", text: error instanceof Error ? error.message : "Could not change model memory state" },
      ]);
      await refreshModelStatus().catch(() => setConnected(false));
    } finally {
      setModelBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">H3</div>
          <div>
            <p className="eyebrow">LOCAL VIDEO LAB</p>
            <h1>MiniMax Studio</h1>
          </div>
        </div>
        <div className="model-controls">
          <div className={`connection ${connected ? "online" : connected === false ? "offline" : "checking"}`}>
            <span className="connection-dot" />
            {modelBusy
              ? modelStatus?.loaded ? "Unloading model" : "Loading model"
              : modelStatus?.serverOnline && !modelStatus.loaded
                ? "Model unloaded"
                : connected ? "Model ready" : connected === false ? "Server offline" : "Checking model"}
          </div>
          <button
            className="model-toggle"
            type="button"
            onClick={toggleModel}
            disabled={!modelStatus?.serverOnline || modelBusy || generating}
            title={modelStatus?.loaded ? "Unload the model and release unified memory" : "Load the model into unified memory"}
          >
            {modelBusy ? "Please wait…" : modelStatus?.loaded ? "Unload model" : "Load model"}
          </button>
        </div>
      </header>

      <section className="studio-grid">
        <div className="conversation-panel">
          <div className="conversation-head">
            <div>
              <p className="eyebrow">PROMPT CONSOLE</p>
              <h2>Direct the next shot.</h2>
            </div>
            <label className="format-picker">
              <span className="sr-only">Generation resolution</span>
              <select value={resolution} onChange={(event) => setResolution(event.target.value)} disabled={generating}>
                {FORMATS.map((format) => (
                  <option value={format.value} key={format.value}>{format.label} · {format.shape}</option>
                ))}
              </select>
              <span className="format-chevron">⌄</span>
            </label>
          </div>

          <div className="conversation" aria-live="polite">
            {chat.length === 0 && (
              <div className="welcome-card">
                <p className="welcome-index">01</p>
                <h3>Describe motion, camera, dialogue, and sound.</h3>
                <p>
                  Generate from text alone, or drop in a reference image to anchor the first frame. Identical requests can reuse your local cache.
                </p>
                <div className="prompt-suggestion">
                  <span>Try</span>
                  A slow tracking shot through a neon-lit Toronto alley after rain, cinematic reflections, distant traffic and footsteps.
                </div>
              </div>
            )}

            {chat.map((item) => {
              if (item.role === "user") {
                return (
                  <article className="message user-message" key={item.id}>
                    <p className="message-label">YOU</p>
                    <p>{item.prompt}</p>
                    {item.referenceName && <span className="reference-label">Reference · {item.referenceName}</span>}
                  </article>
                );
              }
              if (item.role === "error") {
                return <article className="message error-message" key={item.id}>{item.text}</article>;
              }
              const videoUrl = absolutize(item.generation.url);
              return (
                <article className="message result-message" key={item.id}>
                  <div className="result-meta">
                    <div>
                      <p className="message-label">MINIMAX H3</p>
                      <p>{item.generation.cached ? "Loaded from local cache" : "Generation complete"}</p>
                    </div>
                    <span>{item.generation.duration}s · seed {item.generation.seed}</span>
                  </div>
                  {/* Generated media does not include a timed-text sidecar. */}
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video controls playsInline preload="metadata" src={videoUrl} aria-label="Generated MiniMax video" />
                  <a className="download-link" href={videoUrl} download>
                    Download MP4 <span>↓</span>
                  </a>
                </article>
              );
            })}

            {generating && (
              <article className="message generation-state">
                <div className="pulse-orbit"><span /></div>
                <div>
                  <p className="message-label">RENDERING LOCALLY · {selectedFormat.label} · {elapsed}s</p>
                  <h3>{stage}</h3>
                  <p>Keep this tab open. H3 generations can take several minutes.</p>
                </div>
              </article>
            )}
            <div ref={chatEndRef} />
          </div>

          <form
            className={`composer ${dragging ? "dragging" : ""}`}
            onSubmit={generate}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {dragging && (
              <div className="drop-overlay" aria-hidden="true">
                <span className="plus">+</span>
                <strong>Drop reference image</strong>
                <small>It will anchor the first frame</small>
              </div>
            )}
            {reference && (
              <div className="reference-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={reference.dataUrl} alt="Selected reference" />
                <div><strong>{reference.name}</strong><span>First-frame reference</span></div>
                <button type="button" onClick={() => setReference(null)} aria-label="Remove reference image">×</button>
              </div>
            )}

            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={onPromptKeyDown}
              placeholder="Describe the scene, camera movement, action, dialogue, and sound…"
              rows={4}
              aria-label="Video prompt"
            />

            <div className="composer-tools">
              <button
                className={`drop-button ${dragging ? "dragging" : ""}`}
                type="button"
                onClick={() => inputRef.current?.click()}
              >
                <span className="plus">+</span> Reference image
              </button>
              <input
                ref={inputRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event: ChangeEvent<HTMLInputElement>) => acceptFile(event.target.files?.[0])}
              />

              <label className="compact-field">
                <span>Length</span>
                <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                  <option value={5}>5 sec</option>
                  <option value={10}>10 sec</option>
                </select>
              </label>

              <label className="compact-field seed-field">
                <span>Seed</span>
                <input type="number" min={0} max={2147483647} value={seed} onChange={(event) => setSeed(Number(event.target.value))} />
              </label>

              <label className="cache-toggle">
                <input type="checkbox" checked={useCache} onChange={(event) => setUseCache(event.target.checked)} />
                <span className="toggle-track"><span /></span>
                Cache
              </label>

              <button className="generate-button" type="submit" disabled={!prompt.trim() || generating || connected === false}>
                {generating ? "Rendering…" : "Generate"} <span>↗</span>
              </button>
            </div>
            <p className="shortcut">Drop an image anywhere in this box · ⌘ Enter to generate · Prompts and files stay on localhost</p>
          </form>
        </div>

        <aside className="history-panel">
          <div className="history-head">
            <div>
              <p className="eyebrow">LOCAL ARCHIVE</p>
              <h2>Generations</h2>
            </div>
            <span>{history.length}</span>
          </div>

          <div className="history-list">
            {history.length === 0 ? (
              <div className="empty-history"><span>◌</span><p>Your finished shots will collect here.</p></div>
            ) : history.map((item) => (
              <article className="history-card" key={item.id}>
                <div className="history-media">
                  {item.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={absolutize(item.thumbnailUrl)} alt="" />
                  ) : <div className="history-placeholder" />}
                  <a href={absolutize(item.url)} target="_blank" rel="noreferrer" aria-label="Open generated video">▶</a>
                  {item.cached && <span className="cached-badge">CACHED</span>}
                </div>
                <p>{item.prompt}</p>
                <div className="history-meta">
                  <span>{formatDate(item.createdAt)}</span>
                  <span>{item.duration}s · {item.width}×{item.height}</span>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
