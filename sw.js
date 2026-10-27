// Bait & See offline support.
// App files: network first, saved copy when offline. Libraries and fonts: saved copy first.
// Weather, river and tide data: network first; when offline, the last saved reading is used
// and marked with an X-BS-Cached header so the app can say how old it is.
var VERSION = "bs-v1";
var SHELL = "shell-" + VERSION, LIBS = "libs-" + VERSION, DATA = "data-" + VERSION;
var SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./privacy.html", "./icons/icon-192.png", "./icons/icon-512.png"];
var LIB_HOSTS = ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];
var DATA_HOSTS = ["api.weather.gov", "api.waterdata.usgs.gov", "waterservices.usgs.gov", "api.tidesandcurrents.noaa.gov"];
var DATA_MAX = 80;

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return [SHELL, LIBS, DATA].indexOf(k) < 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function withTimeout(p, ms) {
  return new Promise(function (ok, fail) { var t = setTimeout(function () { fail(new Error("timeout")); }, ms); p.then(function (r) { clearTimeout(t); ok(r); }, function (er) { clearTimeout(t); fail(er); }); });
}
function trim(name, max) {
  return caches.open(name).then(function (c) { return c.keys().then(function (k) { if (k.length > max) return Promise.all(k.slice(0, k.length - max).map(function (r) { return c.delete(r); })); }); });
}
function shell(req) {
  return withTimeout(fetch(req), 5000).then(function (r) {
    if (r.ok) { var copy = r.clone(); caches.open(SHELL).then(function (c) { c.put(req.mode === "navigate" ? "./index.html" : req, copy); }); }
    return r;
  }).catch(function () {
    return caches.match(req.mode === "navigate" ? "./index.html" : req, { ignoreSearch: req.mode === "navigate" }).then(function (m) { return m || caches.match("./index.html"); });
  });
}
function lib(req) {
  return caches.match(req).then(function (m) {
    return m || fetch(req).then(function (r) { if (r.ok || r.type === "opaque") { var copy = r.clone(); caches.open(LIBS).then(function (c) { c.put(req, copy); }); } return r; });
  });
}
function data(req) {
  return fetch(req).then(function (r) {
    if (r.ok) {
      var copy = r.clone();
      copy.blob().then(function (b) {
        var h = new Headers(copy.headers); h.set("X-BS-Saved", String(Date.now()));
        return caches.open(DATA).then(function (c) { return c.put(req, new Response(b, { status: 200, headers: h })); });
      }).then(function () { return trim(DATA, DATA_MAX); });
    }
    return r;
  }).catch(function (err) {
    return caches.match(req).then(function (m) {
      if (!m) throw err;
      return m.blob().then(function (b) {
        var h = new Headers(m.headers); h.set("X-BS-Cached", h.get("X-BS-Saved") || "0");
        return new Response(b, { status: 200, headers: h });
      });
    });
  });
}
self.addEventListener("fetch", function (e) {
  var req = e.request; if (req.method !== "GET") return;
  var u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (/\/server\//.test(u.pathname)) return;
    e.respondWith(shell(req));
  } else if (LIB_HOSTS.indexOf(u.hostname) >= 0) e.respondWith(lib(req));
  else if (DATA_HOSTS.indexOf(u.hostname) >= 0) e.respondWith(data(req));
});
