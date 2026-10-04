// I Love Fonts – Font Finder
// content.js — selection mode + click-to-detect (no external libraries).
// Styling lives in content.css (ff-... selectors).
//
// Detection layers:
//  - getComputedStyle() gives the *declared* stack (handles inheritance).
//  - document.fonts (Font Loading API) verifies which declared faces are
//    actually loaded on the page. We report "Declared" vs "Detected" and a
//    Font Status, and never claim a face is rendered when the APIs cannot
//    prove it (those cases are labelled "Declared font" / "Fallback").
//
// Flow:
//  - Popup sends { type: "ACTIVATE_FONT_FINDER" } -> enter selection mode
//    (indicator + crosshair cursor + hover highlight).
//  - Hovering text INSTANTLY shows a small floating tooltip near the cursor
//    with the primary font name + weight/size. No click required.
//  - User may click a highlighted text element for the full detail card
//    (detectTypography -> persist -> showPanel), which exits selection mode.
//  - Escape exits selection mode and/or closes the card; all overlays
//    (tooltip, highlight, indicator) are removed.

(() => {
  // Guard against double-injection (static content_scripts + programmatic
  // chrome.scripting.executeScript from the popup).
  if (window.__ILF_FONT_FINDER_LOADED) {
    return;
  }
  window.__ILF_FONT_FINDER_LOADED = true;

  var MESSAGE_ACTIVATE = 'ACTIVATE_FONT_FINDER';
  var MESSAGE_DEACTIVATE = 'DEACTIVATE_FONT_FINDER';

  var INDICATOR_ID = 'ff-font-finder-indicator';
  var PANEL_ID = 'ff-font-finder-card';
  var TOAST_ID = 'ff-font-finder-toast';
  var HOVER_TIP_ID = 'ff-font-finder-hover';
  var ACTIVE_CLASS = 'ff-active';
  var HIGHLIGHT_ATTR = 'data-ff-highlight';

  // Hover tooltip tuning: cursor offset so the tip never covers the text,
  // and a capped ancestor walk for resolving text-less children.
  var HOVER_OFFSET_X = 16;
  var HOVER_OFFSET_Y = 18;
  var HOVER_WALK_DEPTH = 6;

  var IGNORED_TAGS = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEMPLATE: true,
    HEAD: true,
    META: true,
    LINK: true,
    TITLE: true
  };

  var WEIGHT_NAMES = {
    100: 'Thin',
    200: 'Extra Light',
    300: 'Light',
    400: 'Regular',
    500: 'Medium',
    600: 'Semi Bold',
    700: 'Bold',
    800: 'Extra Bold',
    900: 'Black'
  };

  var isActive = false;
  var highlightedElement = null;
  var listenersAttached = false;
  var lastResult = null;

  // Hover tooltip state. A single reused node keeps hover lightweight:
  // no create/remove churn while the mouse moves.
  var hoverTip = null;
  var hoverTipName = null;
  var hoverTipMeta = null;
  var hoverElement = null;
  var hoverSignature = null;
  var mouseX = 0;
  var mouseY = 0;
  var hoverFramePending = false;
  var hoverTipW = 0;
  var hoverTipH = 0;

  // ---------- Floating indicator ----------

  function showIndicator() {
    if (document.getElementById(INDICATOR_ID)) {
      return;
    }
    var badge = document.createElement('div');
    badge.id = INDICATOR_ID;
    var dot = document.createElement('span');
    dot.className = 'ff-dot';
    dot.setAttribute('aria-hidden', 'true');
    var label = document.createElement('span');
    // textContent only — no HTML injection risk, no interference.
    label.textContent = 'I Love Fonts';
    var hint = document.createElement('span');
    hint.className = 'ff-hint';
    hint.textContent = '· Active · Esc to exit';
    badge.appendChild(dot);
    badge.appendChild(label);
    badge.appendChild(hint);
    document.documentElement.appendChild(badge);
  }

  function hideIndicator() {
    var badge = document.getElementById(INDICATOR_ID);
    if (badge && badge.parentNode) {
      badge.parentNode.removeChild(badge);
    }
  }

  // ---------- Highlight (non-destructive) ----------

  function isOwnUI(element) {
    if (!element) {
      return false;
    }
    if (
      element.id === INDICATOR_ID ||
      element.id === PANEL_ID ||
      element.id === TOAST_ID ||
      element.id === HOVER_TIP_ID
    ) {
      return true;
    }
    if (element.closest) {
      return Boolean(
        element.closest('#' + INDICATOR_ID) ||
          element.closest('#' + PANEL_ID) ||
          element.closest('#' + TOAST_ID) ||
          element.closest('#' + HOVER_TIP_ID)
      );
    }
    return false;
  }

  function hasDirectText(element) {
    var nodes = element.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  function isTextElement(element) {
    if (!element || element.nodeType !== 1) {
      return false;
    }
    if (IGNORED_TAGS[element.tagName]) {
      return false;
    }
    if (isOwnUI(element)) {
      return false;
    }
    return hasDirectText(element);
  }

  function highlight(element) {
    if (highlightedElement === element) {
      return;
    }
    clearHighlight();
    highlightedElement = element;
    element.setAttribute(HIGHLIGHT_ATTR, 'true');
  }

  function clearHighlight() {
    if (highlightedElement) {
      highlightedElement.removeAttribute(HIGHLIGHT_ATTR);
      highlightedElement = null;
    }
  }

  // ---------- Font detection ----------

  // Generic families are always "available" (the browser picks a default
  // face) but the exact rendered face is not verifiable via any API, so
  // resolving to one always means Fallback, never Loaded.
  var GENERIC_FAMILIES = {
    serif: true,
    'sans-serif': true,
    monospace: true,
    cursive: true,
    fantasy: true,
    'system-ui': true,
    'ui-serif': true,
    'ui-sans-serif': true,
    'ui-monospace': true,
    'ui-rounded': true,
    emoji: true,
    math: true,
    fangsong: true
  };

  // Split a font-family stack on top-level commas (respecting quotes) so
  // values like `"Some, Font", Arial` parse correctly.
  function splitFontStack(stack) {
    var parts = [];
    var current = '';
    var quote = null;
    for (var i = 0; i < stack.length; i++) {
      var ch = stack[i];
      if (quote) {
        current += ch;
        if (ch === quote) {
          quote = null;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === ',') {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) {
      parts.push(current.trim());
    }
    return parts.filter(Boolean);
  }

  function getPrimaryFontFamily(fontFamilyStack) {
    var first = splitFontStack(String(fontFamilyStack || ''))[0] || '';
    // Strip surrounding quotes: "Inter" -> Inter
    return first.replace(/^["']|["']$/g, '').trim();
  }

  function stripFamilyQuotes(name) {
    return String(name || '').replace(/^["']|["']$/g, '').trim();
  }

  // ---------- Google Fonts link (no API, no download) ----------
  //
  // Verification prefers the page's actual loaded sources over assuming a
  // name exists on Google Fonts:
  //  - <link href="...fonts.googleapis.com..."> family= params (css + css2)
  //  - @font-face rules whose src points at fonts.gstatic.com/googleapis
  // A family is "verified" only when it appears in one of those sources
  // (case-insensitive). Anything else falls back to a Google Fonts search.
  // URLs:
  //  - Verified:   https://fonts.google.com/specimen/<Family+With+Pluses>
  //  - Unverified: https://fonts.google.com/?query=<encoded>
  // Opened via the background worker with chrome.tabs.create().

  function cleanFamilyName(name) {
    return stripFamilyQuotes(name).replace(/\s+/g, ' ').trim();
  }

  function stripVariableSuffix(name) {
    // Variable faces (e.g. "Inter Variable") still live under the base
    // specimen page, so link the base family.
    return String(name || '')
      .replace(/\s+variable$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeForCompare(name) {
    return stripVariableSuffix(cleanFamilyName(name)).toLowerCase();
  }

  function buildGoogleFontsSpecimenUrl(family) {
    var clean = stripVariableSuffix(cleanFamilyName(family));
    if (!clean) {
      return '';
    }
    // Google Fonts specimen pages use "+" for spaces:
    // "Plus Jakarta Sans" -> Plus+Jakarta+Sans. encodeURIComponent handles
    // special characters; only the %20 form is converted to "+".
    var encoded = encodeURIComponent(clean).replace(/%20/g, '+');
    return 'https://fonts.google.com/specimen/' + encoded;
  }

  function buildGoogleFontsSearchUrl(family) {
    var clean = stripVariableSuffix(cleanFamilyName(family));
    if (!clean) {
      return 'https://fonts.google.com/';
    }
    return 'https://fonts.google.com/?query=' + encodeURIComponent(clean);
  }

  // Extract family names from a Google Fonts stylesheet URL. Handles:
  //  - css2: ?family=Inter:wght@400;700&family=Plus+Jakarta+Sans:ital,wght@...
  //  - css v1: ?family=Roboto|Open+Sans
  function parseGoogleFontsHref(href) {
    var families = [];
    function pushOne(raw) {
      var name = String(raw || '').split(':')[0].replace(/\+/g, ' ');
      name = stripVariableSuffix(cleanFamilyName(name));
      if (name) {
        families.push(name);
      }
    }
    try {
      var url = new URL(String(href), window.location.href);
      var params = url.searchParams.getAll('family');
      params.forEach(function (p) {
        String(p || '')
          .split('|')
          .forEach(pushOne);
      });
      if (families.length > 0) {
        return families;
      }
    } catch (e) {
      // Fall through to regex parsing below.
    }
    try {
      var re = /[?&]family=([^&#;]+)/g;
      var m;
      var rawHref = String(href || '');
      var hit = false;
      while ((m = re.exec(rawHref)) !== null) {
        hit = true;
        var decoded = '';
        try {
          decoded = decodeURIComponent(m[1].replace(/\+/g, ' '));
        } catch (e2) {
          decoded = m[1].replace(/\+/g, ' ');
        }
        decoded.split('|').forEach(pushOne);
      }
      if (hit) {
        return families;
      }
    } catch (e) {
      // Ignore malformed hrefs.
    }
    return families;
  }

  function isGoogleFontsUrl(text) {
    var lower = String(text || '').toLowerCase();
    return (
      lower.indexOf('fonts.googleapis.com') !== -1 ||
      lower.indexOf('fonts.gstatic.com') !== -1
    );
  }

  // Scan the page's actual loaded sources for Google-served families.
  // Returns a map of normalized name -> display name. Rebuilt on every
  // detection (click-only, never on hover) so late-injected @font-face
  // rules are picked up. Never throws; cross-origin sheets are skipped.
  function collectGoogleFontsFamilies() {
    var found = {};
    function add(name) {
      var clean = stripVariableSuffix(cleanFamilyName(name));
      if (!clean) {
        return;
      }
      if (GENERIC_FAMILIES[clean.toLowerCase()]) {
        return;
      }
      found[clean.toLowerCase()] = clean;
    }
    // 1. Stylesheet links (<link> + @import).
    try {
      var links = document.querySelectorAll('link[href]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href') || '';
        if (!isGoogleFontsUrl(href)) {
          continue;
        }
        var fams = parseGoogleFontsHref(href);
        for (var j = 0; j < fams.length; j++) {
          add(fams[j]);
        }
      }
    } catch (e) {
      // DOM query must never break detection.
    }
    // 2. @font-face rules pointing at Google's CDN (covers the css2
    //    loader, which injects a <style> of @font-face blocks with
    //    fonts.gstatic.com src URLs).
    try {
      var sheets = document.styleSheets;
      for (var s = 0; s < sheets.length; s++) {
        var rules = null;
        try {
          rules = sheets[s].cssRules;
        } catch (e) {
          continue; // Cross-origin sheet — unreadable, skip.
        }
        if (!rules) {
          continue;
        }
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          try {
            // @import pointing at Google Fonts (kept for completeness).
            if (rule && typeof rule.href === 'string' && isGoogleFontsUrl(rule.href)) {
              var imported = parseGoogleFontsHref(rule.href);
              for (var k = 0; k < imported.length; k++) {
                add(imported[k]);
              }
              continue;
            }
            var cssText = (rule && rule.cssText) || '';
            var isFace =
              (rule && rule.type === 5) ||
              (cssText && cssText.toLowerCase().indexOf('@font-face') === 0);
            if (!isFace) {
              continue;
            }
            if (!isGoogleFontsUrl(cssText)) {
              continue;
            }
            var fam = '';
            try {
              if (rule.style && typeof rule.style.getPropertyValue === 'function') {
                fam = rule.style.getPropertyValue('font-family') || '';
              }
            } catch (e2) {
              fam = '';
            }
            if (!fam) {
              var mm = cssText.match(/font-family\s*:\s*([^;]+)/i);
              if (mm) {
                fam = mm[1];
              }
            }
            if (fam) {
              // Respect quoted commas: "Some, Font" stays one entry.
              add(splitFontStack(fam)[0] || fam);
            }
          } catch (e3) {
            // One bad rule must not abort the scan.
          }
        }
      }
    } catch (e) {
      // Stylesheet scan must never break detection.
    }
    return found;
  }

  function isVerifiedGoogleFont(family, googleSet) {
    var norm = normalizeForCompare(family);
    if (!norm || GENERIC_FAMILIES[norm]) {
      return false;
    }
    if (!googleSet) {
      return false;
    }
    return Boolean(googleSet[norm]);
  }

  // Resolve which family the Google Fonts row should link. Prefers the
  // verified detected family, then the verified primary family, then any
  // verified fallback-stack entry. Unverified names fall back to search.
  // Returns null when no displayable family exists.
  function getGoogleFontsInfo(primaryFamily, detectedFamily, declaredStack) {
    var googleSet = {};
    try {
      googleSet = collectGoogleFontsFamilies();
    } catch (e) {
      googleSet = {};
    }
    var candidates = [];
    function pushCandidate(name) {
      var clean = stripVariableSuffix(cleanFamilyName(name));
      if (!clean || candidates.indexOf(clean) !== -1) {
        return;
      }
      if (GENERIC_FAMILIES[clean.toLowerCase()]) {
        return;
      }
      candidates.push(clean);
    }
    pushCandidate(detectedFamily);
    pushCandidate(primaryFamily);
    if (Array.isArray(declaredStack)) {
      for (var i = 0; i < declaredStack.length; i++) {
        pushCandidate(declaredStack[i]);
      }
    }
    var verified = '';
    for (var c = 0; c < candidates.length; c++) {
      if (isVerifiedGoogleFont(candidates[c], googleSet)) {
        verified = candidates[c];
        break;
      }
    }
    var display =
      stripVariableSuffix(cleanFamilyName(detectedFamily)) ||
      stripVariableSuffix(cleanFamilyName(primaryFamily)) ||
      (candidates[0] || '');
    if (!display) {
      return null;
    }
    if (verified) {
      return {
        family: verified,
        isVerified: true,
        label: 'View Font',
        url: buildGoogleFontsSpecimenUrl(verified)
      };
    }
    return {
      family: display,
      isVerified: false,
      label: 'Search Font',
      url: buildGoogleFontsSearchUrl(display)
    };
  }

  // Open a Google Fonts URL in a new tab via the background worker
  // (chrome.tabs.create). Falls back to window.open when messaging fails.
  function openGoogleFontsUrl(url) {
    if (!url) {
      return;
    }
    try {
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'OPEN_GOOGLE_FONTS', url: url },
          function () {
            // Background has no response payload; a lastError here means
            // no listener (e.g. tests) — fall back to window.open.
            try {
              if (chrome.runtime.lastError) {
                window.open(url, '_blank', 'noopener');
              }
            } catch (e) {
              // Fallback already attempted; ignore.
            }
          }
        );
        return;
      }
    } catch (e) {
      // Fall through to window.open.
    }
    try {
      window.open(url, '_blank', 'noopener');
    } catch (e2) {
      // Popup blockers must never break the card.
    }
  }

  function documentFontsApi() {
    try {
      if (
        typeof document !== 'undefined' &&
        document.fonts &&
        typeof document.fonts.check === 'function' &&
        typeof document.fonts.forEach === 'function'
      ) {
        return document.fonts;
      }
    } catch (e) {
      // Cross-origin / restricted contexts: treat API as unavailable.
    }
    return null;
  }

  // Find an @font-face loaded on this page matching the family
  // (case-insensitive, quotes ignored). Returns the best match or null.
  // A null result does NOT mean unavailable — system fonts are never
  // listed in document.fonts.
  function findLoadedFace(fonts, family) {
    var lower = family.toLowerCase();
    var candidate = null;
    try {
      fonts.forEach(function (face) {
        if (!face || typeof face.family !== 'string') {
          return;
        }
        if (stripFamilyQuotes(face.family).toLowerCase() !== lower) {
          return;
        }
        if (face.status === 'loaded') {
          candidate = face;
        } else if (!candidate) {
          candidate = face;
        }
      });
    } catch (e) {
      return null;
    }
    return candidate;
  }

  // document.fonts.check() answers "available without loading?" — true for
  // installed system fonts and loaded webfonts, false when a load would be
  // needed (missing face, still-loading face). It never starts a download.
  function isFaceAvailableWithoutLoad(fonts, family) {
    try {
      return fonts.check('16px "' + family.replace(/"/g, '') + '"');
    } catch (e) {
      return false;
    }
  }

  // Compare the declared stack against the Font Loading API and resolve
  // which family actually serves the text. Accuracy-first rules:
  //  - The FIRST declared non-generic family is what the page asks for. The
  //    status is Loaded only when that exact family is verifiably
  //    available. Anything else rendering in its place is a Fallback —
  //    even when the fallback face itself is installed and healthy.
  //  - @font-face entries count only when status === 'loaded'. A face that
  //    is loading/error/unloaded is NOT rendering right now, so we move on.
  //  - Entries absent from document.fonts (system fonts) count only when
  //    check() confirms availability.
  //  - Reaching a generic family (or resolving nothing) means a fallback
  //    is rendering: the exact face cannot be named, so status is Fallback.
  // Returns { declared, detected, status, reason } where status is one of
  // 'loaded' | 'fallback' | 'unknown' (API unavailable — never guessed).
  function resolveFontStatus(fontFamilyStack) {
    var declared = splitFontStack(String(fontFamilyStack || ''))
      .map(stripFamilyQuotes)
      .filter(Boolean);
    var fonts = documentFontsApi();
    if (!fonts || declared.length === 0) {
      return {
        declared: declared,
        detected: declared[0] || '',
        status: 'unknown',
        reason: !fonts ? 'no-api' : 'empty-stack'
      };
    }
    var skippedDeclared = false;
    for (var i = 0; i < declared.length; i++) {
      var name = declared[i];
      if (GENERIC_FAMILIES[name.toLowerCase()]) {
        return {
          declared: declared,
          detected: name,
          status: 'fallback',
          reason: 'generic'
        };
      }
      var available = false;
      var source = '';
      var face = findLoadedFace(fonts, name);
      if (face) {
        if (face.status === 'loaded') {
          available = true;
          source = 'webfont';
        }
      } else if (isFaceAvailableWithoutLoad(fonts, name)) {
        available = true;
        source = 'system';
      }
      if (available) {
        if (skippedDeclared) {
          // A later-stack fallback is rendering, not the declared font.
          return {
            declared: declared,
            detected: name,
            status: 'fallback',
            reason: 'fallback'
          };
        }
        return {
          declared: declared,
          detected: name,
          status: 'loaded',
          reason: source
        };
      }
      // Unavailable — fall through to the next family in the stack.
      skippedDeclared = true;
    }
    return {
      declared: declared,
      detected: declared[0] || '',
      status: 'fallback',
      reason: 'unavailable'
    };
  }

  // Core detection: always uses getComputedStyle so inherited fonts
  // (e.g. body { font-family } with bare <span> children) resolve correctly.
  // Never reads class names or inline styles. The returned `fontFamily` /
  // `primaryFamily` describe what the page *declares*; `detectedFamily` /
  // `fontStatus` describe what the Font Loading API could *verify*.
  function detectTypography(element) {
    var cs = window.getComputedStyle(element);
    var fontFamily = cs.getPropertyValue('font-family') || cs.fontFamily;
    var resolved = resolveFontStatus(fontFamily);
    var primary = getPrimaryFontFamily(fontFamily);
    var google = null;
    try {
      google = getGoogleFontsInfo(primary, resolved.detected, resolved.declared);
    } catch (e) {
      google = null;
    }
    return {
      fontFamily: fontFamily,
      primaryFamily: primary,
      declaredStack: resolved.declared,
      detectedFamily: resolved.detected,
      fontStatus: resolved.status,
      fontStatusReason: resolved.reason,
      googleFamily: google ? google.family : '',
      isGoogleFont: google ? google.isVerified : false,
      googleFontsUrl: google ? google.url : '',
      googleFontsLabel: google ? google.label : 'Search Font',
      fontSize: cs.getPropertyValue('font-size') || cs.fontSize,
      fontWeight: cs.getPropertyValue('font-weight') || cs.fontWeight,
      fontStyle: cs.getPropertyValue('font-style') || cs.fontStyle,
      lineHeight: cs.getPropertyValue('line-height') || cs.lineHeight,
      letterSpacing: cs.getPropertyValue('letter-spacing') || cs.letterSpacing,
      textTransform: cs.getPropertyValue('text-transform') || cs.textTransform,
      color: cs.getPropertyValue('color') || cs.color,
      // Context for future features (recent list, CSS copy).
      tag: element.tagName ? element.tagName.toLowerCase() : ''
    };
  }

  function persistResult(info) {
    lastResult = info;
    try {
      // Hostname only (never full URLs or page contents) — lightweight and
      // privacy-friendly. Guarded: some contexts (about:blank) have none.
      var hostname = '';
      try {
        hostname = window.location ? window.location.hostname || '' : '';
      } catch (e) {
        hostname = '';
      }
      // Pass to extension UI (popup reads `recentFonts`).
      // `family` kept for backward compatibility with popup v0.1.
      var entry = {
        family: info.primaryFamily,
        primaryFamily: info.primaryFamily,
        fontFamily: info.fontFamily,
        declaredStack: info.declaredStack || [],
        detectedFamily: info.detectedFamily || info.primaryFamily,
        fontStatus: info.fontStatus || 'unknown',
        fontStatusReason: info.fontStatusReason || '',
        googleFamily: info.googleFamily || '',
        isGoogleFont: Boolean(info.isGoogleFont),
        googleFontsUrl: info.googleFontsUrl || '',
        googleFontsLabel: info.googleFontsLabel || 'Search Font',
        fontSize: info.fontSize,
        fontWeight: info.fontWeight,
        fontStyle: info.fontStyle,
        lineHeight: info.lineHeight,
        letterSpacing: info.letterSpacing,
        textTransform: info.textTransform,
        color: info.color,
        tag: info.tag,
        hostname: hostname,
        inspectedAt: Date.now()
      };
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['recentFonts'], function (result) {
          var list = Array.isArray(result.recentFonts) ? result.recentFonts : [];
          // Dedupe: same font + website combination refreshes to the top
          // instead of creating a duplicate entry.
          var key = historyKey(entry);
          list = list.filter(function (item) {
            return historyKey(item) !== key;
          });
          list.unshift(entry);
          chrome.storage.local.set({ recentFonts: list.slice(0, 20) });
        });
      }
    } catch (e) {
      // Storage must never break detection.
    }
  }

  // Identity of a history item: exact same font + website combination.
  function historyKey(item) {
    function norm(value) {
      return String(value || '').toLowerCase().trim();
    }
    return [
      norm(item && (item.primaryFamily || item.family)),
      norm(item && item.fontWeight),
      norm(item && item.fontSize),
      norm(item && item.hostname)
    ].join('|');
  }

  // ---------- UI-only formatting helpers (detection untouched) ----------

  function normalizeWeightNumber(weight) {
    var w = String(weight || '').toLowerCase().trim();
    if (w === 'normal') {
      return 400;
    }
    if (w === 'bold') {
      return 700;
    }
    var n = parseInt(w, 10);
    return isNaN(n) ? 400 : n;
  }

  function formatWeight(weight) {
    var num = normalizeWeightNumber(weight);
    var name = WEIGHT_NAMES[num] || '';
    return name ? num + ' / ' + name : String(weight);
  }

  function capitalize(word) {
    if (!word) {
      return word;
    }
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  // Computed colors arrive as rgb()/rgba(). Convert to #rrggbb for the card.
  function colorToHex(color) {
    var m = String(color || '').match(
      /rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/
    );
    if (!m) {
      return String(color || '').trim();
    }
    function hex(n) {
      var h = Math.max(0, Math.min(255, parseInt(n, 10))).toString(16);
      return h.length === 1 ? '0' + h : h;
    }
    return ('#' + hex(m[1]) + hex(m[2]) + hex(m[3])).toLowerCase();
  }

  // Display-only color normalization (UI fix, detection untouched).
  // Never show raw lab()/oklab()/lch()/oklch()/hsl()/rgb() functions to the
  // user — always display [swatch] #rrggbb. Detection, persistence and
  // Copy CSS keep the original string; only the card value uses this.
  function componentToHex(v) {
    var n = Math.round(Math.max(0, Math.min(255, v)));
    var h = n.toString(16);
    return h.length === 1 ? '0' + h : h;
  }

  function rgbToHex(r, g, b) {
    return ('#' + componentToHex(r) + componentToHex(g) + componentToHex(b)).toLowerCase();
  }

  function srgbGamma(c) {
    c = Math.max(0, Math.min(1, c));
    if (c <= 0.0031308) {
      return 12.92 * c;
    }
    return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function xyzToRgbHex(x, y, z) {
    var r = srgbGamma(3.2406 * x - 1.5372 * y - 0.4986 * z);
    var g = srgbGamma(-0.9689 * x + 1.8758 * y + 0.0415 * z);
    var b = srgbGamma(0.0557 * x - 0.2040 * y + 1.0570 * z);
    return rgbToHex(r * 255, g * 255, b * 255);
  }

  function labToRgbHex(L, a, b) {
    var fy = (L + 16) / 116;
    var fx = fy + a / 500;
    var fz = fy - b / 200;
    function finv(f) {
      var f3 = f * f * f;
      if (f3 > 0.008856) {
        return f3;
      }
      return (f - 16 / 116) / 7.787;
    }
    var x = finv(fx) * 0.95047;
    var y = finv(fy) * 1.0;
    var z = finv(fz) * 1.08883;
    return xyzToRgbHex(x, y, z);
  }

  function oklabToRgbHex(L, a, b) {
    var l = L + 0.3963377774 * a + 0.2158037573 * b;
    var m = L - 0.1055613458 * a - 0.0638541728 * b;
    var s = L - 0.0894841775 * a - 1.2914855480 * b;
    l = l * l * l;
    m = m * m * m;
    s = s * s * s;
    var r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return rgbToHex(srgbGamma(r) * 255, srgbGamma(g) * 255, srgbGamma(bl) * 255);
  }

  function parseRgbComponent(part) {
    part = String(part || '').trim();
    if (!part) {
      return null;
    }
    if (part.charAt(part.length - 1) === '%') {
      var p = parseFloat(part.slice(0, -1));
      if (isNaN(p)) {
        return null;
      }
      return Math.max(0, Math.min(100, p)) / 100 * 255;
    }
    var n = parseFloat(part);
    if (isNaN(n)) {
      return null;
    }
    return Math.max(0, Math.min(255, n));
  }

  function manualRgbToHex(input) {
    var m = String(input || '').match(/^rgba?\s*\((.+)\)\s*$/i);
    if (!m) {
      return null;
    }
    var body = m[1].replace(/\//g, ' ').replace(/,/g, ' ');
    var parts = body.split(/\s+/).filter(function (p) { return p.length > 0; });
    if (parts.length < 3) {
      return null;
    }
    var r = parseRgbComponent(parts[0]);
    var g = parseRgbComponent(parts[1]);
    var b = parseRgbComponent(parts[2]);
    if (r === null || g === null || b === null) {
      return null;
    }
    return rgbToHex(r, g, b);
  }

  function hslToRgbNum(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    function hue2rgb(p, q, t) {
      if (t < 0) { t += 1; }
      if (t > 1) { t -= 1; }
      if (t < 1 / 6) { return p + (q - p) * 6 * t; }
      if (t < 1 / 2) { return q; }
      if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
      return p;
    }
    var r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [r * 255, g * 255, b * 255];
  }

  function manualHslToHex(input) {
    var m = String(input || '').match(/^hsla?\s*\((.+)\)\s*$/i);
    if (!m) {
      return null;
    }
    var body = m[1].replace(/\//g, ' ').replace(/,/g, ' ');
    var parts = body.split(/\s+/).filter(function (p) { return p.length > 0; });
    if (parts.length < 3) {
      return null;
    }
    var h = parseFloat(parts[0]);
    var s = parseFloat(parts[1]);
    var l = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(s) || isNaN(l)) {
      return null;
    }
    // s/l may carry % (standard) or be bare 0-1.
    if (String(parts[1]).indexOf('%') !== -1) { s = s / 100; }
    else if (s > 1) { s = s / 100; }
    if (String(parts[2]).indexOf('%') !== -1) { l = l / 100; }
    else if (l > 1) { l = l / 100; }
    var rgb = hslToRgbNum(h, s, l);
    return rgbToHex(rgb[0], rgb[1], rgb[2]);
  }

  function manualLabToHex(input) {
    var m = String(input || '').match(/^lab\s*\((.+)\)\s*$/i);
    if (!m) {
      return null;
    }
    var body = m[1].replace(/\//g, ' ').replace(/,/g, ' ');
    var parts = body.split(/\s+/).filter(function (p) { return p.length > 0; });
    if (parts.length < 3) {
      return null;
    }
    var L = parseFloat(parts[0]);
    var a = parseFloat(parts[1]);
    var b = parseFloat(parts[2]);
    if (isNaN(L) || isNaN(a) || isNaN(b)) {
      return null;
    }
    if (String(parts[0]).indexOf('%') !== -1) { L = L; }
    L = Math.max(0, Math.min(100, L));
    return labToRgbHex(L, a, b);
  }

  function manualOklabToHex(input) {
    var m = String(input || '').match(/^oklab\s*\((.+)\)\s*$/i);
    if (!m) {
      return null;
    }
    var body = m[1].replace(/\//g, ' ').replace(/,/g, ' ');
    var parts = body.split(/\s+/).filter(function (p) { return p.length > 0; });
    if (parts.length < 3) {
      return null;
    }
    var L = parseFloat(parts[0]);
    var a = parseFloat(parts[1]);
    var b = parseFloat(parts[2]);
    if (isNaN(L) || isNaN(a) || isNaN(b)) {
      return null;
    }
    if (String(parts[0]).indexOf('%') !== -1) { L = L / 100; }
    L = Math.max(0, Math.min(1, L));
    return oklabToRgbHex(L, a, b);
  }

  var __ffColorCanvas = null;

  function canvasColorToHex(input) {
    try {
      if (typeof document === 'undefined') {
        return null;
      }
      if (!__ffColorCanvas) {
        __ffColorCanvas = document.createElement('canvas');
        __ffColorCanvas.width = 1;
        __ffColorCanvas.height = 1;
      }
      var ctx = null;
      try {
        ctx = __ffColorCanvas.getContext('2d', { willReadFrequently: true });
      } catch (e0) {
        try {
          ctx = __ffColorCanvas.getContext('2d');
        } catch (e1) {
          return null;
        }
      }
      if (!ctx) {
        return null;
      }
      var SENTINEL = '#123456';
      var trimmed = String(input).trim().toLowerCase();
      try {
        ctx.fillStyle = SENTINEL;
      } catch (e) {
        return null;
      }
      try {
        ctx.fillStyle = input;
      } catch (e) {
        return null;
      }
      var serialized = '';
      try {
        serialized = String(ctx.fillStyle || '').toLowerCase().trim();
      } catch (e) {
        return null;
      }
      if (!serialized || (serialized === SENTINEL && trimmed !== SENTINEL)) {
        return null;
      }
      var hm = serialized.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
      if (hm) {
        return '#' + hm[1];
      }
      var hm3 = serialized.match(/^#([0-9a-f]{3,4})$/);
      if (hm3) {
        var h = hm3[1];
        return ('#' + h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2));
      }
      // Paint a pixel and read it back: handles lab()/oklab()/lch()/
      // oklch()/color()/hsl()/named colors in browsers that render them.
      try {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = input;
        ctx.fillRect(0, 0, 1, 1);
        var d = ctx.getImageData(0, 0, 1, 1).data;
        if (!d || d.length < 3) {
          return null;
        }
        return rgbToHex(d[0], d[1], d[2]);
      } catch (e) {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  function normalizeColorToHex(color) {
    var input = String(color || '').trim();
    if (!input) {
      return '';
    }
    var hexMatch = input.match(/^#([0-9a-fA-F]{3,8})$/);
    if (hexMatch) {
      var h = hexMatch[1];
      if (h.length === 3 || h.length === 4) {
        return ('#' + h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2)).toLowerCase();
      }
      return ('#' + h.slice(0, 6)).toLowerCase();
    }
    var viaCanvas = canvasColorToHex(input);
    if (viaCanvas) {
      return viaCanvas;
    }
    var viaRgb = manualRgbToHex(input);
    if (viaRgb) {
      return viaRgb;
    }
    var viaHsl = manualHslToHex(input);
    if (viaHsl) {
      return viaHsl;
    }
    var viaLab = manualLabToHex(input);
    if (viaLab) {
      return viaLab;
    }
    var viaOklab = manualOklabToHex(input);
    if (viaOklab) {
      return viaOklab;
    }
    var legacy = colorToHex(input);
    if (legacy && legacy.charAt(0) === '#') {
      return legacy;
    }
    return input;
  }

  // Generates clean, readable CSS from the detected computed styles only.
  // Exactly the 8 typography properties — nothing unrelated. The color is
  // kept in its computed rgb()/rgba() form so the snippet round-trips.
  function buildCssText(info) {
    return (
      'font-family: ' + info.fontFamily + ';\n' +
      'font-size: ' + info.fontSize + ';\n' +
      'font-weight: ' + info.fontWeight + ';\n' +
      'font-style: ' + info.fontStyle + ';\n' +
      'line-height: ' + info.lineHeight + ';\n' +
      'letter-spacing: ' + info.letterSpacing + ';\n' +
      'text-transform: ' + info.textTransform + ';\n' +
      'color: ' + String(info.color || '').trim() + ';'
    );
  }

  var toastTimer = null;

  // Small success/error notification. Auto-dismisses; pointer-events: none
  // so it never interferes with the page. Styled in content.css.
  function showToast(message, isError) {
    hideToast();
    var toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.className = 'ff-toast' + (isError ? ' ff-toast-error' : '');
    toast.setAttribute('role', 'status');
    // textContent (never innerHTML) — messages are internal constants.
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    toastTimer = window.setTimeout(function () {
      toastTimer = null;
      var el = document.getElementById(TOAST_ID);
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }, 1800);
  }

  function hideToast() {
    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    var el = document.getElementById(TOAST_ID);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  // Copies text via the async Clipboard API with an execCommand fallback.
  // toastMessage (optional): shown as a "CSS copied!"-style notification on
  // success; failures always surface an error toast so they are visible.
  function copyText(text, button, idleLabel, toastMessage) {
    function done(ok) {
      if (button) {
        button.textContent = ok ? 'Copied!' : 'Copy failed';
        window.setTimeout(function () {
          button.textContent = idleLabel;
        }, 1200);
      }
      if (ok) {
        if (toastMessage) {
          showToast(toastMessage, false);
        }
      } else {
        showToast('Copy failed — clipboard blocked', true);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          fallbackCopy(text, done);
        }
      );
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.documentElement.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.parentNode.removeChild(ta);
      done(!!ok);
    } catch (e) {
      done(false);
    }
  }

  // ---------- Hover tooltip: instant font name, no click required ----------
  //
  // Performance design (must stay smooth during fast mouse movement):
  //  - One shared tooltip node is created lazily and reused; it is never
  //    recreated per mousemove.
  //  - getComputedStyle() runs at most once per hovered element (guarded by
  //    hoverElement identity), never per mousemove pixel.
  //  - Cursor tracking only records coordinates and schedules a single
  //    requestAnimationFrame; the transform write happens once per frame.
  //  - Tooltip text is rewritten only when the font signature
  //    (family|weight|size) changes, so nested same-font elements never
  //    flicker.
  //  - The tip has pointer-events: none (see content.css), so it can never
  //    become a mouseover/mouseout target itself.

  function ensureHoverTip() {
    if (hoverTip && hoverTip.parentNode) {
      return hoverTip;
    }
    var tip = document.createElement('div');
    tip.id = HOVER_TIP_ID;
    tip.setAttribute('role', 'status');
    tip.setAttribute('aria-hidden', 'true');
    var name = document.createElement('span');
    name.className = 'ff-hover-name';
    var meta = document.createElement('span');
    meta.className = 'ff-hover-meta';
    tip.appendChild(name);
    tip.appendChild(meta);
    tip.style.display = 'none';
    document.documentElement.appendChild(tip);
    hoverTip = tip;
    hoverTipName = name;
    hoverTipMeta = meta;
    hoverTipW = 0;
    hoverTipH = 0;
    return tip;
  }

  function hideHoverTip() {
    hoverSignature = null;
    hoverElement = null;
    if (hoverTip) {
      hoverTip.style.display = 'none';
      if (hoverTip.classList) {
        hoverTip.classList.remove('ff-hover-show');
      }
    }
  }

  function removeHoverTip() {
    hideHoverTip();
    if (hoverTip && hoverTip.parentNode) {
      hoverTip.parentNode.removeChild(hoverTip);
    }
    hoverTip = null;
    hoverTipName = null;
    hoverTipMeta = null;
    hoverTipW = 0;
    hoverTipH = 0;
  }

  // Media/replaced elements never carry meaningful text of their own. When
  // the cursor is directly over one, no tooltip is shown at all — we must
  // NOT walk up to a text ancestor (that walk-up is what used to produce
  // tooltips while hovering over images/logos). SVG is special-cased: an
  // <svg> containing <text> nodes is genuine text and may resolve normally.
  var MEDIA_TAGS = {
    IMG: true,
    VIDEO: true,
    AUDIO: true,
    CANVAS: true,
    OBJECT: true,
    EMBED: true,
    IFRAME: true
  };

  // Tag names are uppercased by the HTML parser but keep their case inside
  // inline SVG / XML documents, so compare case-insensitively.
  function elementTag(el) {
    try {
      return String(el.tagName || '').toUpperCase();
    } catch (e) {
      return '';
    }
  }

  function isMediaElement(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var tag = elementTag(el);
    if (MEDIA_TAGS[tag]) {
      return true;
    }
    if (tag === 'SVG') {
      try {
        var text = el.textContent;
        return !(text && text.trim().length > 0);
      } catch (e) {
        return true;
      }
    }
    return false;
  }

  // Resolve the element whose font should be shown for a hovered node.
  // Prefers the deepest text element (most specific computed style, which
  // already includes inheritance). A child without meaningful text of its
  // own (e.g. an icon inside a button) falls back to the nearest ancestor
  // with text, whose computed style is what actually applies to that text.
  // Returns null for images, text-less SVG, empty containers, our own UI,
  // and the page root itself.
  function resolveHoverTarget(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    // Cursor directly over media -> suppress entirely. This check runs
    // before the ancestor walk so an image nested inside a text container
    // never reports the container's font.
    if (el && el instanceof Element && isMediaElement(el)) {
      return null;
    }
    var depth = 0;
    while (el && el instanceof Element && depth <= HOVER_WALK_DEPTH) {
      if (isOwnUI(el)) {
        return null;
      }
      var tag = el.tagName;
      if (tag === 'BODY' || tag === 'HTML') {
        return null;
      }
      if (IGNORED_TAGS[tag]) {
        el = el.parentElement;
        depth++;
        continue;
      }
      if (isTextElement(el)) {
        return el;
      }
      try {
        var text = el.textContent;
        if (text && text.trim().length > 0) {
          return el;
        }
      } catch (e) {
        return null;
      }
      el = el.parentElement;
      depth++;
    }
    return null;
  }

  // Recompute the tooltip for a hovered node. Cheap no-ops when nothing
  // meaningful changed (same element, or same font signature).
  function updateHoverTip(node) {
    if (!isActive) {
      hideHoverTip();
      return;
    }
    var resolved = resolveHoverTarget(node);
    if (!resolved) {
      hideHoverTip();
      return;
    }
    if (resolved === hoverElement && hoverSignature) {
      scheduleHoverFrame();
      return;
    }
    var cs;
    try {
      cs = window.getComputedStyle(resolved);
    } catch (e) {
      hideHoverTip();
      return;
    }
    var stack = cs.getPropertyValue
      ? cs.getPropertyValue('font-family') || cs.fontFamily
      : cs.fontFamily;
    // Primary family only (e.g. "Inter", Arial, sans-serif -> Inter).
    var primary = getPrimaryFontFamily(stack);
    if (!primary) {
      hideHoverTip();
      return;
    }
    var weight = cs.getPropertyValue
      ? cs.getPropertyValue('font-weight') || cs.fontWeight
      : cs.fontWeight;
    var size = cs.getPropertyValue
      ? cs.getPropertyValue('font-size') || cs.fontSize
      : cs.fontSize;
    weight = String(weight || '').trim();
    size = String(size || '').trim();
    var signature = primary + '|' + weight + '|' + size;
    hoverElement = resolved;
    if (signature === hoverSignature) {
      scheduleHoverFrame();
      return;
    }
    hoverSignature = signature;
    ensureHoverTip();
    var wasHidden = hoverTip.style.display === 'none';
    // textContent (never innerHTML) — detected values are untrusted strings.
    hoverTipName.textContent = primary;
    hoverTipMeta.textContent =
      weight && size ? weight + ' · ' + size : weight || size || '';
    hoverTip.style.display = 'block';
    try {
      hoverTipW = hoverTip.offsetWidth || 0;
      hoverTipH = hoverTip.offsetHeight || 0;
    } catch (e) {
      hoverTipW = 0;
      hoverTipH = 0;
    }
    if (wasHidden && hoverTip.classList) {
      // Subtle entrance only on show, never on text updates (no flicker).
      hoverTip.classList.remove('ff-hover-show');
      try {
        void hoverTip.offsetWidth;
      } catch (e) {
        // Measuring for the animation restart is best-effort only.
      }
      hoverTip.classList.add('ff-hover-show');
    }
    scheduleHoverFrame();
  }

  function scheduleHoverFrame() {
    if (hoverFramePending) {
      return;
    }
    hoverFramePending = true;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(hoverFrame);
    } else {
      window.setTimeout(hoverFrame, 16);
    }
  }

  // Single per-frame pass: reposition the visible tip, or re-acquire a
  // target when hidden (e.g. after scrolling under a stationary cursor).
  function hoverFrame() {
    hoverFramePending = false;
    if (!isActive) {
      return;
    }
    if (hoverTip && hoverSignature && hoverTip.style.display !== 'none') {
      positionHoverTip();
      return;
    }
    var node = null;
    try {
      if (typeof document.elementFromPoint === 'function') {
        node = document.elementFromPoint(mouseX, mouseY);
      }
    } catch (e) {
      node = null;
    }
    if (node) {
      updateHoverTip(node);
    }
  }

  // Cursor-following position with a small offset, clamped to the viewport
  // so the tip flips inside near the right/bottom edges. transform-only
  // writes keep this on the compositor (no layout cost per frame).
  function positionHoverTip() {
    if (!hoverTip) {
      return;
    }
    var x = mouseX + HOVER_OFFSET_X;
    var y = mouseY + HOVER_OFFSET_Y;
    if (hoverTipW > 0) {
      var maxX = window.innerWidth - hoverTipW - 8;
      if (x > maxX) {
        x = Math.max(8, mouseX - hoverTipW - 12);
      }
    }
    if (hoverTipH > 0) {
      var maxY = window.innerHeight - hoverTipH - 8;
      if (y > maxY) {
        y = Math.max(8, mouseY - hoverTipH - 12);
      }
    }
    hoverTip.style.transform =
      'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  function trackMouse(event) {
    if (typeof event.clientX === 'number') {
      mouseX = event.clientX;
      mouseY = event.clientY;
    }
  }

  function onMouseMove(event) {
    if (!isActive) {
      return;
    }
    // No style reads here — just coordinates + one rAF.
    trackMouse(event);
    scheduleHoverFrame();
  }

  function onScrollCapture() {
    if (!isActive) {
      return;
    }
    // The text under a stationary cursor changes on scroll; hide until the
    // next mousemove/frame re-acquires the correct target.
    hideHoverTip();
  }

  // ---------- Floating result card (styled by content.css) ----------

  function hidePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
  }

  // Display metadata for a resolved font status. Labels stay strictly
  // within what the Font Loading API can prove: a "Loaded" face was found
  // in document.fonts or verified via check(); anything else is a fallback
  // whose exact rendered face we do not name beyond the resolved family.
  function fontStatusDisplay(info) {
    if (info.fontStatus === 'loaded') {
      return {
        label: '✓ Loaded',
        valueClass: 'ff-value-loaded',
        dot: '#15803D',
        sub: 'Declared font verified on this page'
      };
    }
    if (info.fontStatus === 'fallback') {
      return {
        label: '⚠ Fallback',
        valueClass: 'ff-value-fallback',
        dot: '#F59E0B',
        sub:
          info.fontStatusReason === 'generic'
            ? 'System default — exact face unknown'
            : 'Declared font not loaded — fallback in use'
      };
    }
    return {
      label: 'Not checked',
      valueClass: 'ff-value-muted',
      dot: '#64748B',
      sub: 'Font Loading API unavailable'
    };
  }

  function addRow(body, label, valueText, options) {
    options = options || {};
    var row = document.createElement('div');
    row.className = 'ff-row';
    var labelEl = document.createElement('span');
    labelEl.className = 'ff-label';
    labelEl.textContent = label;
    var valueEl = document.createElement('span');
    valueEl.className =
      'ff-value' +
      (options.strong ? ' ff-value-strong' : '') +
      (options.valueClass ? ' ' + options.valueClass : '');
    if (options.dot || options.swatch) {
      var wrap = document.createElement('span');
      wrap.className = 'ff-color';
      var marker = document.createElement('span');
      marker.className = options.dot ? 'ff-dot' : 'ff-swatch';
      marker.style.backgroundColor = options.dot || options.swatch;
      wrap.appendChild(marker);
      // textContent (never innerHTML) — detected values are untrusted strings.
      wrap.appendChild(document.createTextNode(valueText));
      valueEl.appendChild(wrap);
    } else {
      // textContent (never innerHTML) — detected values are untrusted strings.
      valueEl.appendChild(document.createTextNode(valueText));
    }
    // sub accepts a single line or an array of lines (e.g. Declared + Detected).
    var subs = Array.isArray(options.sub)
      ? options.sub
      : options.sub
        ? [options.sub]
        : [];
    for (var i = 0; i < subs.length; i++) {
      var sub = document.createElement('span');
      sub.className = 'ff-stack';
      sub.textContent = subs[i];
      valueEl.appendChild(sub);
    }
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    body.appendChild(row);
    return row;
  }

  // Compact Google Fonts row: label + a single small button.
  // Verified families show "View Font" (specimen page); everything else
  // shows "Search Font" (Google Fonts search). Opens via background
  // chrome.tabs.create(), never downloads the font.
  function addGoogleFontsRow(body, info) {
    var gf = null;
    try {
      if (info && info.googleFontsUrl) {
        gf = {
          family: info.googleFamily || info.detectedFamily || info.primaryFamily || '',
          isVerified: Boolean(info.isGoogleFont),
          label: info.googleFontsLabel || (info.isGoogleFont ? 'View Font' : 'Search Font'),
          url: info.googleFontsUrl
        };
      } else {
        gf = getGoogleFontsInfo(
          (info && (info.primaryFamily || info.detectedFamily)) || '',
          (info && (info.detectedFamily || info.primaryFamily)) || '',
          (info && info.declaredStack) || []
        );
      }
    } catch (e) {
      gf = null;
    }
    if (!gf || !gf.url) {
      return;
    }
    var row = document.createElement('div');
    row.className = 'ff-row ff-row-gf';
    var labelEl = document.createElement('span');
    labelEl.className = 'ff-label';
    labelEl.textContent = 'Google Fonts';
    var valueEl = document.createElement('span');
    valueEl.className = 'ff-value ff-value-gf';
    var btn = document.createElement('button');
    btn.className =
      'ff-gf-btn' + (gf.isVerified ? ' ff-gf-verified' : ' ff-gf-search');
    btn.type = 'button';
    btn.textContent = gf.isVerified ? 'View Font' : 'Search Font';
    btn.setAttribute('aria-label', btn.textContent + ' — ' + gf.family + ' on Google Fonts');
    btn.setAttribute('title', gf.url);
    (function (url) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openGoogleFontsUrl(url);
      });
    })(gf.url);
    valueEl.appendChild(btn);
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    body.appendChild(row);
  }

  function showPanel(info) {
    hidePanel();

    var card = document.createElement('div');
    card.id = PANEL_ID;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Font Finder result');

    // Header
    var header = document.createElement('div');
    header.className = 'ff-header';
    var eyebrow = document.createElement('span');
    eyebrow.className = 'ff-eyebrow';
    eyebrow.textContent = 'FONT FINDER';
    var xBtn = document.createElement('button');
    xBtn.className = 'ff-close-x';
    xBtn.type = 'button';
    xBtn.setAttribute('aria-label', 'Close panel');
    xBtn.textContent = '×';
    xBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      hidePanel();
    });
    header.appendChild(eyebrow);
    header.appendChild(xBtn);
    card.appendChild(header);

    // Scrollable content
    var scroll = document.createElement('div');
    scroll.className = 'ff-scroll';

    // Live preview in the detected typeface. fontFamily is the full
    // detected stack, so if the primary face isn't available the browser
    // falls back gracefully down the stack automatically. Preview is an
    // independent fixed-height (90px) component: ONLY Aa + small font name,
    // so preview size/family changes never move the rows below.
    var preview = document.createElement('div');
    preview.className = 'ff-preview';
    var aa = document.createElement('span');
    aa.className = 'ff-preview-aa';
    aa.style.fontFamily = info.fontFamily;
    aa.style.fontWeight = info.fontWeight;
    aa.style.fontStyle = info.fontStyle;
    aa.style.letterSpacing = info.letterSpacing;
    aa.textContent = 'Aa';
    var tag = document.createElement('span');
    tag.className = 'ff-preview-tag';
    tag.textContent = 'PREVIEW · ' + (info.primaryFamily || 'detected font');
    preview.appendChild(aa);
    preview.appendChild(tag);
    scroll.appendChild(preview);

    // Spec rows. The Font Family value is the *detected* (verified) family;
    // the subs keep the full declared stack visible so Declared vs Detected
    // is explicit. Single-family stacks get an honest "Declared font" label
    // since pixel-level rendering cannot be proven by the available APIs.
    var rows = document.createElement('div');
    rows.className = 'ff-rows';
    var detectedName =
      info.detectedFamily || info.primaryFamily || info.fontFamily;
    var declaredCount = (info.declaredStack || []).length;
    if (declaredCount > 1) {
      addRow(rows, 'Font Family', detectedName, {
        strong: true,
        sub: ['Declared: ' + info.fontFamily, 'Detected: ' + detectedName]
      });
    } else {
      addRow(rows, 'Font Family', detectedName, {
        strong: true,
        sub: 'Declared font'
      });
    }
    var status = fontStatusDisplay(info);
    addRow(rows, 'Font Status', status.label, {
      dot: status.dot,
      valueClass: status.valueClass,
      sub: status.sub
    });
    addRow(rows, 'Weight', formatWeight(info.fontWeight));
    addRow(rows, 'Size', info.fontSize);
    addRow(rows, 'Line Height', info.lineHeight);
    addRow(rows, 'Letter Spacing', info.letterSpacing);
    addRow(rows, 'Style', capitalize(String(info.fontStyle || '')));
    addRow(rows, 'Color', normalizeColorToHex(info.color), { swatch: info.color });
    addGoogleFontsRow(rows, info);
    scroll.appendChild(rows);
    card.appendChild(scroll);

    // Footer buttons
    var footer = document.createElement('div');
    footer.className = 'ff-footer';
    var copyFontBtn = document.createElement('button');
    copyFontBtn.className = 'ff-btn ff-btn-copy';
    copyFontBtn.type = 'button';
    copyFontBtn.textContent = 'Copy Font';
    copyFontBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(info.primaryFamily || info.fontFamily || '', copyFontBtn, 'Copy Font');
    });
    var copyCssBtn = document.createElement('button');
    copyCssBtn.className = 'ff-btn ff-btn-css';
    copyCssBtn.type = 'button';
    copyCssBtn.textContent = 'Copy CSS';
    copyCssBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(buildCssText(info), copyCssBtn, 'Copy CSS', 'CSS copied!');
    });
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ff-btn ff-btn-close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      hidePanel();
    });
    footer.appendChild(copyFontBtn);
    footer.appendChild(copyCssBtn);
    footer.appendChild(closeBtn);
    card.appendChild(footer);

    // Fixed-positioned by content.css: never affects page layout.
    document.documentElement.appendChild(card);
  }

  // ---------- Event handlers ----------

  function onMouseOver(event) {
    if (!isActive) {
      return;
    }
    trackMouse(event);
    var target = event.target;
    if (target && target.nodeType === 3) {
      target = target.parentElement;
    }
    // Unchanged highlight: only real Elements containing their own text.
    if (isTextElement(target)) {
      highlight(target);
    } else if (target instanceof Element && !isOwnUI(target)) {
      // Moving over non-text containers clears the previous highlight so
      // the outline always tracks the inspected element.
      clearHighlight();
    }
    // Instant font name — no click required.
    updateHoverTip(target);
  }

  function onMouseOut(event) {
    if (!isActive) {
      return;
    }
    // Clear when the pointer truly leaves the highlighted element
    // (not when moving between its children).
    if (
      highlightedElement &&
      event.relatedTarget &&
      highlightedElement.contains(event.relatedTarget)
    ) {
      return;
    }
    clearHighlight();
    // Hide the tooltip only when leaving text altogether; moving between
    // nested same-font elements keeps it visible (no flicker — the text
    // stays identical because the signature is unchanged).
    var related = event.relatedTarget;
    if (
      !related ||
      !(related instanceof Element) ||
      !resolveHoverTarget(related)
    ) {
      hideHoverTip();
    }
  }

  function onClick(event) {
    // Let our own card buttons work normally.
    if (isOwnUI(event.target)) {
      return;
    }
    // Panel stays open on outside clicks.
    if (!isActive) {
      return;
    }
    var target = event.target;
    if (target && target.nodeType === 3) {
      target = target.parentElement;
    }
    var picked = null;
    if (target instanceof Element) {
      if (isTextElement(target)) {
        picked = target;
      } else if (highlightedElement && (target === highlightedElement || highlightedElement.contains(target))) {
        picked = highlightedElement;
      }
    }
    if (!picked) {
      // Not a text element — stay in selection mode, don't interfere.
      return;
    }
    // Intercept ONLY the picked click so links/buttons don't navigate away.
    event.preventDefault();
    event.stopPropagation();

    var info = detectTypography(picked);

    // Stop hover highlight + temporarily exit selection mode.
    clearHighlight();
    deactivate();
    persistResult(info);
    showPanel(info);
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') {
      return;
    }
    var panel = document.getElementById(PANEL_ID);
    if (panel) {
      event.stopPropagation();
      hidePanel();
    }
    if (isActive) {
      event.stopPropagation();
      deactivate();
    }
  }

  function attachListeners() {
    if (listenersAttached) {
      return;
    }
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    // mousemove only tracks coordinates + schedules one rAF (no style reads).
    document.addEventListener('mousemove', onMouseMove);
    // Capture scroll to drop a stale tooltip; the next frame re-acquires.
    document.addEventListener('scroll', onScrollCapture, true);
    // Capture phase: intercept picked clicks before page handlers, and catch
    // Escape even if the page stops propagation.
    document.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    listenersAttached = true;
  }

  // ---------- Public mode control (extensible) ----------

  function activate() {
    if (isActive) {
      return { alreadyActive: true };
    }
    hidePanel();
    hideHoverTip();
    isActive = true;
    document.documentElement.classList.add(ACTIVE_CLASS);
    showIndicator();
    attachListeners();
    return { alreadyActive: false };
  }

  function deactivate() {
    if (!isActive) {
      return;
    }
    isActive = false;
    clearHighlight();
    hideIndicator();
    removeHoverTip();
    document.documentElement.classList.remove(ACTIVE_CLASS);
    // Listeners stay attached but are gated by isActive, so re-activation
    // is cheap. Card styles come from content.css (static), so there is no
    // injected <style> tag to clean up.
  }

  function isFontFinderActive() {
    return isActive;
  }

  // Expose a small namespace for testing / future blocks (CSS copy, recents).
  window.__ILFFontFinder = {
    activate: activate,
    deactivate: deactivate,
    isActive: isFontFinderActive,
    detectTypography: detectTypography,
    getPrimaryFontFamily: getPrimaryFontFamily,
    resolveHoverTarget: resolveHoverTarget,
    isMediaElement: isMediaElement,
    updateHoverTip: updateHoverTip,
    resolveFontStatus: resolveFontStatus,
    persistResult: persistResult,
    historyKey: historyKey,
    buildCssText: buildCssText,
    normalizeColorToHex: normalizeColorToHex,
    cleanFamilyName: cleanFamilyName,
    stripVariableSuffix: stripVariableSuffix,
    buildGoogleFontsSpecimenUrl: buildGoogleFontsSpecimenUrl,
    buildGoogleFontsSearchUrl: buildGoogleFontsSearchUrl,
    parseGoogleFontsHref: parseGoogleFontsHref,
    collectGoogleFontsFamilies: collectGoogleFontsFamilies,
    isVerifiedGoogleFont: isVerifiedGoogleFont,
    getGoogleFontsInfo: getGoogleFontsInfo,
    openGoogleFontsUrl: openGoogleFontsUrl,
    getLastResult: function () {
      return lastResult;
    },
    closePanel: hidePanel
  };

  // ---------- Messaging with popup.js ----------

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string') {
      return false;
    }
    if (message.type === MESSAGE_ACTIVATE) {
      var result = activate();
      sendResponse({ ok: true, active: true, alreadyActive: result.alreadyActive });
      return false;
    }
    if (message.type === MESSAGE_DEACTIVATE) {
      deactivate();
      hidePanel();
      sendResponse({ ok: true, active: false });
      return false;
    }
    return false;
  });
})();
