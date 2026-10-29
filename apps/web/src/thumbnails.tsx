import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

/** Most page thumbnails kept in memory; those on screen are never dropped. */
const MAX_THUMBNAILS = 160;

/**
 * Page thumbnails, rendered one at a time so they never starve the main
 * page, and kept outside React state so a finished thumbnail only redraws
 * itself rather than the whole editor.
 */
export class ThumbnailStore {
  private urls = new Map<number, string>();
  private mounted = new Map<number, number>();
  private pending = new Set<number>();
  private listeners = new Set<() => void>();
  private running = false;
  private generation = 0;
  /** Renders a source page as a small PNG; set by the editor for the open document. */
  render: ((source: number) => Promise<Uint8Array> | null) | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = (source: number) => this.urls.get(source);
  get size() {
    return this.urls.size;
  }

  mount(source: number) {
    this.mounted.set(source, (this.mounted.get(source) ?? 0) + 1);
    return () => {
      const count = (this.mounted.get(source) ?? 1) - 1;
      if (count) this.mounted.set(source, count);
      else this.mounted.delete(source);
    };
  }

  request(source: number) {
    if (this.urls.has(source)) return;
    this.pending.add(source);
    if (!this.running) void this.pump();
  }

  /** Forgets every thumbnail, for a different or changed document. */
  reset() {
    this.generation += 1;
    this.pending.clear();
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls = new Map();
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private async pump() {
    this.running = true;
    while (this.pending.size) {
      // The most recently requested pages are the ones the user is looking at.
      const next = [...this.pending].pop()!;
      this.pending.delete(next);
      if (this.urls.has(next) || !this.mounted.has(next)) continue;
      const generation = this.generation;
      try {
        const png = await this.render?.(next);
        if (!png || generation !== this.generation) continue;
        const copy = new Uint8Array(png.byteLength);
        copy.set(png);
        this.urls.set(next, URL.createObjectURL(new Blob([copy.buffer], { type: "image/png" })));
        this.evict();
        this.emit();
      } catch {
        break;
      }
    }
    this.running = false;
  }

  private evict() {
    for (const [source, url] of this.urls) {
      if (this.urls.size <= MAX_THUMBNAILS) break;
      if (this.mounted.has(source)) continue;
      URL.revokeObjectURL(url);
      this.urls.delete(source);
    }
  }
}

export function Thumbnail({ store, source, rotation }: { store: ThumbnailStore; source: number; rotation: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const url = useSyncExternalStore(store.subscribe, () => store.get(source));
  useEffect(() => store.mount(source), [store, source]);
  useEffect(() => {
    if (url || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) store.request(source);
      },
      { rootMargin: "200px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [store, source, url]);
  return (
    <div ref={ref} className="thumbPreview">
      {url ? <img src={url} alt="" draggable={false} style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined }} /> : <span className="thumbLoading" />}
    </div>
  );
}

const scrollerOf = (element: HTMLElement) => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
};

/**
 * Renders only the items of a long list or grid that are near the visible
 * part of its scrolling container. Items must all be the same height.
 */
function useWindowedItems(count: number, { minColumnWidth = 0, gap = 0, estimate = 200, overscan = 2 } = {}) {
  const list = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ columns: 1, rowHeight: estimate, firstRow: 0, lastRow: 7 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const measure = useCallback(() => {
    const element = list.current;
    const scroller = element && scrollerOf(element);
    if (!element || !scroller) return;
    const width = element.clientWidth;
    const columns = minColumnWidth ? Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))) : 1;
    const item = element.firstElementChild as HTMLElement | null;
    const rowHeight = item?.offsetHeight ? item.offsetHeight + gap : viewRef.current.rowHeight;
    const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const from = scroller.scrollTop - top;
    const firstRow = Math.max(0, Math.floor(from / rowHeight) - overscan);
    const lastRow = Math.max(firstRow, Math.ceil((from + scroller.clientHeight) / rowHeight) + overscan);
    setView((current) =>
      current.columns === columns && current.rowHeight === rowHeight && current.firstRow === firstRow && current.lastRow === lastRow ? current : { columns, rowHeight, firstRow, lastRow },
    );
  }, [gap, minColumnWidth, overscan]);

  useEffect(() => {
    const element = list.current;
    const scroller = element && scrollerOf(element);
    if (!element || !scroller) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [measure]);
  // Items render at their real height once; measure again then.
  useLayoutEffect(() => measure(), [count, measure]);

  const { columns, rowHeight, firstRow, lastRow } = view;
  const rows = Math.ceil(count / columns);
  const first = Math.min(count, firstRow * columns);
  const last = Math.min(count - 1, (lastRow + 1) * columns - 1);
  const style: CSSProperties = {
    paddingTop: Math.min(firstRow, rows) * rowHeight,
    paddingBottom: Math.max(0, rows - lastRow - 1) * rowHeight,
  };

  /** Scrolls the container just enough to show an item. */
  const reveal = useCallback(
    (index: number) => {
      const element = list.current;
      const scroller = element && scrollerOf(element);
      if (!element || !scroller) return;
      const { columns: across, rowHeight: height } = viewRef.current;
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + Math.floor(index / across) * height;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + height > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + height - scroller.clientHeight;
    },
    [],
  );

  return { list, first, last, style, reveal };
}

/** A list or grid that only renders the items near the visible area. */
export function WindowedItems({
  count,
  className,
  minColumnWidth,
  gap,
  estimate,
  revealIndex,
  children,
}: {
  count: number;
  className?: string;
  minColumnWidth?: number;
  gap?: number;
  estimate?: number;
  /** Kept in view whenever it changes, such as the current page. */
  revealIndex?: number;
  children: (index: number) => ReactNode;
}) {
  const { list, first, last, style, reveal } = useWindowedItems(count, { minColumnWidth, gap, estimate });
  useEffect(() => {
    if (revealIndex !== undefined && revealIndex >= 0) reveal(revealIndex);
  }, [revealIndex, reveal]);
  const items: ReactNode[] = [];
  for (let index = first; index <= last; index += 1) items.push(children(index));
  return (
    <div ref={list} className={className} style={style}>
      {items}
    </div>
  );
}
