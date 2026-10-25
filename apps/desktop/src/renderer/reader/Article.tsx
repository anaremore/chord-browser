/**
 * An article's content, as React elements (DESIGN.md §7.11). Main cleaned
 * it already (core's sanitizeArticle); this is the second fence: only the
 * reader's elements are made, each with only the properties listed here,
 * never markup from a string. Links go to the web or to a place in the
 * article; images load from main, by number, through the tab's session.
 */
import { READER_ANCHOR_PREFIX, READER_TAGS, type ReaderElement, type ReaderNode } from '@chord/core';
import { createElement, type ReactNode } from 'react';
import styles from './Reader.module.css';

const EMPTY = new Set(['br', 'hr', 'wbr', 'img']);

const number = (value: string | undefined) => (value !== undefined && /^-?\d+$/.test(value) ? Number(value) : undefined);

/** What an element may carry onto the page, or null if it can't be shown at all. */
function propsOf(el: ReaderElement, imageBase: string): Record<string, string | number | boolean> | null {
  const a = el.attrs ?? {};
  const props: Record<string, string | number | boolean> = {};
  if (a['id']?.startsWith(READER_ANCHOR_PREFIX)) props['id'] = a['id'];
  if (a['dir'] === 'ltr' || a['dir'] === 'rtl' || a['dir'] === 'auto') props['dir'] = a['dir'];
  if (a['lang']) props['lang'] = a['lang'];
  const set = (name: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) props[name] = value;
  };
  switch (el.tag) {
    case 'a': {
      const href = a['href'] ?? '';
      if (!href.startsWith(`#${READER_ANCHOR_PREFIX}`) && !/^https?:\/\//i.test(href)) return null;
      props['href'] = href;
      set('title', a['title']);
      break;
    }
    case 'img':
      if (!/^\d+$/.test(a['src'] ?? '')) return null;
      props['src'] = `${imageBase}${a['src']}`;
      props['alt'] = a['alt'] ?? '';
      props['loading'] = 'lazy';
      props['decoding'] = 'async';
      set('title', a['title']);
      set('width', number(a['width']));
      set('height', number(a['height']));
      break;
    case 'ol':
      set('start', number(a['start']));
      set('reversed', a['reversed'] !== undefined ? true : undefined);
      set('type', a['type']);
      break;
    case 'li':
      set('value', number(a['value']));
      break;
    case 'td':
    case 'th':
      set('colSpan', number(a['colspan']));
      set('rowSpan', number(a['rowspan']));
      if (el.tag === 'th') set('scope', a['scope']);
      break;
    case 'abbr':
    case 'dfn':
      set('title', a['title']);
      break;
    case 'time':
      set('dateTime', a['datetime']);
      break;
  }
  return props;
}

const textOf = (nodes: readonly ReaderNode[]): string => nodes.map((n) => (typeof n === 'string' ? n : textOf(n.children ?? []))).join('');

function render(node: ReaderNode, key: number, imageBase: string): ReactNode {
  if (typeof node === 'string') return node;
  if (!READER_TAGS.has(node.tag)) return null;
  const props = propsOf(node, imageBase);
  if (!props) return node.tag === 'a' ? <ArticleContent key={key} nodes={node.children ?? []} imageBase={imageBase} /> : null;
  if (EMPTY.has(node.tag)) return createElement(node.tag, { ...props, key });
  const children = (node.children ?? []).map((child, i) => render(child, i, imageBase));
  const element = createElement(node.tag, { ...props, key: node.tag === 'table' ? undefined : key }, children);
  if (node.tag !== 'table') return element;
  // A wide table scrolls sideways in a region of its own, which the keyboard can reach.
  const caption = node.children?.find((c): c is ReaderElement => typeof c !== 'string' && c.tag === 'caption');
  return (
    <div key={key} className={styles.table} role="group" tabIndex={0} aria-label={caption ? textOf(caption.children ?? []).trim() || 'Table' : 'Table'}>
      {element}
    </div>
  );
}

export function ArticleContent({ nodes, imageBase }: { nodes: readonly ReaderNode[]; imageBase: string }) {
  return <>{nodes.map((node, i) => render(node, i, imageBase))}</>;
}
