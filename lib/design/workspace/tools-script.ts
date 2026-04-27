// ---------------------------------------------------------------------------
// Tools script — injected into the iframe at boot UNCONDITIONALLY.
//
// Mode is read from `window.__seleneActiveTool` (initial value: null) and is
// hot-swapped via the `selene-tool-set-active` postMessage. The parent owns
// the active-tool state in the workspace store; this script never rebuilds
// the iframe — switching tools is purely a postMessage, so iframe identity,
// scroll position, and any in-iframe component state survive tool toggles.
//
// Communicates with parent via postMessage. Self-contained, no external deps.
// ---------------------------------------------------------------------------
export const TOOLS_SCRIPT = `
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

  // Measure-mode anchor / transient overlay layer (live drag preview)
  var measureLayer = document.createElement('div');
  measureLayer.id = '__selene-measure-layer';
  measureLayer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';
  document.documentElement.appendChild(measureLayer);

  // Persistent measurement overlays — captured measurements survive tool
  // toggles and re-anchor on iframe rebuild. Mirror the comment-pin pattern:
  // separate layer below comments, parent owns truth, iframe acks resolution.
  var measurementOverlayLayer = document.createElement('div');
  measurementOverlayLayer.id = '__selene-measurement-overlay-layer';
  measurementOverlayLayer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483645;';
  document.documentElement.appendChild(measurementOverlayLayer);

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
    if (el === measureLayer || el === commentLayer || el === measurementOverlayLayer) return true;
    // Anything inside our overlay layers
    if (measureLayer.contains(el) || commentLayer.contains(el) || measurementOverlayLayer.contains(el)) return true;
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
    // Legacy alias: returns the rgba portion of getEffectivePaint for code
    // paths that don't care about the source tier. Kept so internal call
    // sites that only need the colour (no surfacing of badge text) stay
    // small.
    return getEffectivePaint(el).rgba;
  }

  // SHARED WITH paint-detection.ts — keep these helpers in lock-step. The
  // iframe script can't import the TS module at runtime (it's injected as a
  // single self-contained <script>), so we duplicate. Tests live against the
  // TS module.
  function isGradientBgImage(v) {
    if (!v) return false;
    return /\\b(?:linear|radial|conic)-gradient\\s*\\(/i.test(v);
  }

  function parseGradientStops(bgImage) {
    if (!bgImage) return [];
    var stops = [];
    var matches = bgImage.match(/rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*[0-9.]+)?\\s*\\)/g);
    if (!matches) return [];
    for (var i = 0; i < matches.length; i++) {
      var parsed = rgbStringToRgba(matches[i]);
      if (parsed) stops.push(parsed);
    }
    return stops;
  }

  function pickGradientRepresentative(stops) {
    if (!stops || stops.length === 0) return null;
    if (stops.length === 1) return stops[0];
    if (stops.length === 2) {
      return {
        r: Math.round((stops[0].r + stops[1].r) / 2),
        g: Math.round((stops[0].g + stops[1].g) / 2),
        b: Math.round((stops[0].b + stops[1].b) / 2),
        a: (stops[0].a + stops[1].a) / 2
      };
    }
    return stops[Math.floor(stops.length / 2)];
  }

  /**
   * Tiered paint detection: returns { rgba, source } where source is one of
   *   'background'      — solid backgroundColor (current behaviour)
   *   'gradient'        — middle stop of a CSS gradient
   *   'svg-fill'        — SVG element fill (or first SVG ancestor's fill)
   *   'svg-stroke'      — SVG element stroke
   *   'pseudo-before'   — backgroundColor or gradient on ::before
   *   'pseudo-after'    — backgroundColor or gradient on ::after
   * Falls back to white on a totally-transparent stack.
   *
   * Tier ordering rationale:
   *   Tier 1 walks the click target AND ALL ANCESTORS looking for the first
   *   non-transparent solid background-color. This matches what the user
   *   visually sees — an opaque parent painting over a child gradient is the
   *   pixel they clicked, so we report the parent's solid first instead of
   *   the child's gradient. Tier 2 then considers the click target's (and
   *   ancestors') gradient(s). If the user wants the click target's own
   *   gradient (or any non-background paint) to override an ancestor solid,
   *   they can hold Shift to read the foreground color instead.
   */
  function getEffectivePaint(el) {
    if (!el) return { rgba: { r: 255, g: 255, b: 255, a: 1 }, source: 'background' };

    // Tier 1 — solid background, walking up through ancestors INCLUDING
    // documentElement (Tailwind v4 themes commonly paint on <html>).
    var current = el;
    while (current) {
      var cs = getComputedStyle(current);
      var rgba = rgbStringToRgba(cs.backgroundColor);
      if (rgba && rgba.a > 0) return { rgba: rgba, source: 'background' };
      current = current.parentElement;
    }

    // Tier 2 — gradient on the element or any ancestor.
    current = el;
    while (current) {
      var cs2 = getComputedStyle(current);
      var bgImg = cs2.backgroundImage;
      if (isGradientBgImage(bgImg)) {
        var stops = parseGradientStops(bgImg);
        var rep = pickGradientRepresentative(stops);
        if (rep && rep.a > 0) return { rgba: rep, source: 'gradient' };
      }
      current = current.parentElement;
    }

    // Tier 3 — SVG fill / stroke. Walk up to the nearest SVG element when
    // the click target is a non-SVG node nested inside an <svg> wrapper.
    var svgRoot = null;
    if (el instanceof SVGElement) svgRoot = el;
    else if (el.closest) {
      var maybe = el.closest('svg');
      if (maybe) svgRoot = maybe;
    }
    if (svgRoot) {
      // Prefer the click target itself if it has a meaningful fill/stroke,
      // otherwise climb to the first ancestor that does.
      var probes = [el instanceof SVGElement ? el : svgRoot];
      if (probes[0] !== svgRoot) probes.push(svgRoot);
      for (var p = 0; p < probes.length; p++) {
        var probe = probes[p];
        if (!probe) continue;
        var psr = getComputedStyle(probe);
        var fillRgba = rgbStringToRgba(psr.fill);
        if (fillRgba && fillRgba.a > 0 && psr.fill !== 'none') {
          return { rgba: fillRgba, source: 'svg-fill' };
        }
        var strokeRgba = rgbStringToRgba(psr.stroke);
        if (strokeRgba && strokeRgba.a > 0 && psr.stroke !== 'none') {
          return { rgba: strokeRgba, source: 'svg-stroke' };
        }
      }
    }

    // Tier 4 — pseudo-elements. ::before then ::after. Each can contribute
    // either a solid backgroundColor or a gradient backgroundImage.
    var pseudos = ['::before', '::after'];
    for (var pi = 0; pi < pseudos.length; pi++) {
      var pseudoCs = getComputedStyle(el, pseudos[pi]);
      if (!pseudoCs) continue;
      var pBg = rgbStringToRgba(pseudoCs.backgroundColor);
      if (pBg && pBg.a > 0) {
        return { rgba: pBg, source: pseudos[pi] === '::before' ? 'pseudo-before' : 'pseudo-after' };
      }
      if (isGradientBgImage(pseudoCs.backgroundImage)) {
        var pStops = parseGradientStops(pseudoCs.backgroundImage);
        var pRep = pickGradientRepresentative(pStops);
        if (pRep && pRep.a > 0) {
          return { rgba: pRep, source: pseudos[pi] === '::before' ? 'pseudo-before' : 'pseudo-after' };
        }
      }
    }

    return { rgba: { r: 255, g: 255, b: 255, a: 1 }, source: 'background' };
  }

  // --- Comment mode ---
  var commentInput = null;
  var commentTarget = null;

  function clearCommentInput() {
    if (commentInput && commentInput.wrap.parentNode) commentInput.wrap.parentNode.removeChild(commentInput.wrap);
    commentInput = null;
    commentTarget = null;
  }

  function autoGrowTextarea(ta) {
    // Re-measure: temporarily collapse, then grow to scrollHeight, capped at
    // ~6 rows. Above the cap we let the textarea scroll internally.
    ta.style.height = 'auto';
    var lineHeight = 18; // matches font:13px/1.4 → ~18.2px
    var maxHeight = lineHeight * 6 + 8; // +padding
    var next = Math.min(ta.scrollHeight, maxHeight);
    ta.style.height = next + 'px';
    ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function makeCommentInput(el) {
    var rect = el.getBoundingClientRect();
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:auto;background:#fff;border:1px solid #d4d4d8;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.12);padding:6px;display:flex;gap:4px;align-items:flex-start;';
    wrap.style.left = Math.min(window.innerWidth - 240, rect.right + 4) + 'px';
    wrap.style.top = Math.max(4, rect.top - 8) + 'px';

    // Textarea (auto-grow, IME-safe). Replaces the legacy <input type="text">
    // — Enter on a Korean/Japanese/Chinese IME composition would otherwise
    // submit the comment instead of committing the candidate.
    var input = document.createElement('textarea');
    input.placeholder = 'Add a comment…';
    input.rows = 1;
    input.setAttribute('aria-label', 'Comment text');
    input.style.cssText = 'border:none;outline:none;resize:none;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;width:200px;min-height:18px;height:18px;background:transparent;color:#111;overflow-y:hidden;';
    wrap.appendChild(input);

    return { wrap: wrap, input: input, isComposing: false };
  }

  // Map of commentId -> { comment, pin }. Allows incremental diff updates
  // without rebuilding every pin on every change. Position-refresh on
  // scroll/resize iterates the live entries.
  var commentPinsById = Object.create(null);
  // Ordered id list, used to assign 1-based pin numbers consistently with the
  // parent store's array order.
  var commentOrder = [];

  function removeCommentPin(id) {
    var entry = commentPinsById[id];
    if (!entry) return;
    if (entry.pin && entry.pin.parentNode) entry.pin.parentNode.removeChild(entry.pin);
    delete commentPinsById[id];
    var idx = commentOrder.indexOf(id);
    if (idx !== -1) commentOrder.splice(idx, 1);
  }

  function clearAllCommentPins() {
    commentOrder.forEach(function(id) {
      var entry = commentPinsById[id];
      if (entry && entry.pin && entry.pin.parentNode) entry.pin.parentNode.removeChild(entry.pin);
    });
    commentPinsById = Object.create(null);
    commentOrder = [];
  }

  function renumberCommentPins() {
    commentOrder.forEach(function(id, idx) {
      var entry = commentPinsById[id];
      if (entry && entry.pin) entry.pin.textContent = String(idx + 1);
    });
  }

  function buildCommentPin(comment) {
    var pin = document.createElement('div');
    pin.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:20px;height:20px;border-radius:9999px;background:' + (comment.resolved ? '#94a3b8' : '#f59e0b') + ';color:#fff;font:11px/20px ui-sans-serif,system-ui,sans-serif;text-align:center;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.25);';
    return pin;
  }

  function positionCommentPin(pin, el) {
    var rect = el.getBoundingClientRect();
    pin.style.left = (rect.right - 10) + 'px';
    pin.style.top = (rect.top - 10) + 'px';
  }

  function applyCommentAdd(comment) {
    if (commentPinsById[comment.id]) return; // already present
    var el = null;
    try { el = document.querySelector(comment.elementSelector); } catch (err) { /* invalid selector */ }
    var pin = buildCommentPin(comment);
    if (el) {
      positionCommentPin(pin, el);
      commentLayer.appendChild(pin);
    }
    commentPinsById[comment.id] = { comment: comment, el: el, pin: pin, mounted: !!el };
    commentOrder.push(comment.id);
  }

  function applyCommentUpdate(comment) {
    var entry = commentPinsById[comment.id];
    if (!entry) { applyCommentAdd(comment); return; }
    // Re-resolve in case the selector changed (the parent allows
    // updateComment to patch elementSelector, even though the iframe never
    // generates such an update itself).
    if (entry.comment.elementSelector !== comment.elementSelector) {
      try { entry.el = document.querySelector(comment.elementSelector); } catch (err) { entry.el = null; }
    }
    entry.comment = comment;
    // Re-paint colour for resolved/unresolved transitions.
    entry.pin.style.background = comment.resolved ? '#94a3b8' : '#f59e0b';
    if (entry.el) {
      if (!entry.mounted) { commentLayer.appendChild(entry.pin); entry.mounted = true; }
      positionCommentPin(entry.pin, entry.el);
    } else if (entry.mounted && entry.pin.parentNode) {
      entry.pin.parentNode.removeChild(entry.pin);
      entry.mounted = false;
    }
  }

  function bootstrapCommentPins(comments) {
    clearAllCommentPins();
    if (!comments || !comments.length) { ackCommentResolution(); return; }
    comments.forEach(function(c) { applyCommentAdd(c); });
    renumberCommentPins();
    ackCommentResolution();
  }

  function applyCommentDiff(diff) {
    var added = (diff && Array.isArray(diff.added)) ? diff.added : [];
    var removed = (diff && Array.isArray(diff.removed)) ? diff.removed : [];
    var updated = (diff && Array.isArray(diff.updated)) ? diff.updated : [];
    removed.forEach(function(id) { removeCommentPin(id); });
    updated.forEach(function(c) { applyCommentUpdate(c); });
    added.forEach(function(c) { applyCommentAdd(c); });
    renumberCommentPins();
    ackCommentResolution();
  }

  // Back-compat wrapper for callers that still pass a full array (bootstrap
  // path on iframe rebuild). Used by both legacy "comments: [...]" payloads
  // and the explicit "bootstrap" shape.
  function refreshCommentPins(comments) {
    bootstrapCommentPins(comments || []);
  }

  function refreshLiveCommentPositions() {
    commentOrder.forEach(function(id) {
      var entry = commentPinsById[id];
      if (!entry) return;
      if (entry.el && entry.el.isConnected) {
        if (!entry.mounted) { commentLayer.appendChild(entry.pin); entry.mounted = true; }
        positionCommentPin(entry.pin, entry.el);
      } else if (entry.mounted && entry.pin.parentNode) {
        entry.pin.parentNode.removeChild(entry.pin);
        entry.mounted = false;
      }
    });
  }

  function ackCommentResolution() {
    var resolved = [];
    var unresolved = [];
    commentOrder.forEach(function(id) {
      var entry = commentPinsById[id];
      if (!entry) return;
      // Re-query at ack time — the document may have mutated since add.
      var el = null;
      try { el = document.querySelector(entry.comment.elementSelector); } catch (err) { el = null; }
      entry.el = el;
      if (el) resolved.push(id);
      else unresolved.push(id);
    });
    try {
      window.parent.postMessage({
        type: 'selene-tool-comments-resolved',
        resolved: resolved,
        unresolved: unresolved
      }, '*');
    } catch (err) { /* parent gone */ }
  }

  // --- Persistent measurement overlays ---
  // Mirrors the comment-pin pattern: each measurement is keyed by id and
  // re-resolved against the current DOM on every parent->iframe sync. SVG
  // arrows + a midpoint badge are rendered on the dedicated
  // measurementOverlayLayer (below comments, above selection box).
  var measurementOverlaysById = Object.create(null);
  var measurementOrder = [];
  var MEASUREMENT_STROKE = '#3b82f6';
  // Amber palette for orphaned measurements — keeps the in-iframe overlay
  // consistent with the composer chip and side-panel chip, which both flag
  // a stale/orphaned measurement in amber. Without this, the iframe view
  // silently disappears while the chip + panel show amber, which is
  // confusing.
  var MEASUREMENT_STROKE_ORPHANED = '#f59e0b';

  function buildMeasurementOverlay(measurement) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';

    var defs = document.createElementNS(ns, 'defs');
    // Arrow markers — one per direction so we can attach to start/end.
    var markerStart = document.createElementNS(ns, 'marker');
    markerStart.setAttribute('id', '__selene-arrow-start-' + measurement.id);
    markerStart.setAttribute('viewBox', '0 0 10 10');
    markerStart.setAttribute('refX', '5');
    markerStart.setAttribute('refY', '5');
    markerStart.setAttribute('markerWidth', '6');
    markerStart.setAttribute('markerHeight', '6');
    markerStart.setAttribute('orient', 'auto-start-reverse');
    var pathStart = document.createElementNS(ns, 'path');
    pathStart.setAttribute('d', 'M 10 0 L 0 5 L 10 10 z');
    pathStart.setAttribute('fill', MEASUREMENT_STROKE);
    markerStart.appendChild(pathStart);

    var markerEnd = document.createElementNS(ns, 'marker');
    markerEnd.setAttribute('id', '__selene-arrow-end-' + measurement.id);
    markerEnd.setAttribute('viewBox', '0 0 10 10');
    markerEnd.setAttribute('refX', '5');
    markerEnd.setAttribute('refY', '5');
    markerEnd.setAttribute('markerWidth', '6');
    markerEnd.setAttribute('markerHeight', '6');
    markerEnd.setAttribute('orient', 'auto');
    var pathEnd = document.createElementNS(ns, 'path');
    pathEnd.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    pathEnd.setAttribute('fill', MEASUREMENT_STROKE);
    markerEnd.appendChild(pathEnd);

    defs.appendChild(markerStart);
    defs.appendChild(markerEnd);
    svg.appendChild(defs);

    var line = document.createElementNS(ns, 'line');
    line.setAttribute('stroke', MEASUREMENT_STROKE);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('marker-start', 'url(#__selene-arrow-start-' + measurement.id + ')');
    line.setAttribute('marker-end', 'url(#__selene-arrow-end-' + measurement.id + ')');
    svg.appendChild(line);

    var badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;background:' + MEASUREMENT_STROKE + ';color:#fff;font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 5px;border-radius:3px;transform:translate(-50%,-50%);white-space:nowrap;font-weight:600;';

    return { svg: svg, line: line, badge: badge, markerStartFill: pathStart, markerEndFill: pathEnd };
  }

  function applyOverlayPaint(entry) {
    var orphaned = !!(entry.measurement && entry.measurement.orphaned);
    var stroke = orphaned ? MEASUREMENT_STROKE_ORPHANED : MEASUREMENT_STROKE;
    entry.line.setAttribute('stroke', stroke);
    // Drop opacity on orphaned overlays so they read as "stale" without
    // visually competing with live measurements.
    entry.svg.style.opacity = orphaned ? '0.5' : '1';
    entry.badge.style.background = stroke;
    entry.badge.style.opacity = orphaned ? '0.85' : '1';
    // Repaint the SVG arrow markers — they're drawn with 'fill' rather than
    // 'stroke', so we need to dive into the marker children.
    if (entry.markerStartFill) entry.markerStartFill.setAttribute('fill', stroke);
    if (entry.markerEndFill) entry.markerEndFill.setAttribute('fill', stroke);
  }

  function positionMeasurementOverlay(entry) {
    if (!entry.fromEl || !entry.toEl) return;
    var fr = entry.fromEl.getBoundingClientRect();
    var tr = entry.toEl.getBoundingClientRect();
    var fcx = fr.left + fr.width / 2;
    var fcy = fr.top + fr.height / 2;
    var tcx = tr.left + tr.width / 2;
    var tcy = tr.top + tr.height / 2;
    entry.line.setAttribute('x1', String(fcx));
    entry.line.setAttribute('y1', String(fcy));
    entry.line.setAttribute('x2', String(tcx));
    entry.line.setAttribute('y2', String(tcy));
    var dx = tcx - fcx;
    var dy = tcy - fcy;
    var euclidean = Math.sqrt(dx * dx + dy * dy);
    var label;
    // Axis-aligned segments get the "dx × dy" form; diagonal segments fall
    // back to the euclidean magnitude.
    if (Math.abs(dx) < 0.5) {
      label = Math.round(Math.abs(dy)) + 'px';
    } else if (Math.abs(dy) < 0.5) {
      label = Math.round(Math.abs(dx)) + 'px';
    } else {
      label = Math.round(euclidean) + 'px';
    }
    if (entry.measurement && entry.measurement.orphaned) {
      label += ' (stale)';
    }
    entry.badge.textContent = label;
    entry.badge.style.left = ((fcx + tcx) / 2) + 'px';
    entry.badge.style.top = ((fcy + tcy) / 2) + 'px';
    applyOverlayPaint(entry);
  }

  function mountMeasurementOverlay(m) {
    if (measurementOverlaysById[m.id]) return;
    var fromEl = null, toEl = null;
    try { fromEl = document.querySelector(m.from.selector); } catch (err) { /* invalid selector */ }
    try { toEl = document.querySelector(m.to.selector); } catch (err) { /* invalid selector */ }
    var built = buildMeasurementOverlay(m);
    var entry = {
      measurement: m,
      fromEl: fromEl,
      toEl: toEl,
      svg: built.svg,
      line: built.line,
      badge: built.badge,
      markerStartFill: built.markerStartFill,
      markerEndFill: built.markerEndFill,
      mounted: false
    };
    if (fromEl && toEl) {
      measurementOverlayLayer.appendChild(built.svg);
      measurementOverlayLayer.appendChild(built.badge);
      entry.mounted = true;
      positionMeasurementOverlay(entry);
    }
    measurementOverlaysById[m.id] = entry;
    measurementOrder.push(m.id);
  }

  function unmountMeasurementOverlay(id) {
    var entry = measurementOverlaysById[id];
    if (!entry) return;
    if (entry.svg && entry.svg.parentNode) entry.svg.parentNode.removeChild(entry.svg);
    if (entry.badge && entry.badge.parentNode) entry.badge.parentNode.removeChild(entry.badge);
    delete measurementOverlaysById[id];
    var idx = measurementOrder.indexOf(id);
    if (idx !== -1) measurementOrder.splice(idx, 1);
  }

  function clearAllMeasurementOverlays() {
    measurementOrder.slice().forEach(function(id) { unmountMeasurementOverlay(id); });
    measurementOverlaysById = Object.create(null);
    measurementOrder = [];
  }

  function applyMeasurementUpdate(m) {
    var entry = measurementOverlaysById[m.id];
    if (!entry) { mountMeasurementOverlay(m); return; }
    // Re-resolve if either selector changed.
    if (entry.measurement.from.selector !== m.from.selector) {
      try { entry.fromEl = document.querySelector(m.from.selector); } catch (err) { entry.fromEl = null; }
    }
    if (entry.measurement.to.selector !== m.to.selector) {
      try { entry.toEl = document.querySelector(m.to.selector); } catch (err) { entry.toEl = null; }
    }
    entry.measurement = m;
    if (entry.fromEl && entry.toEl) {
      if (!entry.mounted) {
        measurementOverlayLayer.appendChild(entry.svg);
        measurementOverlayLayer.appendChild(entry.badge);
        entry.mounted = true;
      }
      positionMeasurementOverlay(entry);
    } else if (entry.mounted) {
      if (entry.svg.parentNode) entry.svg.parentNode.removeChild(entry.svg);
      if (entry.badge.parentNode) entry.badge.parentNode.removeChild(entry.badge);
      entry.mounted = false;
    }
  }

  function bootstrapMeasurementOverlays(measurements) {
    clearAllMeasurementOverlays();
    if (!measurements || !measurements.length) { ackMeasurementResolution(); return; }
    measurements.forEach(function(m) { mountMeasurementOverlay(m); });
    ackMeasurementResolution();
  }

  function applyMeasurementsDiff(diff) {
    var added = (diff && Array.isArray(diff.added)) ? diff.added : [];
    var removed = (diff && Array.isArray(diff.removed)) ? diff.removed : [];
    var updated = (diff && Array.isArray(diff.updated)) ? diff.updated : [];
    removed.forEach(function(id) { unmountMeasurementOverlay(id); });
    updated.forEach(function(m) { applyMeasurementUpdate(m); });
    added.forEach(function(m) { mountMeasurementOverlay(m); });
    ackMeasurementResolution();
  }

  function refreshLiveMeasurementPositions() {
    measurementOrder.forEach(function(id) {
      var entry = measurementOverlaysById[id];
      if (!entry) return;
      // Re-query if the cached element was unmounted (DOM mutation between
      // syncs). Cheap: querySelector is only triggered when the cached node
      // dropped out of the document.
      if (entry.fromEl && !entry.fromEl.isConnected) {
        try { entry.fromEl = document.querySelector(entry.measurement.from.selector); } catch (err) { entry.fromEl = null; }
      }
      if (entry.toEl && !entry.toEl.isConnected) {
        try { entry.toEl = document.querySelector(entry.measurement.to.selector); } catch (err) { entry.toEl = null; }
      }
      if (entry.fromEl && entry.toEl) {
        if (!entry.mounted) {
          measurementOverlayLayer.appendChild(entry.svg);
          measurementOverlayLayer.appendChild(entry.badge);
          entry.mounted = true;
        }
        positionMeasurementOverlay(entry);
      } else if (entry.mounted) {
        if (entry.svg.parentNode) entry.svg.parentNode.removeChild(entry.svg);
        if (entry.badge.parentNode) entry.badge.parentNode.removeChild(entry.badge);
        entry.mounted = false;
      }
    });
  }

  function ackMeasurementResolution() {
    var resolved = [];
    var unresolved = [];
    measurementOrder.forEach(function(id) {
      var entry = measurementOverlaysById[id];
      if (!entry) return;
      var fromEl = null, toEl = null;
      try { fromEl = document.querySelector(entry.measurement.from.selector); } catch (err) { fromEl = null; }
      try { toEl = document.querySelector(entry.measurement.to.selector); } catch (err) { toEl = null; }
      entry.fromEl = fromEl;
      entry.toEl = toEl;
      if (fromEl && toEl) resolved.push(id);
      else unresolved.push(id);
    });
    try {
      window.parent.postMessage({
        type: 'selene-tool-measurements-resolved',
        resolved: resolved,
        unresolved: unresolved
      }, '*');
    } catch (err) { /* parent gone */ }
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
    if (!activeTool) return;
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
      var paint = getEffectivePaint(target);
      var hex = rgbToHex(paint.rgba);
      var sourceLabel = paint.source === 'gradient' ? ' • from gradient'
        : paint.source === 'svg-fill' ? ' • SVG fill'
        : paint.source === 'svg-stroke' ? ' • SVG stroke'
        : paint.source === 'pseudo-before' ? ' • ::before'
        : paint.source === 'pseudo-after' ? ' • ::after'
        : '';
      var swatch = '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + hex + ';margin-right:6px;vertical-align:middle;border:1px solid rgba(255,255,255,0.4);"></span>';
      showTooltip(swatch + escapeHtml(hex + sourceLabel), e.clientX, e.clientY);
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
      var paintResult = getEffectivePaint(target);
      var bg = paintResult.rgba;
      var cs = getComputedStyle(target);
      var fg = rgbStringToRgba(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      var picked = pickForeground ? fg : bg;
      var source = pickForeground ? 'foreground' : paintResult.source;
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
      // (Note: clicks inside an active comment input are already filtered
      // upstream — getEventTarget skips commentLayer descendants and the
      // earlier "if (!target) return;" bails before we get here.)
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
      // IME composition tracking — some browsers (notably older Safari /
      // certain Korean IMEs) don't expose KeyboardEvent.isComposing reliably,
      // so we track it ourselves as a safety net.
      box.input.addEventListener('compositionstart', function() { box.isComposing = true; });
      box.input.addEventListener('compositionend', function() { box.isComposing = false; });
      box.input.addEventListener('input', function() { autoGrowTextarea(box.input); });
      box.input.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') {
          // Don't submit while an IME candidate is being committed.
          if (ev.isComposing || ev.keyCode === 229 || box.isComposing) return;
          // Shift+Enter inserts a newline — let the default fire and just grow.
          if (ev.shiftKey) return;
          ev.preventDefault();
          finalizeComment();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          clearCommentInput();
        }
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
  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      refreshSelectionOverlays();
      refreshLiveCommentPositions();
      refreshLiveMeasurementPositions();
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

  // Listen for messages from parent. We never tear the script down: the
  // iframe is no longer rebuilt on tool switch, so a destructive teardown
  // would leave the bus deaf to subsequent activations. Cleanup is treated
  // as a soft deactivate (equivalent to set-active null) and clears all
  // transient overlays.
  window.addEventListener('message', function(e) {
    if (!e || !e.data || typeof e.data !== 'object') return;
    var t = e.data.type;
    if (t === 'selene-tools-cleanup' || t === 'selene-inspector-cleanup') {
      setActiveTool(null);
    } else if (t === 'selene-tool-set-active') {
      setActiveTool(e.data.tool || null);
    } else if (t === 'selene-tool-comments-sync') {
      // Three accepted shapes:
      //   { bootstrap: DesignComment[] } — full reseed (iframe rebuild)
      //   { comments: DesignComment[] } — legacy full-array (back-compat)
      //   { diff: { added, removed, updated } } — incremental update
      if (Array.isArray(e.data.bootstrap)) {
        bootstrapCommentPins(e.data.bootstrap);
      } else if (Array.isArray(e.data.comments)) {
        bootstrapCommentPins(e.data.comments);
      } else if (e.data.diff && typeof e.data.diff === 'object') {
        applyCommentDiff(e.data.diff);
      }
    } else if (t === 'selene-tool-measurements-sync') {
      // Same envelope shape as comments — bootstrap or diff.
      if (Array.isArray(e.data.bootstrap)) {
        bootstrapMeasurementOverlays(e.data.bootstrap);
      } else if (e.data.diff && typeof e.data.diff === 'object') {
        applyMeasurementsDiff(e.data.diff);
      }
    }
  });

  applyCursor();
})();
`;
