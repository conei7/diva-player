// Warm only the first page of the default Home ranking before React mounts.
// Keep this same-origin script compatible with the production script-src CSP.
(function (location) {
  var normalizedPath = location.pathname.replace(/\/+$/, '');
  var params = new URLSearchParams(location.search);
  var isHome = normalizedPath === '' || normalizedPath === '/diva-player';
  if (!isHome || params.has('q') || params.has('artistId')) return;

  function startPopularPage(start, count) {
    var url = '/backend-api/api/songs/search?sort=FavoritedTimes&order=desc&start=' + start
      + '&maxResults=' + count + '&onlyWithPVs=true&discoveryOnly=true&compact=true';
    var response = fetch(url);
    response.catch(function () {});
    var request = {
      url: url,
      response: response,
      data: response.then(function (result) {
        if (!result.ok) throw new Error('Startup search failed');
        return result.clone().json();
      }),
    };
    request.data.catch(function () {});
    return request;
  }

  window.__DIVA_STARTUP_POPULAR__ = startPopularPage(0, 12);
}(window.location));
