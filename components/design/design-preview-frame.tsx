"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDesignWorkspaceStore } from "@/lib/design/workspace/store";
import { DESIGN_BREAKPOINTS } from "@/lib/design/workspace/types";
import { computeDesignPreviewFrameLayout } from "@/lib/design/workspace/viewport";
import { rehydrateComponentCode } from "@/components/design/design-workspace-bridge";
import { Button } from "@/components/ui/button";
import {
  Monitor,
  Tablet,
  Smartphone,
  Crosshair,
  Maximize,
  Sun,
  Moon,
  SunMoon,
  Ruler,
  Pipette,
  MessageSquare,
} from "lucide-react";
import type {
  ActiveTool,
  DesignComment,
  DesignPreviewTheme,
  InspectedElement,
  Measurement,
  PickedColor,
} from "@/lib/design/workspace/types";

const BREAKPOINT_ICONS: Record<string, ReactNode> = {
  responsive: <Maximize className="h-4 w-4" />,
  mobile: <Smartphone className="h-4 w-4" />,
  tablet: <Tablet className="h-4 w-4" />,
  desktop: <Monitor className="h-4 w-4" />,
};

const PREVIEW_THEME_OPTIONS: { value: DesignPreviewTheme; icon: ReactNode; label: string }[] = [
  { value: "light", icon: <Sun className="h-4 w-4" />, label: "Light" },
  { value: "dark", icon: <Moon className="h-4 w-4" />, label: "Dark" },
  { value: "system", icon: <SunMoon className="h-4 w-4" />, label: "System" },
];

/**
 * Apply the selected preview theme to compiled HTML.
 *
 * The compiler outputs `<html lang="en" class="dark">` by default. This
 * function patches the `<html>` tag so that:
 * - "light" removes the `dark` class
 * - "dark" ensures the `dark` class is present
 * - "system" removes the static class and injects a tiny script that reacts
 *   to `prefers-color-scheme` at runtime
 */
function applyPreviewTheme(html: string, theme: DesignPreviewTheme): string {
  if (theme === "light") {
    // Remove the dark class from <html>
    return html.replace(/<html([^>]*)\s+class="dark"/, "<html$1");
  }
  if (theme === "dark") {
    // Ensure dark class is present (it already is by default, but handle edge cases)
    if (/<html[^>]*class="dark"/.test(html)) return html;
    return html.replace(/<html([^>]*)>/, '<html$1 class="dark">');
  }
  // "system" — remove static class, inject media-query script
  const withoutDark = html.replace(/<html([^>]*)\s+class="dark"/, "<html$1");
  const systemScript = `<script>(function(){var h=document.documentElement;function u(){h.classList.toggle('dark',window.matchMedia('(prefers-color-scheme:dark)').matches)}u();window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change',u)})()</script>`;
  if (withoutDark.includes("</head>")) {
    return withoutDark.replace("</head>", systemScript + "</head>");
  }
  return withoutDark.replace(/<body/, systemScript + "<body");
}

/** Simple fast hash for cache invalidation (djb2). */
function hashCode(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Check if the preview HTML is a loading placeholder (not compiled content). */
function isPlaceholderHtml(html: string): boolean {
  return !html.trim() || html.includes('data-selene-placeholder="true"');
}

/** Escape text for safe inline HTML rendering. */
function escapeForHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Tools script — injected into the iframe when ANY tool is active.
// Self-contained, no external deps. Mode is read from window.__seleneActiveTool
// and can be hot-swapped via the `selene-tool-set-active` message.
// Communicates with parent via postMessage.
// ---------------------------------------------------------------------------
const TOOLS_SCRIPT = `
(function() {
  if (window.__seleneTools) return;
  window.__seleneTools = true;

  var activeTool = window.__seleneActiveTool || null;

  // Overlay canvas
  var overlay = document.createElement('div');
  overlay.id = '__selene-tools-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';
  document.documentElement.appendChild(overlay);

  // Tooltip
  var tooltip = document.createElement('div');
  tooltip.id = '__selene-tools-tooltip';
  tooltip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:rgba(0,0,0,0.85);color:#fff;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 8px;border-radius:4px;white-space:nowrap;display:none;max-width:360px;overflow:hidden;text-overflow:ellipsis;';
  document.documentElement.appendChild(tooltip);

  // Box-model highlight elements
  var marginBox = document.createElement('div');
  marginBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;background:rgba(246,178,107,0.3);';
  var paddingBox = document.createElement('div');
  paddingBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;background:rgba(147,196,125,0.3);';
  var contentBox = document.createElement('div');
  contentBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;background:rgba(111,168,220,0.3);';
  document.documentElement.appendChild(marginBox);
  document.documentElement.appendChild(paddingBox);
  document.documentElement.appendChild(contentBox);

  // Measure-mode anchor / overlay layer (also used by comment pins)
  var measureLayer = document.createElement('div');
  measureLayer.id = '__selene-measure-layer';
  measureLayer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';
  document.documentElement.appendChild(measureLayer);

  var commentLayer = document.createElement('div');
  commentLayer.id = '__selene-comment-layer';
  commentLayer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';
  document.documentElement.appendChild(commentLayer);

  var hoveredEl = null;

  function getCssSelector(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var current = el;
    while (current && current !== document.documentElement) {
      var tag = current.tagName.toLowerCase();
      if (current.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(current) + 1;
          tag += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(tag);
      current = parent;
    }
    return parts.join(' > ');
  }

  function parseNum(v) { return parseFloat(v) || 0; }

  function highlight(el) {
    if (!el || el === document.documentElement || el === document.body) {
      hideHighlight();
      return;
    }
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var mt = parseNum(cs.marginTop), mr = parseNum(cs.marginRight), mb = parseNum(cs.marginBottom), ml = parseNum(cs.marginLeft);
    var pt = parseNum(cs.paddingTop), pr = parseNum(cs.paddingRight), pb = parseNum(cs.paddingBottom), pl = parseNum(cs.paddingLeft);

    // Margin box
    marginBox.style.top = (rect.top - mt) + 'px';
    marginBox.style.left = (rect.left - ml) + 'px';
    marginBox.style.width = (rect.width + ml + mr) + 'px';
    marginBox.style.height = (rect.height + mt + mb) + 'px';
    marginBox.style.display = 'block';

    // Padding box (same as border box here)
    paddingBox.style.top = rect.top + 'px';
    paddingBox.style.left = rect.left + 'px';
    paddingBox.style.width = rect.width + 'px';
    paddingBox.style.height = rect.height + 'px';
    paddingBox.style.display = 'block';

    // Content box
    contentBox.style.top = (rect.top + pt) + 'px';
    contentBox.style.left = (rect.left + pl) + 'px';
    contentBox.style.width = (rect.width - pl - pr) + 'px';
    contentBox.style.height = (rect.height - pt - pb) + 'px';
    contentBox.style.display = 'block';
  }

  function hideHighlight() {
    marginBox.style.display = 'none';
    paddingBox.style.display = 'none';
    contentBox.style.display = 'none';
    tooltip.style.display = 'none';
  }

  function showTooltip(text, x, y) {
    tooltip.innerHTML = text;
    tooltip.style.display = 'block';

    // Position: prefer below-right of cursor, flip if needed
    var tx = x + 12;
    var ty = y + 12;
    if (tx + tooltip.offsetWidth > window.innerWidth) tx = x - tooltip.offsetWidth - 4;
    if (ty + tooltip.offsetHeight > window.innerHeight) ty = y - tooltip.offsetHeight - 4;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = ty + 'px';
  }

  function showInspectTooltip(el, x, y) {
    var rect = el.getBoundingClientRect();
    var tag = el.tagName.toLowerCase();
    var cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    var idStr = el.id ? '#' + el.id : '';
    var dims = Math.round(rect.width) + ' x ' + Math.round(rect.height);
    showTooltip(escapeHtml(tag + idStr + cls + '  ' + dims), x, y);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildElementPayload(el) {
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var text = (el.textContent || '').trim();
    if (text.length > 120) text = text.slice(0, 120) + '...';
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: (typeof el.className === 'string') ? el.className : '',
      textContent: text,
      selector: getCssSelector(el),
      boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      computedStyles: {
        width: cs.width,
        height: cs.height,
        padding: cs.padding,
        margin: cs.margin,
        display: cs.display,
        position: cs.position,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily
      }
    };
  }

  function isToolElement(el) {
    if (!el) return false;
    if (el === overlay || el === tooltip || el === marginBox || el === paddingBox || el === contentBox) return true;
    if (el === measureLayer || el === commentLayer) return true;
    // Anything inside our overlay layers
    if (measureLayer.contains(el) || commentLayer.contains(el)) return true;
    return false;
  }

  function getEventTarget(e) {
    var target = e.target;
    if (!target || isToolElement(target)) return null;
    if (target instanceof SVGElement && !(target instanceof SVGSVGElement)) {
      target = target.closest('svg') || target;
    }
    return target;
  }

  // --- Persistent selection overlays (inspect) ---
  var selectedOverlays = [];

  function createSelectionOverlay(el) {
    var rect = el.getBoundingClientRect();
    var box = document.createElement('div');
    box.className = '__selene-selection-overlay';
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483644;border:2px solid #3b82f6;background:rgba(59,130,246,0.08);border-radius:2px;';
    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.dataset.selector = getCssSelector(el);
    document.documentElement.appendChild(box);
    return box;
  }

  function refreshSelectionOverlays() {
    selectedOverlays.forEach(function(entry) {
      if (!entry.el || !entry.el.isConnected) { entry.box.remove(); return; }
      var rect = entry.el.getBoundingClientRect();
      entry.box.style.top = rect.top + 'px';
      entry.box.style.left = rect.left + 'px';
      entry.box.style.width = rect.width + 'px';
      entry.box.style.height = rect.height + 'px';
    });
  }

  function addSelection(el) {
    var selector = getCssSelector(el);
    var exists = selectedOverlays.some(function(entry) { return entry.selector === selector; });
    if (exists) return;
    if (selectedOverlays.length >= 8) return; // MAX_INSPECT_SELECTIONS
    var box = createSelectionOverlay(el);
    selectedOverlays.push({ el: el, box: box, selector: selector });
  }

  function removeSelection(selector) {
    selectedOverlays = selectedOverlays.filter(function(entry) {
      if (entry.selector === selector) { entry.box.remove(); return false; }
      return true;
    });
  }

  function clearSelections() {
    selectedOverlays.forEach(function(entry) { entry.box.remove(); });
    selectedOverlays = [];
  }

  function isSelected(el) {
    var selector = getCssSelector(el);
    return selectedOverlays.some(function(entry) { return entry.selector === selector; });
  }

  // --- Measure mode ---
  var measureAnchor = null; // { el, rect, anchorBox }
  var measureLines = []; // ephemeral DOM elements

  function clearMeasureLines() {
    measureLines.forEach(function(node) { if (node && node.parentNode) node.parentNode.removeChild(node); });
    measureLines = [];
  }

  function clearMeasureAnchor() {
    if (measureAnchor && measureAnchor.anchorBox && measureAnchor.anchorBox.parentNode) {
      measureAnchor.anchorBox.parentNode.removeChild(measureAnchor.anchorBox);
    }
    measureAnchor = null;
    clearMeasureLines();
  }

  function makeMeasureBadge(text, left, top) {
    var badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#ef4444;color:#fff;font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 4px;border-radius:2px;transform:translate(-50%,-50%);white-space:nowrap;';
    badge.textContent = text;
    badge.style.left = left + 'px';
    badge.style.top = top + 'px';
    return badge;
  }

  function makeMeasureLine(x1, y1, x2, y2) {
    var line = document.createElement('div');
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    var angle = Math.atan2(dy, dx) * 180 / Math.PI;
    line.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;height:0;border-top:1px dashed #ef4444;transform-origin:0 0;';
    line.style.left = x1 + 'px';
    line.style.top = y1 + 'px';
    line.style.width = len + 'px';
    line.style.transform = 'rotate(' + angle + 'deg)';
    return line;
  }

  function drawMeasurement(fromRect, toRect) {
    clearMeasureLines();
    var fcx = fromRect.left + fromRect.width / 2;
    var fcy = fromRect.top + fromRect.height / 2;
    var tcx = toRect.left + toRect.width / 2;
    var tcy = toRect.top + toRect.height / 2;

    // Outline of target (red dashed)
    var outline = document.createElement('div');
    outline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:1px dashed #ef4444;';
    outline.style.left = toRect.left + 'px';
    outline.style.top = toRect.top + 'px';
    outline.style.width = toRect.width + 'px';
    outline.style.height = toRect.height + 'px';
    measureLayer.appendChild(outline);
    measureLines.push(outline);

    // Horizontal line — between right edge of from and left edge of to (or vice versa)
    var horizontalDist = 0;
    var hx1, hx2, hy;
    if (toRect.left >= fromRect.right) {
      hx1 = fromRect.right; hx2 = toRect.left; hy = fcy;
      horizontalDist = hx2 - hx1;
    } else if (fromRect.left >= toRect.right) {
      hx1 = toRect.right; hx2 = fromRect.left; hy = fcy;
      horizontalDist = hx2 - hx1;
    } else {
      // Overlap horizontally — use center distance
      hx1 = fcx; hx2 = tcx; hy = (fcy + tcy) / 2;
      horizontalDist = Math.abs(hx2 - hx1);
    }
    if (horizontalDist > 0.5) {
      var hLine = makeMeasureLine(hx1, hy, hx2, hy);
      measureLayer.appendChild(hLine);
      measureLines.push(hLine);
      var hBadge = makeMeasureBadge(Math.round(horizontalDist) + 'px', (hx1 + hx2) / 2, hy);
      measureLayer.appendChild(hBadge);
      measureLines.push(hBadge);
    }

    var verticalDist = 0;
    var vy1, vy2, vx;
    if (toRect.top >= fromRect.bottom) {
      vy1 = fromRect.bottom; vy2 = toRect.top; vx = tcx;
      verticalDist = vy2 - vy1;
    } else if (fromRect.top >= toRect.bottom) {
      vy1 = toRect.bottom; vy2 = fromRect.top; vx = tcx;
      verticalDist = vy2 - vy1;
    } else {
      vy1 = fcy; vy2 = tcy; vx = (fcx + tcx) / 2;
      verticalDist = Math.abs(vy2 - vy1);
    }
    if (verticalDist > 0.5) {
      var vLine = makeMeasureLine(vx, vy1, vx, vy2);
      measureLayer.appendChild(vLine);
      measureLines.push(vLine);
      var vBadge = makeMeasureBadge(Math.round(verticalDist) + 'px', vx, (vy1 + vy2) / 2);
      measureLayer.appendChild(vBadge);
      measureLines.push(vBadge);
    }

    // Total euclidean
    var dx = tcx - fcx;
    var dy = tcy - fcy;
    var euclidean = Math.sqrt(dx * dx + dy * dy);
    return { dx: dx, dy: dy, horizontal: horizontalDist, vertical: verticalDist, euclidean: euclidean };
  }

  function startMeasureAnchor(el) {
    var rect = el.getBoundingClientRect();
    var anchorBox = document.createElement('div');
    anchorBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #3b82f6;background:rgba(59,130,246,0.10);';
    anchorBox.style.left = rect.left + 'px';
    anchorBox.style.top = rect.top + 'px';
    anchorBox.style.width = rect.width + 'px';
    anchorBox.style.height = rect.height + 'px';
    measureLayer.appendChild(anchorBox);
    // Capture selector at click 1; rect is re-read live at click 2 / hover.
    measureAnchor = { el: el, selector: getCssSelector(el), anchorBox: anchorBox };
  }

  // --- Eyedropper ---
  function rgbStringToRgba(s) {
    if (!s) return null;
    var m = s.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([0-9.]+))?\\s*\\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: (function(){ var p = m[4] != null ? parseFloat(m[4]) : 1; return Number.isFinite(p) ? p : 1; })() };
  }

  function rgbToHex(rgba) {
    var to2 = function(n) { var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length === 1 ? '0' + s : s; };
    return '#' + to2(rgba.r) + to2(rgba.g) + to2(rgba.b);
  }

  function rgbToHsl(rgba) {
    var r = rgba.r / 255, g = rgba.g / 255, b = rgba.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100), a: rgba.a };
  }

  function getEffectiveBackground(el) {
    var current = el;
    while (current && current !== document.documentElement) {
      var cs = getComputedStyle(current);
      var rgba = rgbStringToRgba(cs.backgroundColor);
      if (rgba && rgba.a > 0) return rgba;
      current = current.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  // --- Comment mode ---
  var commentInput = null;
  var commentTarget = null;
  var commentPins = [];

  function clearCommentInput() {
    if (commentInput && commentInput.parentNode) commentInput.parentNode.removeChild(commentInput);
    commentInput = null;
    commentTarget = null;
  }

  function makeCommentInput(el) {
    var rect = el.getBoundingClientRect();
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:auto;background:#fff;border:1px solid #d4d4d8;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.12);padding:6px;display:flex;gap:4px;align-items:center;';
    wrap.style.left = Math.min(window.innerWidth - 240, rect.right + 4) + 'px';
    wrap.style.top = Math.max(4, rect.top - 8) + 'px';

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a comment…';
    input.style.cssText = 'border:none;outline:none;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;width:200px;background:transparent;color:#111;';
    wrap.appendChild(input);

    return { wrap: wrap, input: input };
  }

  function refreshCommentPins(comments) {
    commentPins.forEach(function(p) { if (p && p.parentNode) p.parentNode.removeChild(p); });
    commentPins = [];
    if (!comments || !comments.length) return;
    comments.forEach(function(c, idx) {
      try {
        var el = document.querySelector(c.elementSelector);
        if (!el) return;
        var rect = el.getBoundingClientRect();
        var pin = document.createElement('div');
        pin.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:20px;height:20px;border-radius:9999px;background:' + (c.resolved ? '#94a3b8' : '#f59e0b') + ';color:#fff;font:11px/20px ui-sans-serif,system-ui,sans-serif;text-align:center;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.25);';
        pin.style.left = (rect.right - 10) + 'px';
        pin.style.top = (rect.top - 10) + 'px';
        pin.textContent = String(idx + 1);
        commentLayer.appendChild(pin);
        commentPins.push(pin);
      } catch (err) { /* invalid selector — skip */ }
    });
  }

  // --- Cursor management ---
  function applyCursor() {
    if (activeTool === 'measure' || activeTool === 'eyedropper') {
      document.body && (document.body.style.cursor = 'crosshair');
    } else if (activeTool === 'comment') {
      document.body && (document.body.style.cursor = 'cell');
    } else if (activeTool === 'inspect') {
      document.body && (document.body.style.cursor = 'default');
    } else {
      document.body && (document.body.style.cursor = '');
    }
  }

  // --- Event handlers ---
  function onMouseMove(e) {
    var target = getEventTarget(e);
    if (!target) return;
    hoveredEl = target;

    if (activeTool === 'inspect') {
      highlight(target);
      showInspectTooltip(target, e.clientX, e.clientY);
      return;
    }

    if (activeTool === 'measure') {
      if (!measureAnchor) {
        highlight(target);
        var rect = target.getBoundingClientRect();
        showTooltip(escapeHtml(Math.round(rect.width) + ' x ' + Math.round(rect.height)), e.clientX, e.clientY);
      } else if (target !== measureAnchor.el) {
        var fromRectLive = measureAnchor.el.getBoundingClientRect();
        var toRect = target.getBoundingClientRect();
        drawMeasurement(fromRectLive, toRect);
        hideHighlight();
      }
      return;
    }

    if (activeTool === 'eyedropper') {
      var rgba = getEffectiveBackground(target);
      var hex = rgbToHex(rgba);
      var swatch = '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + hex + ';margin-right:6px;vertical-align:middle;border:1px solid rgba(255,255,255,0.4);"></span>';
      showTooltip(swatch + escapeHtml(hex), e.clientX, e.clientY);
      return;
    }

    if (activeTool === 'comment') {
      hideHighlight();
      return;
    }
  }

  function onClick(e) {
    if (!activeTool) return;
    var target = getEventTarget(e);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (activeTool === 'inspect') {
      var isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
      var element = buildElementPayload(target);
      var payload = { type: 'selene-inspector-select', element: element, multiSelect: isMulti };
      if (isMulti) {
        var sel = element.selector;
        if (isSelected(target)) { removeSelection(sel); payload.action = 'remove'; }
        else { addSelection(target); payload.action = 'add'; }
      } else {
        clearSelections();
        addSelection(target);
        payload.action = 'replace';
      }
      window.parent.postMessage(payload, '*');
      return;
    }

    if (activeTool === 'measure') {
      if (!measureAnchor) {
        startMeasureAnchor(target);
        return;
      }
      if (target === measureAnchor.el) return;
      var fromRectLive = measureAnchor.el.getBoundingClientRect();
      var toRect = target.getBoundingClientRect();
      var distances = drawMeasurement(fromRectLive, toRect);
      var toSelector = getCssSelector(target);
      window.parent.postMessage({
        type: 'selene-tool-measure',
        from: { selector: measureAnchor.selector, rect: { x: fromRectLive.left, y: fromRectLive.top, width: fromRectLive.width, height: fromRectLive.height } },
        to: { selector: toSelector, rect: { x: toRect.left, y: toRect.top, width: toRect.width, height: toRect.height } },
        distances: distances
      }, '*');
      clearMeasureAnchor();
      return;
    }

    if (activeTool === 'eyedropper') {
      var pickForeground = !!e.shiftKey;
      var bg = getEffectiveBackground(target);
      var cs = getComputedStyle(target);
      var fg = rgbStringToRgba(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      var picked = pickForeground ? fg : bg;
      var source = pickForeground ? 'foreground' : 'background';
      window.parent.postMessage({
        type: 'selene-tool-color-pick',
        source: source,
        background: { hex: rgbToHex(bg), rgb: bg, hsl: rgbToHsl(bg) },
        foreground: { hex: rgbToHex(fg), rgb: fg, hsl: rgbToHsl(fg) },
        picked: { hex: rgbToHex(picked), rgb: picked, hsl: rgbToHsl(picked) },
        element: { selector: getCssSelector(target), tagName: target.tagName.toLowerCase() }
      }, '*');
      return;
    }

    if (activeTool === 'comment') {
      // If click is inside an active input, ignore
      if (commentInput && commentInput.wrap.contains(e.target)) return;
      // Finalize any pending input first
      if (commentInput && commentInput.input.value.trim() && commentTarget) {
        finalizeComment();
      } else {
        clearCommentInput();
      }
      commentTarget = { el: target, selector: getCssSelector(target) };
      var box = makeCommentInput(target);
      commentInput = box;
      commentLayer.appendChild(box.wrap);
      box.input.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); finalizeComment(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); clearCommentInput(); }
      });
      box.input.focus();
      return;
    }
  }

  function finalizeComment() {
    if (!commentInput || !commentTarget) { clearCommentInput(); return; }
    var text = commentInput.input.value.trim();
    if (!text) { clearCommentInput(); return; }
    var tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    window.parent.postMessage({
      type: 'selene-tool-comment',
      tempId: tempId,
      elementSelector: commentTarget.selector,
      text: text,
      createdAt: Date.now()
    }, '*');
    clearCommentInput();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (activeTool === 'measure' && measureAnchor) {
        clearMeasureAnchor();
        e.preventDefault();
      } else if (activeTool === 'comment' && commentInput) {
        clearCommentInput();
        e.preventDefault();
      }
    }
  }

  // Refresh overlay positions on scroll/resize
  var rafPending = false;
  var lastSyncedComments = [];
  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      refreshSelectionOverlays();
      refreshCommentPins(lastSyncedComments);
    });
  }
  window.addEventListener('scroll', scheduleRefresh, true);
  window.addEventListener('resize', scheduleRefresh);

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  function setActiveTool(next) {
    activeTool = next;
    // Reset transient state for previous tool
    hideHighlight();
    clearMeasureAnchor();
    clearCommentInput();
    if (next !== 'inspect') clearSelections();
    applyCursor();
  }

  function teardown() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', scheduleRefresh, true);
    window.removeEventListener('resize', scheduleRefresh);
    hideHighlight();
    clearSelections();
    clearMeasureAnchor();
    clearCommentInput();
    commentPins.forEach(function(p) { if (p && p.parentNode) p.parentNode.removeChild(p); });
    commentPins = [];
    [overlay, tooltip, marginBox, paddingBox, contentBox, measureLayer, commentLayer].forEach(function(node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    if (document.body) document.body.style.cursor = '';
    window.__seleneTools = false;
    window.__seleneInspector = false;
  }

  // Listen for messages from parent
  window.addEventListener('message', function(e) {
    if (!e || !e.data || typeof e.data !== 'object') return;
    var t = e.data.type;
    if (t === 'selene-tools-cleanup' || t === 'selene-inspector-cleanup') {
      teardown();
    } else if (t === 'selene-tool-set-active') {
      setActiveTool(e.data.tool || null);
    } else if (t === 'selene-tool-comments-sync') {
      var list = Array.isArray(e.data.comments) ? e.data.comments : [];
      lastSyncedComments = list;
      refreshCommentPins(list);
    }
  });

  applyCursor();
})();
`;

/**
 * Inject the tools script into preview HTML when ANY tool is active.
 * Appends a small bootstrap that sets `window.__seleneActiveTool` first,
 * then the main script — both before the closing </body> or </html> tag.
 */
function injectInspectorScript(html: string, tool: ActiveTool): string {
  if (!tool) return html;
  const safeTool = JSON.stringify(tool);
  const scriptTag = `<script>window.__seleneActiveTool = ${safeTool};</script><script>${TOOLS_SCRIPT}<\/script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${scriptTag}</body>`);
  }
  if (html.includes("</html>")) {
    return html.replace("</html>", `${scriptTag}</html>`);
  }
  return html + scriptTag;
}

/**
 * When the active component is Tailwind mode and the current previewHtml
 * is just the placeholder, trigger server-side compilation via the API.
 *
 * This handles two cases:
 * 1. Component switching — the store rebuilds the placeholder, and this hook
 *    triggers compilation for the newly active Tailwind component.
 * 2. Fallback — if the tool handler's server-side compilation failed, the
 *    bridge sets the placeholder and this hook retries via the API.
 *
 * The generate/edit flow normally provides compiled HTML directly via the
 * tool result bridge, so this hook is a safety net, not the primary path.
 */
function useCompileTailwindPreview() {
  const components = useDesignWorkspaceStore((s) => s.components);
  const activeComponentId = useDesignWorkspaceStore((s) => s.activeComponentId);
  const setPreviewHtml = useDesignWorkspaceStore((s) => s.setPreviewHtml);

  // Track which component+code hash we last compiled to avoid redundant API calls.
  const lastCompiledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeComponentId) return;

    const component = components.find((c) => c.id === activeComponentId);
    if (!component) return;

    // Short-circuit: if the component's code was evicted by the LRU hydration
    // path (`codeStripped: true` or empty `code`), POSTing to the compile API
    // with an empty body just produces `400 Component code is required`.
    // Kick off a rehydration instead — the store update from that fetch will
    // re-trigger this effect with full code and we compile then. During the
    // rehydration gap we paint a lightweight "Restoring preview…" placeholder
    // so the iframe isn't flashing a stale or blank state.
    if (!component.code || component.codeStripped) {
      const requestComponentId = activeComponentId;
      setPreviewHtml(
        `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:ui-sans-serif,system-ui,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="text-align:center;font-size:13px;opacity:0.75;">Restoring preview\u2026</div></body></html>`,
      );
      // Fire-and-forget: errors are surfaced by rehydrateComponentCode via
      // setError. The next effect tick picks up the hydrated code.
      void rehydrateComponentCode(requestComponentId);
      return;
    }

    // Build a content-based cache key using component ID + code hash
    const cacheKey = `${activeComponentId}:${hashCode(component.code)}`;

    // Don't re-request the same content we already compiled
    if (lastCompiledRef.current === cacheKey) return;

    // Capture the component ID at request time for stale-response detection.
    const requestComponentId = activeComponentId;
    const requestCode = component.code;
    const controller = new AbortController();

    fetch("/api/design/compile-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: requestCode, name: component.name }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          html?: string;
          error?: string;
          details?: Array<{ text?: string }>;
        };

        if (!res.ok) {
          const detailText = Array.isArray(data.details)
            ? data.details.map((detail) => detail.text).filter(Boolean).join("\n")
            : "";
          const message = [data.error || `Compile API returned ${res.status}`, detailText]
            .filter(Boolean)
            .join("\n\n");
          throw new Error(message);
        }

        return data;
      })
      .then((data: { html?: string; error?: string }) => {
        const currentId = useDesignWorkspaceStore.getState().activeComponentId;
        if (currentId !== requestComponentId) return;

        if (data.html) {
          lastCompiledRef.current = cacheKey;
          setPreviewHtml(data.html);
        } else if (data.error) {
          const safeError = escapeForHtml(data.error);
          setPreviewHtml(
            `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#f9fafb;"><pre style="white-space:pre-wrap;color:#ef4444;">Compilation Error:\n${safeError}</pre></body></html>`
          );
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[design-preview] compilation failed:", err);
        const currentId = useDesignWorkspaceStore.getState().activeComponentId;
        if (currentId !== requestComponentId) return;
        const msg = err instanceof Error ? err.message : "Unknown error";
        const safeMsg = escapeForHtml(msg);
        setPreviewHtml(
          `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:ui-monospace,monospace;background:#111827;color:#f9fafb;"><pre style="white-space:pre-wrap;color:#ef4444;">Compilation Failed:\n${safeMsg}</pre></body></html>`
        );
      });

    return () => {
      controller.abort();
    };
  }, [activeComponentId, components, setPreviewHtml]);
}

/**
 * Measures available space in a container and returns dimensions.
 * Uses ResizeObserver for live updates when the pane resizes.
 */
function useContainerSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        prev.width === Math.floor(width) && prev.height === Math.floor(height)
          ? prev
          : { width: Math.floor(width), height: Math.floor(height) }
      );
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

type IframeMessage =
  | {
      type: "selene-inspector-select";
      element: InspectedElement;
      action?: "add" | "remove" | "replace";
      multiSelect?: boolean;
    }
  | {
      type: "selene-tool-measure";
      from: Measurement["from"];
      to: Measurement["to"];
      distances: Measurement["distances"];
    }
  | {
      type: "selene-tool-color-pick";
      source: PickedColor["source"];
      background: { hex: string; rgb: PickedColor["rgb"]; hsl: PickedColor["hsl"] };
      foreground: { hex: string; rgb: PickedColor["rgb"]; hsl: PickedColor["hsl"] };
      picked: { hex: string; rgb: PickedColor["rgb"]; hsl: PickedColor["hsl"] };
      element: { selector: string; tagName: string };
    }
  | {
      type: "selene-tool-comment";
      tempId: string;
      elementSelector: string;
      text: string;
      createdAt: number;
    };

function isIframeMessage(value: unknown): value is IframeMessage {
  if (!value || typeof value !== "object") return false;
  const data = value as { type?: unknown };
  return (
    data.type === "selene-inspector-select" ||
    data.type === "selene-tool-measure" ||
    data.type === "selene-tool-color-pick" ||
    data.type === "selene-tool-comment"
  );
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function DesignPreviewFrame() {
  const activeComponentId = useDesignWorkspaceStore((s) => s.activeComponentId);
  const previewHtml = useDesignWorkspaceStore((s) => s.previewHtml);
  const selectedBreakpoint = useDesignWorkspaceStore((s) => s.selectedBreakpoint);
  const setBreakpoint = useDesignWorkspaceStore((s) => s.setBreakpoint);
  const activeTool = useDesignWorkspaceStore((s) => s.activeTool);
  const setActiveTool = useDesignWorkspaceStore((s) => s.setActiveTool);
  const previewTheme = useDesignWorkspaceStore((s) => s.previewTheme);
  const setPreviewTheme = useDesignWorkspaceStore((s) => s.setPreviewTheme);
  const toggleSelectedElement = useDesignWorkspaceStore((s) => s.toggleSelectedElement);
  const setSelectedElements = useDesignWorkspaceStore((s) => s.setSelectedElements);
  const addMeasurement = useDesignWorkspaceStore((s) => s.addMeasurement);
  const addPickedColor = useDesignWorkspaceStore((s) => s.addPickedColor);
  const addComment = useDesignWorkspaceStore((s) => s.addComment);
  const comments = useDesignWorkspaceStore((s) => s.comments);

  // Auto-compile Tailwind components when switching or on first load
  useCompileTailwindPreview();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const available = useContainerSize(containerRef);

  const postToIframe = useCallback((message: unknown) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(message, "*");
  }, []);

  const syncCommentsToIframe = useCallback(
    (list: DesignComment[]) => {
      postToIframe({ type: "selene-tool-comments-sync", comments: list });
    },
    [postToIframe],
  );

  // Listen for tool postMessages from the iframe — validate source
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      // Only accept messages from our own iframe, not arbitrary windows
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!isIframeMessage(e.data)) return;
      const data = e.data;

      if (data.type === "selene-inspector-select") {
        try {
          const element = data.element;
          if (!element || typeof element !== "object") return;
          const action = data.action;
          if (action === "add" || action === "remove") {
            toggleSelectedElement(element);
          } else {
            setSelectedElements([element]);
          }
        } catch (err) {
          console.warn("[design-preview] malformed inspector-select message", err);
        }
        return;
      }

      if (data.type === "selene-tool-measure") {
        try {
          if (!data.from || !data.to || !data.distances) return;
          const measurement: Measurement = {
            id: makeId("m"),
            from: data.from,
            to: data.to,
            distances: data.distances,
            createdAt: Date.now(),
          };
          addMeasurement(measurement);
        } catch (err) {
          console.warn("[design-preview] malformed measure message", err);
        }
        return;
      }

      if (data.type === "selene-tool-color-pick") {
        try {
          const sourceData = data.source === "foreground" ? data.foreground : data.background;
          if (!sourceData || !sourceData.rgb || !sourceData.hsl || !data.element) return;
          const picked: PickedColor = {
            id: makeId("c"),
            hex: sourceData.hex,
            rgb: sourceData.rgb,
            hsl: sourceData.hsl,
            source: data.source,
            element: data.element,
            createdAt: Date.now(),
          };
          addPickedColor(picked);
        } catch (err) {
          console.warn("[design-preview] malformed color-pick message", err);
        }
        return;
      }

      if (data.type === "selene-tool-comment") {
        try {
          if (typeof data.elementSelector !== "string" || typeof data.text !== "string") return;
          const comment: DesignComment = {
            id: makeId("cm"),
            elementSelector: data.elementSelector,
            text: data.text,
            createdAt: data.createdAt,
            resolved: false,
          };
          addComment(comment);
          // The `comments` effect below re-syncs to the iframe whenever the
          // list changes — no explicit sync needed here (would double-roundtrip).
        } catch (err) {
          console.warn("[design-preview] malformed comment message", err);
        }
        return;
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    addComment,
    addMeasurement,
    addPickedColor,
    setSelectedElements,
    toggleSelectedElement,
  ]);

  // When activeTool changes, tell the iframe to switch modes without rebuilding.
  // On the transition to `null`, also send an explicit cleanup so any overlay
  // DOM (anchors, lines, pins, comment input) is fully torn down.
  useEffect(() => {
    postToIframe({ type: "selene-tool-set-active", tool: activeTool });
    if (activeTool === null) {
      postToIframe({ type: "selene-tools-cleanup" });
    }
  }, [activeTool, postToIframe]);

  // Re-sync comments to the iframe whenever the list changes (covers new
  // pins, resolves, deletes, and the post-rebuild handshake on iframe load).
  useEffect(() => {
    syncCommentsToIframe(comments);
  }, [comments, syncCommentsToIframe]);

  // Workspace-level keyboard shortcuts: V/M/I/C
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // If the iframe currently has focus (e.g. user is typing in the in-iframe
      // comment input), don't hijack keys here.
      if (document.activeElement === iframeRef.current) return;
      // Skip when typing in form fields in the parent document.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
        if (target.closest && target.closest('[contenteditable="true"]')) return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "v") {
        setActiveTool(null);
      } else if (key === "m") {
        setActiveTool(activeTool === "measure" ? null : "measure");
      } else if (key === "i") {
        setActiveTool(activeTool === "eyedropper" ? null : "eyedropper");
      } else if (key === "c") {
        setActiveTool(activeTool === "comment" ? null : "comment");
      } else {
        return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, setActiveTool]);

  // Apply selected theme to the preview HTML
  const themedPreviewHtml = applyPreviewTheme(previewHtml, previewTheme);
  const layout = useMemo(
    () =>
      computeDesignPreviewFrameLayout({
        breakpoint: selectedBreakpoint,
        availableWidth: available.width,
        availableHeight: available.height,
      }),
    [selectedBreakpoint, available.width, available.height],
  );
  const previewSrcDoc = useMemo(
    () => injectInspectorScript(themedPreviewHtml, activeTool),
    [themedPreviewHtml, activeTool],
  );

  // After the iframe rebuilds (srcDoc change), re-sync state once it has
  // booted the tools script: re-broadcast the active tool and the full
  // comment list so persistent pins reappear on every rebuild.
  const handleIframeLoad = useCallback(() => {
    const state = useDesignWorkspaceStore.getState();
    postToIframe({ type: "selene-tool-set-active", tool: state.activeTool });
    syncCommentsToIframe(state.comments);
  }, [postToIframe, syncCommentsToIframe]);

  const inspectorEnabled = activeTool === "inspect";

  if (!activeComponentId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a component to preview
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Breakpoint toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2" role="tablist" aria-label="Preview breakpoints">
        {DESIGN_BREAKPOINTS.map((bp) => (
          <Button
            key={bp.name}
            variant={selectedBreakpoint.name === bp.name ? "default" : "ghost"}
            size="sm"
            role="tab"
            aria-selected={selectedBreakpoint.name === bp.name}
            aria-label={bp.width ? `${bp.name} breakpoint (${bp.width}px)` : `${bp.name} mode`}
            onClick={() => setBreakpoint(bp)}
            className="gap-1.5"
          >
            {BREAKPOINT_ICONS[bp.name]}
            <span className="capitalize">{bp.name}</span>
            {bp.width > 0 && <span className="text-xs opacity-60">{bp.width}px</span>}
          </Button>
        ))}
        <div className="mx-1 h-5 w-px bg-border" />
        <Button
          variant={inspectorEnabled ? "default" : "ghost"}
          size="sm"
          aria-label="Toggle element inspector"
          aria-pressed={inspectorEnabled}
          onClick={() => setActiveTool(activeTool === "inspect" ? null : "inspect")}
          className="gap-1.5"
        >
          <Crosshair className="h-4 w-4" />
          <span>Inspect</span>
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button
          variant={activeTool === "measure" ? "default" : "ghost"}
          size="sm"
          aria-label="Measure (M)"
          aria-pressed={activeTool === "measure"}
          title="Measure (M)"
          onClick={() => setActiveTool(activeTool === "measure" ? null : "measure")}
          className="gap-1.5"
        >
          <Ruler className="h-4 w-4" />
          <span>Measure</span>
        </Button>
        <Button
          variant={activeTool === "eyedropper" ? "default" : "ghost"}
          size="sm"
          aria-label="Pick color (I)"
          aria-pressed={activeTool === "eyedropper"}
          title="Pick color (I)"
          onClick={() => setActiveTool(activeTool === "eyedropper" ? null : "eyedropper")}
          className="gap-1.5"
        >
          <Pipette className="h-4 w-4" />
          <span>Pick</span>
        </Button>
        <Button
          variant={activeTool === "comment" ? "default" : "ghost"}
          size="sm"
          aria-label="Comment (C)"
          aria-pressed={activeTool === "comment"}
          title="Comment (C)"
          onClick={() => setActiveTool(activeTool === "comment" ? null : "comment")}
          className="gap-1.5"
        >
          <MessageSquare className="h-4 w-4" />
          <span>Comment</span>
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        {PREVIEW_THEME_OPTIONS.map((option) => (
          <Button
            key={option.value}
            variant={previewTheme === option.value ? "default" : "ghost"}
            size="sm"
            aria-label={`${option.label} preview theme`}
            aria-pressed={previewTheme === option.value}
            onClick={() => setPreviewTheme(option.value)}
            className="gap-1.5"
          >
            {option.icon}
            <span>{option.label}</span>
          </Button>
        ))}
      </div>

      {/* Preview area — measured container */}
      <div
        ref={containerRef}
        className="flex flex-1 items-start justify-center overflow-auto bg-muted/30 p-6"
      >
        <div
          style={{
            width: layout.scaledWidth,
            height: layout.scaledHeight,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: layout.viewportWidth,
              height: layout.viewportHeight,
              transform: `scale(${layout.scale})`,
              transformOrigin: "top left",
            }}
          >
            <iframe
              ref={iframeRef}
              srcDoc={previewSrcDoc}
              sandbox="allow-scripts allow-same-origin allow-popups allow-modals"
              className="h-full w-full border-0"
              style={{ background: "transparent" }}
              title="Design preview"
              onLoad={handleIframeLoad}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
