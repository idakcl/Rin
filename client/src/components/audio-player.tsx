import React, { useEffect, useRef, useState } from "react";

type AudioPlayerProps = {
  src?: string;
  autoplay?: boolean;
  loop?: boolean;
  name?: string;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function basenameFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const cleaned = url.split("#")[0].split("?")[0];
    const last = cleaned.split("/").pop() || "";
    const decoded = (() => {
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    })();
    const withoutExt = decoded.replace(/\.[^./]+$/, "");
    return withoutExt || undefined;
  } catch {
    return undefined;
  }
}

export function AudioPlayer({ src, autoplay = false, loop = false, name }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrentTime(a.currentTime);
    const onMeta = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnd = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnd);
    };
  }, [src]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play().catch(() => {
        // Autoplay blocked or other play error — UI will reflect paused state.
      });
    } else {
      a.pause();
    }
  };

  const onSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    const bar = progressRef.current;
    if (!a || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
  };

  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const displayName = name?.trim() || basenameFromUrl(src);

  return (
    <div className="rin-audio-player my-3 rounded-xl border border-black/10 bg-black/[0.03] p-3 dark:border-white/10 dark:bg-white/[0.05]">
      {displayName && (
        <div
          className="rin-audio-name mb-2 flex items-center gap-1 truncate text-sm font-medium text-neutral-800 dark:text-neutral-200"
          title={displayName}
        >
          <i className="ri-music-2-line shrink-0" aria-hidden="true" />
          <span className="truncate">{displayName}</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "暂停" : "播放"}
          className="rin-audio-play inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-theme text-white transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme"
        >
          <i className={`text-lg ${playing ? "ri-pause-fill" : "ri-play-fill"}`} aria-hidden="true" />
        </button>
        <div
          ref={progressRef}
          onClick={onSeek}
          className="rin-audio-progress relative h-1.5 min-w-[60px] flex-1 cursor-pointer rounded-full bg-black/10 dark:bg-white/15"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={duration || 0}
          aria-valuenow={currentTime}
          aria-label="播放进度"
        >
          <div
            className="rin-audio-bar absolute left-0 top-0 h-full rounded-full bg-theme"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="rin-audio-time shrink-0 font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
      <audio
        ref={audioRef}
        src={src}
        autoPlay={autoplay || undefined}
        loop={loop || undefined}
        preload="metadata"
        className="hidden"
      />
    </div>
  );
}
