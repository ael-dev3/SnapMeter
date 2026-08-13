import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type OpenReason = "click" | "focus" | "hover";
type TooltipPosition = Readonly<{ left: number; placement: "above" | "below"; ready: boolean; top: number }>;

const OPEN_EVENT = "snapmeter:info-tip-open";
const VIEWPORT_GUTTER_PX = 12;
const TRIGGER_GAP_PX = 8;

function cssPixels(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function InfoTip({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [openReason, setOpenReason] = useState<OpenReason | null>(null);
  const [position, setPosition] = useState<TooltipPosition>({ left: 0, placement: "above", ready: false, top: 0 });
  const open = openReason !== null;

  const cancelScheduledClose = useCallback((): void => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
  }, []);

  const close = useCallback((): void => {
    cancelScheduledClose();
    setOpenReason(null);
  }, [cancelScheduledClose]);

  const openAs = useCallback((reason: OpenReason): void => {
    cancelScheduledClose();
    setOpenReason(reason);
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
  }, [cancelScheduledClose, id]);

  const scheduleHoverClose = useCallback((): void => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpenReason((current) => current === "hover" ? null : current);
      closeTimerRef.current = undefined;
    }, 100);
  }, [cancelScheduledClose]);

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const rootStyle = window.getComputedStyle(document.documentElement);
    const minLeft = viewportLeft + Math.max(VIEWPORT_GUTTER_PX, cssPixels(rootStyle, "--fc-safe-area-inset-left"));
    const maxRight = viewportRight - Math.max(VIEWPORT_GUTTER_PX, cssPixels(rootStyle, "--fc-safe-area-inset-right"));
    const minTop = viewportTop + Math.max(VIEWPORT_GUTTER_PX, cssPixels(rootStyle, "--fc-safe-area-inset-top"));
    const maxBottom = viewportBottom - Math.max(VIEWPORT_GUTTER_PX, cssPixels(rootStyle, "--fc-safe-area-inset-bottom"));
    const usableWidth = Math.max(1, maxRight - minLeft);
    const usableHeight = Math.max(1, maxBottom - minTop);

    // Constrain the overlay before measuring it. The visual viewport can be
    // narrower than 100vw in a Mini App, and Farcaster safe-area insets make
    // the actually usable rectangle smaller again.
    tooltip.style.setProperty("--tooltip-max-width", `${usableWidth}px`);
    tooltip.style.setProperty("--tooltip-max-height", `${usableHeight}px`);
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const maxLeft = Math.max(minLeft, maxRight - tooltipRect.width);
    const left = Math.min(maxLeft, Math.max(minLeft, triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2));
    const aboveTop = triggerRect.top - TRIGGER_GAP_PX - tooltipRect.height;
    const belowTop = triggerRect.bottom + TRIGGER_GAP_PX;
    const fitsAbove = aboveTop >= minTop;
    const fitsBelow = belowTop + tooltipRect.height <= maxBottom;
    const placement = fitsAbove || (!fitsBelow && triggerRect.top - minTop >= maxBottom - triggerRect.bottom)
      ? "above"
      : "below";
    const desiredTop = placement === "above" ? aboveTop : belowTop;
    const maxTop = Math.max(minTop, maxBottom - tooltipRect.height);
    const top = Math.min(maxTop, Math.max(minTop, desiredTop));

    setPosition({ left, placement, ready: true, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    setPosition((current) => ({ ...current, ready: false }));
    updatePosition();
  }, [children, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const schedulePosition = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePosition);
    };
    const viewport = window.visualViewport;
    const rootStyleObserver = new MutationObserver(schedulePosition);
    rootStyleObserver.observe(document.documentElement, { attributeFilter: ["style"], attributes: true });
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    viewport?.addEventListener("resize", schedulePosition);
    viewport?.addEventListener("scroll", schedulePosition);
    return () => {
      window.cancelAnimationFrame(frame);
      rootStyleObserver.disconnect();
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      viewport?.removeEventListener("resize", schedulePosition);
      viewport?.removeEventListener("scroll", schedulePosition);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    const handleOtherOpen = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== id) close();
    };
    document.addEventListener(OPEN_EVENT, handleOtherOpen);
    return () => document.removeEventListener(OPEN_EVENT, handleOtherOpen);
  }, [close, id]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!triggerRef.current?.contains(target) && !tooltipRef.current?.contains(target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, open]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  const tooltip = open ? createPortal(
    <span
      id={id}
      ref={tooltipRef}
      role="tooltip"
      className="tooltip"
      data-open=""
      data-placement={position.placement}
      data-ready={position.ready || undefined}
      style={{ left: position.left, top: position.top }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse" && openReason === "hover") cancelScheduledClose();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && openReason === "hover") scheduleHoverClose();
      }}
    >
      {children}
    </span>,
    document.body
  ) : null;

  return (
    <span className="info-tip">
      <button
        ref={triggerRef}
        type="button"
        className="info-trigger"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onClick={() => openReason === "click" ? close() : openAs("click")}
        onFocus={() => openAs("focus")}
        onBlur={close}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" && openReason !== "click" && openReason !== "focus") openAs("hover");
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && openReason === "hover") scheduleHoverClose();
        }}
      >
        i
      </button>
      {tooltip}
    </span>
  );
}
