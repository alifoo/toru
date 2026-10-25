"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** Polling renews signed links; the active media source must stay fixed during playback. */
/** `videoRef` lets the run screen follow and move the playhead. */
export function RecordingPlayer({ url, poster, videoRef }: { url: string; poster?: string; videoRef?: RefObject<HTMLVideoElement | null> }) {
  const [source, setSource] = useState(url);
  const [failed, setFailed] = useState(false);
  const resume = useRef({ time: 0, playing: false, pending: false });

  useEffect(() => {
    if (failed && url !== source) {
      resume.current.pending = true;
      setSource(url);
      setFailed(false);
    }
  }, [failed, url, source]);

  return <video ref={videoRef} src={source} poster={poster} controls preload="metadata" playsInline
    onTimeUpdate={event => { if (!resume.current.pending) resume.current.time = event.currentTarget.currentTime; }}
    onPlay={() => { resume.current.playing = true; }}
    onPause={event => { if (!event.currentTarget.error && !resume.current.pending) resume.current.playing = false; }}
    onError={() => { resume.current.pending = true; setFailed(true); }}
    onLoadedMetadata={event => {
      if (!resume.current.pending) return;
      resume.current.pending = false;
      event.currentTarget.currentTime = Math.min(resume.current.time, event.currentTarget.duration || resume.current.time);
      if (resume.current.playing) void event.currentTarget.play().catch(() => undefined);
    }} />;
}
