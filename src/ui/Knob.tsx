import { useCallback, useEffect, useRef } from 'react';
import { formatValue, map, unmap, type ControlSpec } from '../runtime/specs';

interface KnobProps {
  label: string;
  value: number;
  spec: ControlSpec;
  defaultValue?: number;
  size?: number;
  accent?: string;
  modulated?: boolean;
  title?: string;
  onChange: (v: number) => void;
  onCommit?: () => void;
  /** On the Performance Panel (shows a filled ☆); with onPin the ☆ toggles it. */
  pinned?: boolean;
  onPin?: () => void;
}

const START = -135;
const END = 135;

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

/** A knob: drag vertically (shift for fine), wheel, double-click to reset. */
export function Knob({ label, value, spec, defaultValue, size = 56, accent = 'var(--accent)', modulated, title, onChange, onCommit, pinned, onPin }: KnobProps) {
  const pos = unmap(spec, value);
  const drag = useRef<{ y: number; pos: number } | null>(null);

  const setPos = useCallback((p: number) => onChange(map(spec, Math.min(1, Math.max(0, p)))), [onChange, spec]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, pos };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const scale = e.shiftKey ? 800 : 180;
    setPos(drag.current.pos + (drag.current.y - e.clientY) / scale);
  };
  const onPointerUp = () => {
    if (drag.current) onCommit?.();
    drag.current = null;
  };
  // React's wheel listeners are passive; a native one can stop the page scrolling.
  const svgRef = useRef<SVGSVGElement>(null);
  const wheelState = useRef({ pos, setPos });
  wheelState.current = { pos, setPos };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = wheelState.current;
      s.setPos(s.pos - e.deltaY / (e.shiftKey ? 3000 : 800));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const onDoubleClick = () => {
    if (defaultValue !== undefined) {
      onChange(defaultValue);
      onCommit?.();
    }
  };

  const c = size / 2;
  const r = size / 2 - 5;
  const angle = START + (END - START) * pos;
  const [px, py] = polar(c, c, r - 7, angle);
  const bipolar = spec.min < 0 && spec.max > 0 && spec.warp === 'lin';
  const zero = bipolar ? START + (END - START) * unmap(spec, 0) : START;
  const valueArc = angle >= zero ? arc(c, c, r, zero, Math.max(angle, zero + 0.01)) : arc(c, c, r, angle, zero);

  return (
    <div className={`knob${pinned ? ' pinned' : ''}`} title={title ?? label} style={{ width: Math.max(size + 20, 68) }}>
      {onPin && (
        <button className="pin" title={pinned ? 'take off the Performance Panel' : 'put on the Performance Panel'} onClick={onPin}>
          {pinned ? '★' : '☆'}
        </button>
      )}
      <svg
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        ref={svgRef}
        onDoubleClick={onDoubleClick}
        role="slider"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
      >
        <path d={arc(c, c, r, START, END)} className="knob-track" />
        <path d={valueArc} className="knob-value" style={{ stroke: accent }} />
        <circle cx={c} cy={c} r={r - 9} className="knob-body" />
        <line x1={c} y1={c} x2={px} y2={py} className="knob-pointer" />
        {modulated && <circle cx={c} cy={c - r + 1} r={2.5} className="knob-mod" style={{ fill: accent }} />}
      </svg>
      {/* Two lines inside the knob's own width (underscores read as spaces), so long names never run into the next knob. */}
      <div className="knob-label">
        <span>{label.replace(/_/g, ' ')}</span>
      </div>
      <div className="knob-readout">{formatValue(spec, value)}</div>
    </div>
  );
}
