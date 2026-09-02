// Privacy-aware renderer for untrusted email HTML.
// This file is deliberately a plain browser script: the app is an unbundled
// static SPA and exposes the small API below on window for app.js.
(function (global) {
  'use strict';

  var TRANSPARENT_PIXEL =
    'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  var SAFE_PROTOCOLS = ['mailto:', 'tel:'];

  function isHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    var raw = value.trim();
    try {
      // Protocol-relative URLs are external HTTP(S) resources too.
      var url = new URL(raw, global.location && global.location.href ? global.location.href : 'https://email.invalid/');
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function hasUnsafeProtocol(value) {
    if (typeof value !== 'string') return false;
    var compact = value.trim().replace(/[\u0000-\u0020]/g, '').toLowerCase();
    return /^(javascript:|vbscript:|file:|data:text\/html|data:application\/javascript)/.test(compact);
  }

  function isTrackingPixel(url, img) {
    var w = parseFloat(img.getAttribute('width') || '');
    var h = parseFloat(img.getAttribute('height') || '');
    if ((isFinite(w) && w > 0 && w <= 1) || (isFinite(h) && h > 0 && h <= 1)) return true;
    return /(?:pixel|beacon|tracking|track|spacer|open\b)/i.test(url || '');
  }

  function dimensionValue(img, name) {
    var attr = img.getAttribute(name);
    if (attr && /^\s*\d+(?:\.\d+)?(?:px)?\s*$/i.test(attr)) {
      return attr.trim().replace(/px$/i, '') + 'px';
    }
    var style = img.getAttribute('style') || '';
    var match = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'i').exec(style);
    if (match && /^(?:\d+(?:\.\d+)?(?:px|%|em|rem|vw|vh)|auto)$/i.test(match[1].trim())) {
      return match[1].trim();
    }
    return '';
  }

  function imagePlaceholderStyle(img, source) {
    if (isTrackingPixel(source, img)) return 'display:inline-block;width:1px;height:1px;';
    var width = dimensionValue(img, 'width');
    var height = dimensionValue(img, 'height');
    if (width && height) return 'display:inline-block;width:' + width + ';height:' + height + ';max-width:100%;';
    if (width) return 'display:inline-block;width:' + width + ';height:auto;min-height:80px;max-width:100%;aspect-ratio:16/9;';
    if (height) return 'display:inline-block;width:320px;height:' + height + ';max-width:100%;';
    return 'display:inline-block;width:320px;height:180px;max-width:100%;';
  }

  function styleHasExternalUrl(value) {
    var found = [];
    String(value || '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, function (all, _quote, url) {
      var trimmed = url.trim();
      // Only data:, cid: and fragment references are local. Treat relative or
      // obfuscated URLs as external so they cannot bypass the blocker.
      if (!/^(?:data:|cid:|#)/i.test(trimmed)) found.push(trimmed);
      return all;
    });
    return found;
  }

  function setJsonAttribute(el, name, value) {
    try { el.setAttribute(name, JSON.stringify(value)); } catch (_) { /* ignore malformed style data */ }
  }

  function getJsonAttribute(el, name, fallback) {
    try { return JSON.parse(el.getAttribute(name) || '') || fallback; } catch (_) { return fallback; }
  }

  function markBackgroundTarget(el) {
    el.classList.add('privacy-blocked-bg');
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
      el.setAttribute('data-privacy-added-tabindex', '1');
    }
    if (!el.hasAttribute('role')) {
      el.setAttribute('role', 'button');
      el.setAttribute('data-privacy-added-role', '1');
    }
  }

  function markInlineBackground(el, urls) {
    var original = el.getAttribute('style') || '';
    var properties = {};
    var css = el.style;
    for (var i = 0; i < css.length; i++) {
      var prop = css[i];
      var value = css.getPropertyValue(prop);
      if (styleHasExternalUrl(value).length) {
        properties[prop] = value;
        css.setProperty(prop, 'none', 'important');
      }
    }
    if (Object.keys(properties).length) {
      el.setAttribute('data-privacy-original-style', original);
      setJsonAttribute(el, 'data-privacy-backgrounds', urls);
      markBackgroundTarget(el);
      return true;
    }
    return false;
  }

  function processStyleBlocks(doc, counts) {
    doc.querySelectorAll('style').forEach(function (style) {
      var cssText = style.textContent || '';
      var external = styleHasExternalUrl(cssText);
      if (!external.length) return;
      counts.backgrounds += external.length;

      // Replace URLs in the stylesheet before it enters the live iframe. For
      // simple selectors, attach the original declarations to matched nodes so
      // the normal element click handler can restore them. Complex rules remain
      // safely blocked rather than being allowed to leak a request.
      var rewritten = cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, function (all, quote, url) {
        return /^(?:data:|cid:|#)/i.test(url.trim()) ? all : 'url("' + TRANSPARENT_PIXEL + '")';
      });
      style.textContent = rewritten;

      var ruleRe = /([^{}]+)\{([^{}]*)\}/g;
      var rule;
      while ((rule = ruleRe.exec(cssText))) {
        if (!styleHasExternalUrl(rule[2]).length) continue;
        rule[1].split(',').forEach(function (selector) {
          selector = selector.trim();
          if (!selector || selector.indexOf('@') === 0) return;
          var matched;
          try { matched = doc.querySelectorAll(selector); } catch (_) { matched = []; }
          matched.forEach(function (el) {
            var declarations = rule[2].split(';');
            var originals = getJsonAttribute(el, 'data-privacy-css-backgrounds', {});
            declarations.forEach(function (declaration) {
              var m = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/s.exec(declaration);
              if (!m || !styleHasExternalUrl(m[2]).length) return;
              originals[m[1]] = m[2];
              el.style.setProperty(m[1], 'none', 'important');
            });
            if (Object.keys(originals).length) {
              setJsonAttribute(el, 'data-privacy-css-backgrounds', originals);
              markBackgroundTarget(el);
            }
          });
        });
      }
    });
  }

  function sanitizeDangerousMarkup(doc) {
    ['script', 'noscript', 'base', 'meta', 'link', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'track'].forEach(function (tag) {
      doc.querySelectorAll(tag).forEach(function (el) { el.remove(); });
    });
    doc.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes || []).forEach(function (attr) {
        if (/^on/i.test(attr.name) || attr.name.toLowerCase() === 'srcdoc') el.removeAttribute(attr.name);
        if ((attr.name === 'href' || attr.name === 'src' || attr.name === 'xlink:href') && hasUnsafeProtocol(attr.value)) {
          el.removeAttribute(attr.name);
        }
      });
    });
  }

  function blockImages(doc, counts, labels) {
    doc.querySelectorAll('picture source[srcset]').forEach(function (source) {
      var srcset = source.getAttribute('srcset') || '';
      if (!isHttpUrl(srcset) && !/(?:^|[\s,])(?:https?:)?\/\//i.test(srcset)) return;
      source.setAttribute('data-privacy-srcset', srcset);
      source.removeAttribute('srcset');
    });

    doc.querySelectorAll('img').forEach(function (img) {
      var source = img.getAttribute('src') || '';
      var srcset = img.getAttribute('srcset') || '';
      var externalSource = isHttpUrl(source);
      var externalSrcset = isHttpUrl(srcset) || /(?:^|[\s,])(?:https?:)?\/\//i.test(srcset);
      var picture = img.closest ? img.closest('picture') : null;
      var externalPicture = picture && picture.querySelector('source[data-privacy-srcset]');
      if (!externalSource && !externalSrcset && !externalPicture) return;

      counts.images++;
      var wrapper = doc.createElement('span');
      wrapper.className = 'privacy-image-placeholder';
      wrapper.setAttribute('style', imagePlaceholderStyle(img, source || srcset));
      wrapper.setAttribute('role', 'button');
      wrapper.setAttribute('tabindex', '0');
      wrapper.setAttribute('aria-label', labels.image || 'Load external image');
      wrapper.setAttribute('title', labels.image || 'Load external image');

      if (externalSource) {
        img.setAttribute('data-privacy-src', source);
        img.setAttribute('src', TRANSPARENT_PIXEL);
      }
      if (externalSrcset) {
        img.setAttribute('data-privacy-srcset', srcset);
        img.removeAttribute('srcset');
      }
      img.classList.add('privacy-blocked-image');
      img.setAttribute('referrerpolicy', 'no-referrer');
      var badge = doc.createElement('span');
      badge.className = 'privacy-image-badge';
      badge.textContent = labels.imageMarker || '🔒';
      badge.setAttribute('aria-hidden', 'true');

      // Keep <source> and <img> as valid direct children of <picture>. Wrapping
      // the whole picture avoids the HTML parser moving source nodes around.
      var target = picture || img;
      target.parentNode.replaceChild(wrapper, target);
      wrapper.appendChild(target);
      wrapper.appendChild(badge);
    });

    // SVG image references (image/use/feImage and similar) and legacy
    // background attributes can also trigger image requests. They keep their
    // own box and use the background placeholder interaction, which restores
    // the attribute on click.
    doc.querySelectorAll('svg [href], svg [xlink\\:href]').forEach(function (image) {
      var href = image.getAttribute('href') || image.getAttribute('xlink:href') || '';
      if (!isHttpUrl(href)) return;
      counts.images++;
      image.setAttribute('data-privacy-svg-href', href);
      image.setAttribute('data-privacy-svg-attr', image.hasAttribute('xlink:href') ? 'xlink:href' : 'href');
      image.removeAttribute('href');
      image.removeAttribute('xlink:href');
      markBackgroundTarget(image);
    });
    doc.querySelectorAll('[background]').forEach(function (el) {
      var background = el.getAttribute('background') || '';
      if (!isHttpUrl(background)) return;
      counts.backgrounds++;
      el.setAttribute('data-privacy-background-attr', background);
      el.removeAttribute('background');
      markBackgroundTarget(el);
    });
  }

  function blockLinks(doc, counts) {
    doc.querySelectorAll('a[href]').forEach(function (anchor) {
      var href = anchor.getAttribute('href') || '';
      if (hasUnsafeProtocol(href)) {
        anchor.removeAttribute('href');
        return;
      }
      if (href.trim().indexOf('#') === 0) return;
      if (!isHttpUrl(href)) {
        if (SAFE_PROTOCOLS.some(function (p) { return href.trim().toLowerCase().indexOf(p) === 0; }) || href.trim().indexOf('#') === 0) return;
        // Relative and unknown schemes are not meaningful inside the isolated
        // frame; leave the text visible but make it inert.
        if (href.trim()) anchor.removeAttribute('href');
        return;
      }
      counts.links++;
      anchor.setAttribute('data-privacy-href', href);
      anchor.removeAttribute('href');
      anchor.classList.add('privacy-blocked-link');
      anchor.setAttribute('role', 'link');
      anchor.setAttribute('tabindex', '0');
      anchor.setAttribute('title', href);
    });
  }

  function normalizeLinksWhenUnblocked(doc) {
    doc.querySelectorAll('a[href]').forEach(function (anchor) {
      var href = anchor.getAttribute('href') || '';
      if (isHttpUrl(href) && href.trim().indexOf('#') !== 0) {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  function prepare(html, options) {
    options = options || {};
    var parser = new DOMParser();
    var doc = parser.parseFromString(String(html || ''), 'text/html');
    var counts = { images: 0, links: 0, backgrounds: 0 };
    var labels = options.labels || {};

    sanitizeDangerousMarkup(doc);
    var blockExternalContent = options.blockExternalContent !== false;
    if (blockExternalContent) {
      processStyleBlocks(doc, counts);
      doc.querySelectorAll('[style]').forEach(function (el) {
        var urls = styleHasExternalUrl(el.getAttribute('style'));
        if (urls.length) {
          counts.backgrounds += urls.length;
          markInlineBackground(el, urls);
        }
      });
      blockImages(doc, counts, labels);
      blockLinks(doc, counts);
    } else {
      normalizeLinksWhenUnblocked(doc);
    }

    var headStyles = doc.head ? Array.prototype.map.call(doc.head.querySelectorAll('style'), function (style) {
      return style.outerHTML;
    }).join('') : '';
    return {
      // DOMParser moves leading <style> elements into <head>; carry them into
      // the iframe body so normal email layout CSS is not lost.
      bodyHtml: headStyles + (doc.body ? doc.body.innerHTML : ''),
      counts: counts,
      blocked: counts.images + counts.links + counts.backgrounds,
    };
  }

  function restoreBackground(el) {
    var original = el.getAttribute('data-privacy-original-style');
    var cssOriginals = getJsonAttribute(el, 'data-privacy-css-backgrounds', {});
    if (original != null) el.setAttribute('style', original);
    Object.keys(cssOriginals).forEach(function (prop) {
      el.style.setProperty(prop, cssOriginals[prop]);
    });
    var backgroundAttr = el.getAttribute('data-privacy-background-attr');
    if (backgroundAttr) el.setAttribute('background', backgroundAttr);
    var svgHref = el.getAttribute('data-privacy-svg-href');
    var svgAttr = el.getAttribute('data-privacy-svg-attr') || 'href';
    if (svgHref) el.setAttribute(svgAttr, svgHref);
    el.removeAttribute('data-privacy-original-style');
    el.removeAttribute('data-privacy-backgrounds');
    el.removeAttribute('data-privacy-css-backgrounds');
    el.removeAttribute('data-privacy-background-attr');
    el.removeAttribute('data-privacy-svg-href');
    el.removeAttribute('data-privacy-svg-attr');
    if (el.getAttribute('data-privacy-added-tabindex') === '1') el.removeAttribute('tabindex');
    if (el.getAttribute('data-privacy-added-role') === '1') el.removeAttribute('role');
    el.removeAttribute('data-privacy-added-tabindex');
    el.removeAttribute('data-privacy-added-role');
    el.classList.remove('privacy-blocked-bg');
  }

  function restoreImage(wrapper) {
    var img = wrapper.querySelector('img[data-privacy-src], img[data-privacy-srcset], img.privacy-blocked-image');
    if (!img) return;
    var src = img.getAttribute('data-privacy-src');
    var srcset = img.getAttribute('data-privacy-srcset');
    if (src) img.setAttribute('src', src);
    if (srcset) img.setAttribute('srcset', srcset);
    var picture = wrapper.querySelector('picture') || (wrapper.closest ? wrapper.closest('picture') : null);
    if (picture) {
      picture.querySelectorAll('source[data-privacy-srcset]').forEach(function (source) {
        source.setAttribute('srcset', source.getAttribute('data-privacy-srcset') || '');
        source.removeAttribute('data-privacy-srcset');
      });
    }
    img.removeAttribute('data-privacy-src');
    img.removeAttribute('data-privacy-srcset');
    img.classList.remove('privacy-blocked-image');
    var badge = wrapper.querySelector('.privacy-image-badge');
    if (badge) badge.remove();
    // Replace the wrapper with the original image so its enclosing anchor and
    // surrounding email layout behave exactly as they did before blocking.
    var target = wrapper.querySelector('picture') || img;
    if (wrapper.parentNode) wrapper.parentNode.replaceChild(target, wrapper);
  }

  function bindFrame(frame, options) {
    options = options || {};
    var doc = frame && frame.contentDocument;
    if (!doc || frame.dataset.privacyBound === '1') return;
    frame.dataset.privacyBound = '1';

    function closest(el, selector) {
      while (el && el !== doc) {
        if (el.matches && el.matches(selector)) return el;
        el = el.parentNode;
      }
      return null;
    }

    function handleClick(event) {
      var target = event.target;
      var image = closest(target, '.privacy-image-placeholder');
      if (image) {
        event.preventDefault();
        event.stopPropagation();
        restoreImage(image);
        return;
      }
      var link = closest(target, 'a[data-privacy-href]');
      if (link) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof options.onExternalLink === 'function') options.onExternalLink(link.getAttribute('data-privacy-href') || '');
        return;
      }
      var background = closest(target, '.privacy-blocked-bg');
      if (background) restoreBackground(background);
    }

    function handleKey(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var target = event.target;
      var image = closest(target, '.privacy-image-placeholder');
      if (image) {
        event.preventDefault();
        restoreImage(image);
        return;
      }
      var link = closest(target, 'a[data-privacy-href]');
      if (link) {
        event.preventDefault();
        if (typeof options.onExternalLink === 'function') options.onExternalLink(link.getAttribute('data-privacy-href') || '');
        return;
      }
      var background = closest(target, '.privacy-blocked-bg');
      if (background) {
        event.preventDefault();
        restoreBackground(background);
      }
    }

    doc.addEventListener('click', handleClick, true);
    doc.addEventListener('keydown', handleKey, true);
  }

  global.EmailPrivacy = {
    prepare: prepare,
    bindFrame: bindFrame,
    transparentPixel: TRANSPARENT_PIXEL,
  };
})(window);
