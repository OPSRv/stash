import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

/// Fullscreen live camera preview rendered into the `camera-pip` Tauri
/// window. The window is decorations-less and always-on-top, so the view
/// here owns the whole area — border-radius gives the "circle" vs "rect"
/// treatment. SCStream excludes this window by title when recording
/// screen+cam, so it never feeds back into its own recording.
export const CameraPipWindow = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = new URLSearchParams(window.location.search);
  const labelHint = params.get('label') ?? '';
  const initialShape = params.get('shape') === 'rect' ? 'rect' : 'circle';
  const [shape, setShape] = useState<'rect' | 'circle'>(initialShape);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const unlisten = listen<{ shape?: 'rect' | 'circle' }>(
      'camera-pip:config',
      (e) => {
        if (e.payload.shape) setShape(e.payload.shape);
      }
    );
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const dismiss = async () => {
    // Tell the main window so it doesn't re-open us while the mode still
    // requests a camera preview.
    try {
      await emit('camera-pip:closed');
    } catch {
      // non-fatal — window will still close below.
    }
    invoke('cam_pip_hide').catch(() => {});
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      try {
        // Prime permissions and populate device labels.
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === 'videoinput');
        const target =
          cams.find((c) => c.label === labelHint) ?? cams[0] ?? null;
        const constraints: MediaStreamConstraints = target?.deviceId
          ? { video: { deviceId: { exact: target.deviceId } }, audio: false }
          : { video: true, audio: false };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [labelHint]);

  return (
    <div
      data-tauri-drag-region
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100vw',
        height: '100vh',
        borderRadius: shape === 'circle' ? '50%' : 12,
        overflow: 'hidden',
        background: '#000',
        position: 'relative',
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        cursor: 'grab',
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        data-tauri-drag-region
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: 'scaleX(-1)', // mirror — matches OBS preview convention
          pointerEvents: 'none',
        }}
      />
      <button
        type="button"
        aria-label="Close camera preview"
        onClick={dismiss}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.55)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          lineHeight: 1,
          cursor: 'pointer',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 120ms',
        }}
      >
        ×
      </button>
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FF9B9B',
            fontSize: 12,
            padding: 12,
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          Camera error: {error}
        </div>
      )}
    </div>
  );
};
