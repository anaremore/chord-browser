import { siteColors, type Appearance } from '@chord/tokens';
import { useState, type CSSProperties } from 'react';
import styles from './Favicon.module.css';
import { displayHost, monogram, siteHue } from './site';

interface Props {
  url: string;
  title: string;
  favicon: string | null;
  loading?: boolean;
  appearance: Appearance;
}

/** Icons whose visible pixels are mostly dark, measured once per icon. */
const darkIcons = new Map<string, boolean>();

function measureDark(img: HTMLImageElement): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, 16, 16);
  const { data } = ctx.getImageData(0, 0, 16, 16);
  let lum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a < 0.2) continue;
    lum += ((0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255) * a;
    weight += a;
  }
  return weight > 8 && lum / weight < 0.28;
}

/**
 * A site's icon, a monogram when it has none, or a spinner while it loads
 * (DESIGN.md §7.4). Dark icons (GitHub's, for one) get a soft light backing on
 * dark themes so they don't disappear.
 */
export function Favicon({ url, title, favicon, loading = false, appearance }: Props) {
  const [dark, setDark] = useState(() => (favicon ? (darkIcons.get(favicon) ?? false) : false));
  if (loading) return <span className={styles.spinner} aria-hidden />;
  if (favicon) {
    const plated = appearance === 'dark' && dark;
    return (
      <span className={`${styles.frame} ${plated ? styles.plate : ''}`}>
        <img
          className={styles.icon}
          src={favicon}
          alt=""
          draggable={false}
          onLoad={(e) => {
            if (darkIcons.has(favicon)) return;
            const isDark = measureDark(e.currentTarget);
            darkIcons.set(favicon, isDark);
            if (isDark) setDark(true);
          }}
        />
      </span>
    );
  }
  const host = displayHost(url);
  const colors = siteColors(siteHue(host), appearance);
  const style = { '--monogram-bg': colors.background, '--monogram-fg': colors.foreground } as CSSProperties;
  return (
    <span className={styles.monogram} style={style} aria-hidden>
      {monogram(host, title)}
    </span>
  );
}
