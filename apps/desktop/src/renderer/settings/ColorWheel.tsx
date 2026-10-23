/**
 * The ThemePicker's color wheel (DESIGN.md §7.7). Hue runs around the ring,
 * chroma outward from the gray center, drawn in the current appearance's
 * lightness band so it shows what the tint will. Up to three handles:
 * - a click on the wheel moves the nearest one there;
 * - dragging a handle off the wheel and letting go removes it;
 * - each handle is a slider: arrow keys turn its hue, Shift+arrows its
 *   chroma, Delete removes it, and screen readers hear the nearest swatch.
 */
import type { Oklch } from '@chord/core';
import { cssOklch, mapToBand, oklchToRgb, size as sizes, type Appearance } from '@chord/tokens';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import styles from './ColorWheel.module.css';
import { colorToPoint, describeColor, nearestStop, pointToColor, removesOnRelease, stepColor } from './wheel';

const SIZE = sizes.colorWheel;

/** Paints the wheel once per appearance, at the display's pixel density. */
function paint(canvas: HTMLCanvasElement, mode: Appearance): void {
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(SIZE * dpr);
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(px, px);
  const radius = px / 2;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const { color, distance } = pointToColor((x + 0.5) / dpr, (y + 0.5) / dpr, SIZE);
      // A one-pixel soft edge instead of jaggies.
      const alpha = Math.min(1, Math.max(0, (1 - distance) * radius + 0.5));
      if (alpha === 0) continue;
      const rgb = oklchToRgb(mapToBand(color, mode));
      const i = (y * px + x) * 4;
      image.data[i] = Math.round(rgb.r * 255);
      image.data[i + 1] = Math.round(rgb.g * 255);
      image.data[i + 2] = Math.round(rgb.b * 255);
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
}

export function ColorWheel({
  stops,
  active,
  mode,
  onSelect,
  onChange,
}: {
  stops: Oklch[];
  active: number;
  mode: Appearance;
  onSelect(index: number): void;
  /** New colors, and which one is selected now. */
  onChange(stops: Oklch[], active: number): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const handles = useRef<(HTMLButtonElement | null)[]>([]);
  const [drag, setDrag] = useState<{ index: number; leaving: boolean; point: { x: number; y: number } | null } | null>(null);

  useEffect(() => {
    if (canvas.current) paint(canvas.current, mode);
  }, [mode]);

  const local = (event: PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  const moveTo = (index: number, x: number, y: number) => {
    const { color, distance } = pointToColor(x, y, SIZE);
    const leaving = removesOnRelease(distance, stops.length);
    setDrag({ index, leaving, point: leaving ? { x, y } : null });
    // Off the wheel, the color stays where it last was until you let go (and it's removed).
    if (!leaving) onChange(stops.map((s, i) => (i === index ? color : s)), index);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const { x, y } = local(event);
    const onHandle = (event.target as HTMLElement).closest('[role="slider"]');
    const index = onHandle ? Number(onHandle.getAttribute('data-index')) : nearestStop(x, y, stops, SIZE);
    if (!onHandle && pointToColor(x, y, SIZE).distance > 1) return;
    event.preventDefault();
    area.current!.setPointerCapture(event.pointerId);
    onSelect(index);
    handles.current[index]?.focus();
    // A click on the wheel takes the nearest handle there; a handle just picks up.
    if (onHandle) setDrag({ index, leaving: false, point: null });
    else moveTo(index, x, y);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { x, y } = local(event);
    moveTo(drag.index, x, y);
  };
  const onPointerUp = () => {
    if (!drag) return;
    if (drag.leaving) {
      const next = stops.filter((_, i) => i !== drag.index);
      onChange(next, Math.min(active, next.length - 1));
    }
    setDrag(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && stops.length > 1) {
      event.preventDefault();
      const next = stops.filter((_, i) => i !== index);
      onChange(next, Math.min(index, next.length - 1));
      return;
    }
    const color = stepColor(stops[index]!, event.key, event.shiftKey);
    if (!color) return;
    event.preventDefault();
    onChange(
      stops.map((s, i) => (i === index ? color : s)),
      index,
    );
  };

  return (
    <div
      ref={area}
      className={styles.wheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <canvas ref={canvas} className={styles.canvas} aria-hidden />
      {stops.map((stop, index) => {
        const leaving = drag?.index === index && drag.leaving;
        const p = leaving && drag.point ? drag.point : colorToPoint(stop, SIZE);
        return (
          <button
            key={index}
            ref={(el) => {
              handles.current[index] = el;
            }}
            type="button"
            role="slider"
            data-index={index}
            data-selected={index === active || undefined}
            data-leaving={leaving || undefined}
            aria-label={`Color ${index + 1}`}
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={Math.round(stop.h)}
            aria-valuetext={describeColor(stop)}
            title={describeColor(stop)}
            className={styles.handle}
            style={{ transform: `translate(${p.x}px, ${p.y}px)`, backgroundColor: cssOklch(mapToBand(stop, mode)) }}
            onFocus={() => onSelect(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
          />
        );
      })}
    </div>
  );
}
