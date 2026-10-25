/**
 * ==========================================================================
 *  public/assets/static/js/safe-dom.js
 *  Helper keamanan DOM untuk mencegah XSS.
 *
 *  Semua data yang berasal dari API (nama user, kategori, deskripsi, dsb.)
 *  WAJIB dilewatkan ke `esc()` sebelum disisipkan lewat innerHTML/template
 *  string. Untuk markup dinamis yang kompleks, gunakan `el()`.
 *
 *  Dipakai di: seluruh views/*.ejs (dimuat dari partials/head.ejs).
 * ==========================================================================
 */
(function () {
  'use strict';

  var MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
    '=': '&#61;',
  };

  /**
   * Escape sebuah nilai agar aman dipakai di dalam HTML (teks maupun atribut).
   * @param {*} value
   * @returns {string}
   */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`=]/g, function (ch) {
      return MAP[ch];
    });
  }

  /**
   * Buat elemen DOM dengan atribut & teks yang aman (tanpa innerHTML).
   * @param {string} tag
   * @param {object} [attrs]
   * @param {Array<Node|string>|string} [children]
   * @returns {HTMLElement}
   */
  function el(tag, attrs, children) {
    var node = document.createElement(tag || 'div');
    if (attrs && typeof attrs === 'object') {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'text') {
          node.textContent = String(value);
        } else if (key === 'className') {
          node.className = String(value);
        } else if (key === 'dataset' && typeof value === 'object') {
          Object.keys(value).forEach(function (k) {
            node.dataset[k] = String(value[k]);
          });
        } else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, String(value));
        }
      });
    }
    var list = children === undefined ? [] : [].concat(children);
    list.forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  window.esc = esc;
  window.escapeHtml = esc;
  window.el = el;
})();
