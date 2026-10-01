import { useEffect, useRef, useState } from 'react';
import { createStage, type Stage } from './stage';
import type { CreatureState } from './creature';
import { FOODS, type FoodKind } from './food';
import './styles.css';

const MOOD_TEXT: Record<CreatureState['mood'], string> = {
  idle: '它在自己待着',
  curious: '它注意到你了',
  happy: '它很享受',
  annoyed: '它有点烦了',
  eating: '它在吃',
  disgusted: '它不太喜欢这个',
};

const REACTION: Record<FoodKind, string> = {
  meat: '一口吞了',
  sausage: '吃得很香',
  bone: '啃得起劲',
  cheese: '很喜欢',
  kibble: '老老实实吃了',
  carrot: '勉强吃了几口',
  apple: '闻了闻，吃了',
  broccoli: '一脸嫌弃地走开了',
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const pressingCreature = useRef(false);

  const [state, setState] = useState<CreatureState>({
    mood: 'idle',
    bond: 0,
    irritation: 0,
    touching: false,
    sated: 0.25,
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [held, setHeld] = useState<FoodKind | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let toastTimer = 0;

    createStage(canvas, {
      onPickup: (kind) => setHeld(kind),
      onFed: (kind) => {
        setHeld(null);
        setToast(REACTION[kind]);
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => setToast(null), 2000);
      },
    })
      .then((stage) => {
        if (disposed) {
          stage.dispose();
          return;
        }
        stageRef.current = stage;
        stage.creature.onStateChange = setState;
        setState(stage.creature.getState());
        setReady(true);
      })
      .catch((e) => setError(String(e?.message ?? e)));

    return () => {
      disposed = true;
      window.clearTimeout(toastTimer);
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, []);

  // One pointer pipeline serves both gestures: dragging food wins, otherwise a
  // press that lands on the dog is a pet.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      // A press that lands on food owns the whole gesture. While a drag is in
      // progress the creature must not read pointer movement as petting, or
      // dragging food across the dog makes it think it is being poked and it
      // walks off to the side.
      if (stage.feeding.beginDrag(e.clientX, e.clientY, stage.camera)) return;
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      if (stage.raycastHit(nx, ny)) {
        pressingCreature.current = true;
        stage.creature.onTouchStart();
      }
    };
    const move = (e: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      stage.feeding.moveDrag(e.clientX, e.clientY, stage.camera);
    };
    const up = () => {
      const stage = stageRef.current;
      if (!stage) return;
      if (stage.feeding.isDragging || stage.feeding.ownsGesture) {
        stage.feeding.endDrag();
        setHeld(null);
        // A creature press that never started must not be left latched.
        if (pressingCreature.current) {
          pressingCreature.current = false;
          stage.creature.onTouchEnd();
        }
        return;
      }
      if (pressingCreature.current) {
        pressingCreature.current = false;
        stage.creature.onTouchEnd();
      }
    };

    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
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
          <p>加载失败</p>
          <code>{error}</code>
        </div>
      )}

      {ready && (
        <>
          <header className="hud-top">
            <span className="brand">L.D.C. · 3D</span>
            <span className="mood">{MOOD_TEXT[state.mood]}</span>
          </header>

          {toast && <div className="toast">{toast}</div>}

          <footer className="hud-bottom">
            <div className="hint">
              {held ? '拖到它嘴边松开' : '按住它试试 · 或者把食物拖给它'}
            </div>
            <div className="meters">
              <Meter label="羁绊" value={state.bond} tone="bond" />
              <Meter label="饱食" value={state.sated} tone="sated" />
              <Meter label="烦躁" value={state.irritation} tone="irritation" />
            </div>
          </footer>

          <div className="pantry">
            {FOODS.map((f) => (
              <span
                key={f.kind}
                className={`pantry__item${held === f.kind ? ' is-held' : ''}`}
              >
                {f.name}
              </span>
            ))}
          </div>
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
