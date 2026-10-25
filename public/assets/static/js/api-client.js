/**
 * ==========================================================================
 *  public/assets/static/js/api-client.js
 *  Wrapper fetch untuk API dashboard:
 *    - Menyertakan cookie sesi (credentials: same-origin).
 *    - Menambahkan header X-CSRF-Token otomatis dari cookie `csrf_token`
 *      untuk semua request non-GET (proteksi CSRF double-submit).
 *
 *  Pemakaian:
 *    const data = await apiFetch('/api/transactions', { method: 'POST', body: {...} });
 *  Atau pakai `apiGet`, `apiPost`, `apiPut`, `apiDelete`.
 * ==========================================================================
 */
(function () {
  'use strict';

  function readCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  /**
   * @param {string} url
   * @param {{method?:string, body?:any, headers?:object}} [options]
   * @returns {Promise<any>} JSON hasil parse (atau null bila kosong)
   */
  async function apiFetch(url, options) {
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var headers = Object.assign({}, opts.headers || {});
    var body = opts.body;

    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      var token = readCookie('csrf_token');
      if (token) headers['X-CSRF-Token'] = token;
    }

    var res = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      credentials: 'same-origin',
    });

    var text = await res.text();
    var data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { success: false, error: { message: text.slice(0, 200) } };
      }
    }

    if (res.status === 401) {
      // Sesi habis -> kembali ke halaman login.
      if (!/\/login$/.test(window.location.pathname)) window.location.href = '/login';
      throw new Error('Sesi berakhir, silakan login kembali.');
    }
    if (!res.ok) {
      var msg = (data && data.error && data.error.message) || 'Permintaan gagal (' + res.status + ')';
      var err = new Error(msg);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  window.apiFetch = apiFetch;
  window.apiGet = function (url) {
    return apiFetch(url, { method: 'GET' });
  };
  window.apiPost = function (url, body) {
    return apiFetch(url, { method: 'POST', body: body });
  };
  window.apiPut = function (url, body) {
    return apiFetch(url, { method: 'PUT', body: body });
  };
  window.apiDelete = function (url) {
    return apiFetch(url, { method: 'DELETE' });
  };
})();
