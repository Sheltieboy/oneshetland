// LOCAL-ONLY stand-in for Cloudflare's api.js. Loaded INSTEAD of the live script when NEXT_PUBLIC_TURNSTILE_SCRIPT_URL points at the local gateway.
// It never contacts Cloudflare. The mode comes from localStorage.mockTurnstileMode: valid (default) | invalid | expired | none | error.
(function () {
  var widgets = {}; var n = 0;
  function nonce() { return Math.random().toString(36).slice(2, 10); }
  function mode() { try { return localStorage.getItem('mockTurnstileMode') || 'valid'; } catch (e) { return 'valid'; } }
  function issue(w) {
    var m = mode();
    if (m === 'none') return;                                   // the visitor has not passed the check
    if (m === 'error') { w.opts['error-callback'] && w.opts['error-callback'](); return; }
    var kind = m === 'invalid' ? 'invalid' : m === 'expired' ? 'expired' : 'valid';
    w.opts.callback('mock.' + kind + '.' + (w.opts.action || 'none') + '.' + (w.opts.cData || 'none') + '.' + nonce());
  }
  window.turnstile = {
    render: function (el, opts) { var id = 'mock-' + (++n); widgets[id] = { el: el, opts: opts }; el.setAttribute('data-mock-turnstile', id); setTimeout(function () { issue(widgets[id]); }, 30); return id; },
    reset: function (id) { var w = widgets[id]; if (w) setTimeout(function () { issue(w); }, 30); },
    remove: function (id) { delete widgets[id]; },
  };
})();
