import { useEffect, useRef, useState } from 'react';
import { createStage, type Stage } from './stage';
import type { CreatureState } from './creature';
import './styles.css';

const MOOD_TEXT: Record<CreatureState['mood'], string> = {
  idle: '它在自己待着',
  curious: '它注意到你了',
  happy: '它很享受',
  annoyed: '它有点烦了',
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const pressingRef = useRef(false);

  const [creatureState, setCreatureState] = useState<CreatureState>({
    mood: 'idle',
    bond: 0,
    irritation: 0,
    touching: false,
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    createStage(canvas)
      .then((stage) => {
        if (disposed) {
          stage.dispose();
          return;
        }
        stageRef.current = stage;
        stage.creature.onStateChange = setCreatureState;
        setCreatureState(stage.creature.getState());
        setReady(true);
      })
      .catch((e) => setError(String(e?.message ?? e)));

    return () => {
      disposed = true;
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, []);

  // Press-and-hold anywhere on the creature. Raycast decides whether the press
  // actually landed on it, so touching the floor does nothing.
  useEffect(() => {
    const toNdc = (e: PointerEvent) => ({
      x: (e.clientX / window.innerWidth) * 2 - 1,
      y: -(e.clientY / window.innerHeight) * 2 + 1,
    });

    const down = (e: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      const { x, y } = toNdc(e);
      if (!stage.raycastHit(x, y)) return;
      pressingRef.current = true;
      stage.creature.onTouchStart();
    };
    const up = () => {
      if (!pressingRef.current) return;
      pressingRef.current = false;
      stageRef.current?.creature.onTouchEnd();
    };

    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  return (
    <div className="app">
      <canvas ref={canvasRef} className="stage" />

      {!ready && !error && <div className="loading">正在唤醒…</div>}
      {error && (
        <div className="error">
          <p>模型加载失败</p>
          <code>{error}</code>
        </div>
      )}

      {ready && (
        <>
          <header className="hud-top">
            <span className="brand">L.D.C. · 3D</span>
            <span className="mood">{MOOD_TEXT[creatureState.mood]}</span>
          </header>

          <footer className="hud-bottom">
            <div className="hint">按住它试试</div>
            <div className="meters">
              <Meter label="羁绊" value={creatureState.bond} tone="bond" />
              <Meter label="烦躁" value={creatureState.irritation} tone="irritation" />
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

function Meter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`meter meter--${tone}`}>
      <span className="meter__label">{label}</span>
      <span className="meter__track">
        <span className="meter__fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
    </div>
  );
}
