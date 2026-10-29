import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { PageInfo } from "@paperless/pdf-engine";

/** Pages kept rendered around the viewport, and the most kept in memory. */
const RENDER_AHEAD = 1;
const MAX_CACHED = 14;
const GAP = 16;

export type DocumentViewHandle = {
  /** Scrolls a page (by display index) into view, optionally at a normalized offset. */
  scrollToPage: (index: number, top?: number, behavior?: ScrollBehavior) => void;
  /** Records a page as current without scrolling (the user is already on it). */
  markCurrent: (index: number) => void;
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
  const slots = useRef(new Map<number, HTMLDivElement>());
  const [visible, setVisible] = useState<Set<number>>(() => new Set([page]));
  const [images, setImages] = useState<Map<number, Rendered>>(new Map());
  const reported = useRef(page);
  // Pages are centred in the visible width, not in the widest page's width.
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    if (!stage) return;
    const column = stage.querySelector<HTMLElement>(".pageColumn")?.parentElement;
    const measure = () => {
      const style = column ? getComputedStyle(column) : null;
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

  const sizeOf = (source: number) => {
    const info = pages[source] ?? { width: 612, height: 792 };
    const sideways = ((((rotations[source] ?? 0) % 360) + 360) % 360) % 180 !== 0;
    return { width: (sideways ? info.height : info.width) * zoom, height: (sideways ? info.width : info.height) * zoom };
  };

  const scrollToPage = useCallback(
    (index: number, top = 0, behavior: ScrollBehavior = "auto") => {
      const source = pageOrder[index];
      const slot = source === undefined ? null : slots.current.get(index);
      if (!stage || !slot) return;
      reported.current = index;
      const offset = slot.offsetTop + slot.offsetHeight * top - (top > 0 ? stage.clientHeight * 0.2 : GAP / 2);
      stage.scrollTo({ top: Math.max(0, offset), behavior });
    },
    [pageOrder, stage],
  );
  useImperativeHandle(
    ref,
    () => ({
      scrollToPage,
      markCurrent: (index: number) => {
        reported.current = index;
      },
    }),
    [scrollToPage],
  );

  // Navigation from elsewhere (thumbnails, search, keyboard) scrolls to the page.
  useEffect(() => {
    if (page !== reported.current) scrollToPage(page);
  }, [page, scrollToPage]);

  // Keep the reading position when zoom or page sizes change.
  const anchor = useRef<{ index: number; fraction: number } | null>(null);
  useEffect(() => {
    if (!stage) return;
    const remember = () => {
      const slot = slots.current.get(reported.current);
      if (slot) anchor.current = { index: reported.current, fraction: (stage.scrollTop - slot.offsetTop) / Math.max(1, slot.offsetHeight) };
    };
    remember();
    stage.addEventListener("scroll", remember, { passive: true });
    return () => stage.removeEventListener("scroll", remember);
  }, [stage]);

  // The current page is whichever covers the upper part of the viewport.
  useEffect(() => {
    if (!stage) return;
    let frame = 0;
    const track = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const line = stage.scrollTop + stage.clientHeight * 0.35;
        let current = 0;
        for (const [index, slot] of slots.current) if (slot.offsetTop <= line && index > current) current = index;
        if (current !== reported.current && current < latest.current.pageOrder.length) {
          reported.current = current;
          onPageChange(current);
        }
      });
    };
    stage.addEventListener("scroll", track, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      stage.removeEventListener("scroll", track);
    };
  }, [stage, onPageChange]);

  useEffect(() => {
    if (!stage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((current) => {
          const next = new Set(current);
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.index);
            if (entry.isIntersecting) next.add(index);
            else next.delete(index);
          }
          return next.size === current.size && [...next].every((item) => current.has(item)) ? current : next;
        });
      },
      { root: stage, rootMargin: "300px 0px" },
    );
    slots.current.forEach((slot) => observer.observe(slot));
    return () => observer.disconnect();
  }, [stage, pageOrder, zoom]);

  const visibleSources = [...visible].map((index) => pageOrder[index]).filter((source): source is number => source !== undefined);
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
        shown.forEach((index) => {
          for (let near = index - RENDER_AHEAD; near <= index + RENDER_AHEAD; near += 1) if (near >= 0 && near < order.length) wanted.add(near);
        });
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
              if (updated.size <= MAX_CACHED) break;
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

  useEffect(() => {
    if (!stage || !anchor.current) return;
    const { index, fraction } = anchor.current;
    const slot = slots.current.get(index);
    if (slot) stage.scrollTop = slot.offsetTop + fraction * slot.offsetHeight;
    // Only zoom and rotation should restore the anchor, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, rotations]);

  return (
    <div className="pageColumn" style={{ gap: GAP }}>
      {pageOrder.map((source, index) => {
        const size = sizeOf(source);
        const near = [...visible].some((item) => Math.abs(item - index) <= RENDER_AHEAD);
        return (
          <div
            key={source}
            data-index={index}
            data-page={index + 1}
            className="pageSlot"
            style={{ width: size.width, height: size.height, marginLeft: Math.max(0, (viewportWidth - size.width) / 2) }}
            ref={(node) => {
              if (node) slots.current.set(index, node);
              else slots.current.delete(index);
            }}
          >
            {near ? props.children({ source, index, image: images.get(source)?.url ?? null, active: index === page }) : <div className="pagePlaceholder" />}
          </div>
        );
      })}
    </div>
  );
});
