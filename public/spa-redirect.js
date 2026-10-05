// Restore deep links created by the GitHub Pages SPA fallback.
(function (location) {
  if (location.search[1] !== '/') return;
  var decoded = location.search.slice(1).split('&').map(function (part) {
    return part.replace(/~and~/g, '&');
  }).join('?');
  window.history.replaceState(null, null, location.pathname.slice(0, -1) + decoded + location.hash);
}(window.location));
