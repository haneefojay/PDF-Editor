import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageInfo } from "@paperless/pdf-engine";
import { PAGE_CACHE_SIZE } from "./device";

/** Pages kept rendered beyond those in view. */
const RENDER_AHEAD = 1;
const GAP = 16;
/** How far beyond the viewport a page counts as near, in pixels. */
const MARGIN = 300;

type Range = { first: number; last: number };

export type DocumentViewHandle = {
  /** Scrolls a page (by display index) into view, optionally at a normalized offset. */
  scrollToPage: (index: number, top?: number, behavior?: ScrollBehavior) => void;
  /** Records a page as current without scrolling (the user is already on it). */
  markCurrent: (index: number) => void;
  /** Scrolls just enough to show a band of a page (normalized top and bottom), if it is not in view. */
  reveal: (index: number, top: number, bottom: number) => void;
};

type Rendered = { url: string; scale: number };

export const DocumentView = forwardRef<
  DocumentViewHandle,
  {
    stage: HTMLDivElement | null;
    pageOrder: number[];
    pages: PageInfo[];
    rotations: Record<number, number>;
    zoom: number;
    renderScale: number;
    /** Changes whenever the source document changes and renders are stale. */
    documentKey: unknown;
    page: number;
    render: (source: number, scale: number) => Promise<Uint8Array>;
    onPageChange: (index: number) => void;
    onVisibleChange: (sources: number[]) => void;
    children: (props: { source: number; index: number; image: string | null; active: boolean }) => ReactNode;
  }
>(function DocumentView(props, ref) {
  const { stage, pageOrder, pages, rotations, zoom, renderScale, documentKey, page, onPageChange, onVisibleChange } = props;
  const column = useRef<HTMLDivElement>(null);
  // Pages near the viewport (display indexes, inclusive). Only these are in the DOM.
  const [visible, setVisible] = useState<Range>(() => ({ first: page, last: page }));
  const [images, setImages] = useState<Map<number, Rendered>>(new Map());
  const reported = useRef(page);
  // Pages are centred in the visible width, not in the widest page's width.
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    if (!stage) return;
    const parent = column.current?.parentElement;
    const measure = () => {
      const style = parent ? getComputedStyle(parent) : null;
      const padding = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
      setViewportWidth(Math.max(0, stage.clientWidth - padding));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  const queue = useRef<{ running: boolean; generation: number }>({ running: false, generation: 0 });
  const latest = useRef({ visible, images, renderScale, pageOrder, page, render: props.render });
  latest.current = { visible, images, renderScale, pageOrder, page, render: props.render };

  // Every page's place in the column, from page sizes alone, so long
  // documents never need a DOM node per page.
  const layout = useMemo(() => {
    const count = pageOrder.length;
    const tops = new Float64Array(count + 1);
    const widths = new Float64Array(count);
    const heights = new Float64Array(count);
    pageOrder.forEach((source, index) => {
      const info = pages[source] ?? { width: 612, height: 792 };
      const sideways = ((((rotations[source] ?? 0) % 360) + 360) % 360) % 180 !== 0;
      widths[index] = (sideways ? info.height : info.width) * zoom;
      heights[index] = (sideways ? info.width : info.height) * zoom;
      tops[index + 1] = tops[index]! + heights[index]! + GAP;
    });
    return { count, tops, widths, heights };
  }, [pageOrder, pages, rotations, zoom]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** Where the column starts, in the stage's scroll coordinates. */
  const origin = useCallback(() => {
    if (!stage || !column.current) return 0;
    return column.current.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop;
  }, [stage]);
  /** The last page starting at or above a point in the column. */
  const indexAt = (y: number) => {
    const { tops, count } = layoutRef.current;
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (tops[middle]! <= y) low = middle;
      else high = middle - 1;
    }
    return Math.max(0, low);
  };

  const scrollToPage = useCallback(
    (index: number, top = 0, behavior: ScrollBehavior = "auto") => {
      const { tops, heights, count } = layoutRef.current;
      if (!stage || index < 0 || index >= count) return;
      reported.current = index;
      const offset = origin() + tops[index]! + heights[index]! * top - (top > 0 ? stage.clientHeight * 0.2 : GAP / 2);
      stage.scrollTo({ top: Math.max(0, offset), behavior });
    },
    [origin, stage],
  );
  useImperativeHandle(
    ref,
    () => ({
      scrollToPage,
      markCurrent: (index: number) => {
        reported.current = index;
      },
      reveal: (index: number, top: number, bottom: number) => {
        const { tops, heights, count } = layoutRef.current;
        if (!stage || index < 0 || index >= count) return;
        const base = origin() + tops[index]!;
        const start = base + heights[index]! * top;
        const end = base + heights[index]! * bottom;
        const view = stage.scrollTop;
        const height = stage.clientHeight;
        if (start >= view + height * 0.08 && end <= view + height * 0.8) return;
        reported.current = index;
        stage.scrollTo({ top: Math.max(0, start - height * 0.25), behavior: "smooth" });
      },
    }),
    [origin, scrollToPage, stage],
  );

  // Navigation from elsewhere (thumbnails, search, keyboard) scrolls to the page.
  useEffect(() => {
    if (page !== reported.current) scrollToPage(page);
  }, [page, scrollToPage]);

  // Keep the reading position when zoom or page sizes change.
  const anchor = useRef<{ index: number; fraction: number } | null>(null);
  // Which pages are near the viewport, and which one is current: the page
  // covering the upper part of the viewport.
  const update = useCallback(() => {
    const { tops, heights, count } = layoutRef.current;
    if (!stage || !count) return;
    const scroll = stage.scrollTop - origin();
    const first = indexAt(scroll - MARGIN);
    const last = indexAt(scroll + stage.clientHeight + MARGIN);
    setVisible((current) => (current.first === first && current.last === last ? current : { first, last }));
    const current = indexAt(scroll + stage.clientHeight * 0.35);
    if (current !== reported.current) {
      reported.current = current;
      onPageChange(current);
    }
    const index = reported.current;
    if (index < count) anchor.current = { index, fraction: (scroll - tops[index]!) / Math.max(1, heights[index]!) };
  }, [stage, origin, onPageChange]);
  useEffect(() => {
    if (!stage) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    stage.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      stage.removeEventListener("scroll", schedule);
    };
  }, [stage, update]);
  // A different set or size of pages moves what is near the viewport.
  useLayoutEffect(() => {
    if (!stage) return;
    const { first, last } = latest.current.visible;
    const count = layout.count;
    if (first >= count || last >= count) setVisible({ first: Math.min(first, Math.max(0, count - 1)), last: Math.min(last, Math.max(0, count - 1)) });
    const frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [layout, stage, update]);

  const visibleSources: number[] = [];
  for (let index = visible.first; index <= visible.last; index += 1) if (pageOrder[index] !== undefined) visibleSources.push(pageOrder[index]!);
  const visibleKey = visibleSources.sort((a, b) => a - b).join(",");
  useEffect(() => {
    onVisibleChange(visibleKey ? visibleKey.split(",").map(Number) : []);
  }, [visibleKey, onVisibleChange]);

  // A new source document invalidates every render.
  useEffect(() => {
    queue.current.generation += 1;
    setImages((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.url));
      return new Map();
    });
  }, [documentKey]);
  useEffect(
    () => () => {
      queue.current.generation += 1;
    },
    [],
  );

  const pump = useCallback(() => {
    const state = queue.current;
    if (state.running) return;
    state.running = true;
    void (async () => {
      for (;;) {
        const { visible: shown, images: cached, renderScale: scale, pageOrder: order, page: currentPage } = latest.current;
        const wanted = new Set<number>();
        for (let near = shown.first - RENDER_AHEAD; near <= shown.last + RENDER_AHEAD; near += 1) if (near >= 0 && near < order.length) wanted.add(near);
        const next = [...wanted]
          .sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))
          .map((index) => order[index]!)
          .find((source) => cached.get(source)?.scale !== scale);
        if (next === undefined) break;
        const generation = state.generation;
        try {
          const png = await latest.current.render(next, scale);
          if (generation !== state.generation) continue;
          const copy = new Uint8Array(png.byteLength);
          copy.set(png);
          const url = URL.createObjectURL(new Blob([copy.buffer], { type: "image/png" }));
          const keep = new Set([...wanted].map((index) => order[index]));
          setImages((current) => {
            const updated = new Map(current);
            const old = updated.get(next);
            if (old) URL.revokeObjectURL(old.url);
            updated.set(next, { url, scale });
            // Drop renders far from the viewport once the cache is full.
            for (const [source, item] of updated) {
              if (updated.size <= PAGE_CACHE_SIZE) break;
              if (!keep.has(source)) {
                URL.revokeObjectURL(item.url);
                updated.delete(source);
              }
            }
            latest.current.images = updated;
            return updated;
          });
        } catch {
          break;
        }
      }
      state.running = false;
    })();
  }, []);
  useEffect(() => pump(), [visible, renderScale, pageOrder, images.size, documentKey, pump]);

  useLayoutEffect(() => {
    if (!stage || !anchor.current) return;
    const { index, fraction } = anchor.current;
    const { tops, heights, count } = layoutRef.current;
    if (index < count) stage.scrollTop = origin() + tops[index]! + fraction * heights[index]!;
    // Only zoom and rotation should restore the anchor, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, rotations]);

  const { tops, widths, heights, count } = layout;
  const first = Math.max(0, Math.min(visible.first, count - 1) - RENDER_AHEAD);
  const last = Math.min(count - 1, visible.last + RENDER_AHEAD);
  let widest = 0;
  for (let index = 0; index < count; index += 1) widest = Math.max(widest, Math.max(0, (viewportWidth - widths[index]!) / 2) + widths[index]!);
  const slots: ReactNode[] = [];
  for (let index = first; index <= last && count; index += 1) {
    const source = pageOrder[index]!;
    slots.push(
      <div
        key={source}
        data-index={index}
        data-page={index + 1}
        className="pageSlot"
        style={{ width: widths[index], height: heights[index], marginLeft: Math.max(0, (viewportWidth - widths[index]!) / 2) }}
      >
        {props.children({ source, index, image: images.get(source)?.url ?? null, active: index === page })}
      </div>,
    );
  }
  return (
    <div
      ref={column}
      className="pageColumn"
      style={{ gap: GAP, minWidth: widest, paddingTop: count ? tops[first] : 0, paddingBottom: count ? tops[count]! - tops[last + 1]! : 0 }}
    >
      {slots}
    </div>
  );
});
