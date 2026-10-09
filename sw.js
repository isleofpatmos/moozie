/* ==========================================================================
   Offline Music — Service Worker
   --------------------------------------------------------------------------
   Responsibilities:
   - Cache the complete application shell
   - Allow the app to launch without internet after first successful load
   - Serve cached files quickly on subsequent launches
   - Update old application caches safely
   - Never attempt to cache local music files
     (local File System Access API files are handled by app.js)
   ========================================================================== */

"use strict";

/* ==========================================================================
   CACHE CONFIGURATION
   ========================================================================== */

/*
  Increment this whenever you make a new application release.

  Example:
    offline-music-v1
    offline-music-v2
    offline-music-v3
*/
const CACHE_VERSION = "v2";

const CACHE_NAME =
  `offline-music-${CACHE_VERSION}`;

/*
  Application shell.

  These are the files necessary for the PWA itself to boot offline.
  Local music files are deliberately NOT included here.
*/
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./music-player.svg"
];

/* ==========================================================================
   INSTALL
   ========================================================================== */

self.addEventListener(
  "install",
  (event) => {
    console.log(
      "[SW] Installing:",
      CACHE_NAME
    );

    /*
      Activate immediately instead of waiting for all tabs to close.
      This makes the cached shell available for the very next launch,
      which is critical for reliable offline startup on Chromebook.
    */
    self.skipWaiting();

    event.waitUntil(
      installApplicationShell()
    );
  }
);

async function installApplicationShell() {
  const cache =
    await caches.open(CACHE_NAME);

  /*
    First try the fast path (addAll). If any single resource fails, fall
    back to caching each file individually so that one bad fetch never
    leaves the entire shell uncached. The most important asset, the app
    entry point, is cached first and independently.
  */
  try {
    await cache.addAll(
      APP_SHELL
    );
  } catch (error) {
    console.warn(
      "[SW] addAll() failed, caching files individually.",
      error
    );

    await Promise.all(
      APP_SHELL.map(
        async (asset) => {
          try {
            await cache.add(
              asset
            );
          } catch (assetError) {
            console.warn(
              "[SW] Could not cache:",
              asset,
              assetError
            );
          }
        }
      )
    );
  }

  /*
    Guarantee the entry point is present, even if add() used a redirect
    for "./" that resolved to a different cache key than index.html.
  */
  try {
    const hasEntry =
      await cache.match(
        "./index.html"
      );

    if (!hasEntry) {
      await cache.add(
        "./index.html"
      );
    }
  } catch (error) {
    console.warn(
      "[SW] Could not ensure index.html is cached.",
      error
    );
  }

  console.log(
    "[SW] Application shell cached."
  );
}

/* ==========================================================================
   ACTIVATE
   ========================================================================== */

self.addEventListener(
  "activate",
  (event) => {
    console.log(
      "[SW] Activating:",
      CACHE_NAME
    );

    event.waitUntil(
      activateServiceWorker()
    );
  }
);

async function activateServiceWorker() {
  /*
    Delete caches belonging to previous application versions.
  */
  const cacheNames =
    await caches.keys();

  await Promise.all(
    cacheNames
      .filter(
        (cacheName) =>
          cacheName.startsWith(
            "offline-music-"
          ) &&
          cacheName !== CACHE_NAME
      )
      .map(
        (cacheName) =>
          caches.delete(cacheName)
      )
  );

  /*
    Claim clients only after activation.
    The currently open page remains controlled appropriately once
    a new service worker becomes active.
  */
  await self.clients.claim();

  console.log(
    "[SW] Old caches removed and clients claimed."
  );
}

/* ==========================================================================
   FETCH
   ========================================================================== */

self.addEventListener(
  "fetch",
  (event) => {
    const request =
      event.request;

    /*
      The service worker only needs to handle GET requests.
    */
    if (
      request.method !== "GET"
    ) {
      return;
    }

    const url =
      new URL(
        request.url
      );

    /*
      Never interfere with external websites, CDNs, APIs, etc.

      The application has no external runtime dependencies, but this
      protects the worker if that changes later.
    */
    if (
      url.origin !== self.location.origin
    ) {
      return;
    }

    /*
      Local files selected through the File System Access API use
      blob: URLs. They are not normal network requests and should
      never be handled by the service worker.
    */
    if (
      url.protocol === "blob:"
    ) {
      return;
    }

    /*
      Navigation requests:
      /music-player/
      /music-player/index.html
      etc.

      Use network-first (see handleNavigationRequest) so the app always
      loads fresh when online and Ctrl+R keeps working normally, while
      still falling back to the cached shell when offline.
    */
    if (
      request.mode === "navigate"
    ) {
      event.respondWith(
        handleNavigationRequest(request)
      );

      return;
    }

    /*
      Static application assets also use cache-first.
    */
    event.respondWith(
      handleAssetRequest(request)
    );
  }
);

/* ==========================================================================
   NAVIGATION STRATEGY
   ========================================================================== */

async function handleNavigationRequest(
  request
) {
  const cache =
    await caches.open(CACHE_NAME);

  /*
    NETWORK-FIRST navigation.

    When online we always fetch a fresh copy of the app shell and store
    it, so every successful load refreshes the offline copy (and keeps
    Ctrl+R working normally). When the network is unavailable we fall
    back to the cached shell so the installed PWA still opens offline.
  */
  try {
    const networkResponse =
      await fetch(request);

    if (
      isCacheableResponse(
        networkResponse
      )
    ) {
      cache.put(
        "./index.html",
        networkResponse.clone()
      );
    }

    return networkResponse;

  } catch (error) {
    /*
      We are offline (or the request failed). Serve the cached shell if
      it exists; otherwise show the offline notice.
    */
    const cachedResponse =
      await cache.match(
        "./index.html"
      );

    if (cachedResponse) {
      console.info(
        "[SW] Offline navigation served from cache."
      );

      return cachedResponse;
    }

    console.error(
      "[SW] Navigation failed and no cached shell is available:",
      error
    );

    return createOfflineFallbackResponse();
  }
}

/* ==========================================================================
   STATIC ASSET STRATEGY
   ========================================================================== */

async function handleAssetRequest(
  request
) {
  const cache =
    await caches.open(CACHE_NAME);

  const cachedResponse =
    await cache.match(
      request
    );

  if (cachedResponse) {
    /*
      Update the cached asset in the background.

      This gives us fast startup while still allowing application
      updates to reach the cache.
    */
    updateAssetInBackground(
      request
    );

    return cachedResponse;
  }

  /*
    Asset isn't cached yet.
    Fetch it normally and store it for subsequent offline use.
  */
  try {
    const networkResponse =
      await fetch(request);

    if (
      isCacheableResponse(
        networkResponse
      )
    ) {
      await cache.put(
        request,
        networkResponse.clone()
      );
    }

    return networkResponse;

  } catch (error) {
    console.error(
      "[SW] Asset request failed:",
      request.url,
      error
    );

    /*
      There is nothing useful to return when an uncached arbitrary
      asset cannot be fetched.
      */
    return new Response(
      "",
      {
        status: 503,
        statusText:
          "Offline and resource not cached."
      }
    );
  }
}

async function updateAssetInBackground(
  request
) {
  /*
    Do this asynchronously. The response already came from cache,
    so the user does not have to wait for the network.
    */
  try {
    const response =
      await fetch(
        request,
        {
          cache: "no-cache"
        }
      );

    if (
      !isCacheableResponse(
        response
      )
    ) {
      return;
    }

    const cache =
      await caches.open(
        CACHE_NAME
      );

    await cache.put(
      request,
      response.clone()
    );

  } catch (error) {
    /*
      Offline mode is expected. A failed background update is not
      an application error.
      */
  }
}

/* ==========================================================================
   RESPONSE VALIDATION
   ========================================================================== */

function isCacheableResponse(
  response
) {
  /*
    Basic successful response.
  */
  if (
    !response ||
    !response.ok
  ) {
    return false;
  }

  /*
    We only cache responses that are safe for same-origin application
    assets.

    Opaque responses are intentionally rejected because this PWA has
    no external asset dependency and opaque responses are difficult
    to reason about during offline operation.
  */
  if (
    response.type === "opaque"
  ) {
    return false;
  }

  return true;
}

/* ==========================================================================
   OFFLINE FALLBACK
   ========================================================================== */

function createOfflineFallbackResponse() {
  return new Response(
    `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        >
        <meta name="theme-color" content="#080a0f">
        <title>Moozie Player</title>
        <style>
          html,
          body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: #080a0f;
            color: #f4f7fb;
            font-family:
              Inter,
              system-ui,
              -apple-system,
              BlinkMacSystemFont,
              "Segoe UI",
              sans-serif;
          }

          body {
            display: grid;
            place-items: center;
          }

          main {
            width: min(420px, calc(100vw - 40px));
            text-align: center;
          }

          .icon {
            display: grid;
            place-items: center;
            width: 62px;
            height: 62px;
            margin: 0 auto 20px;
            border-radius: 18px;
            background: #17142d;
            color: #9689ff;
            font-size: 28px;
          }

          h1 {
            margin: 0;
            font-size: 22px;
          }

          p {
            margin-top: 10px;
            color: #8d96a5;
            font-size: 13px;
            line-height: 1.6;
          }
        </style>
      </head>

      <body>
        <main>
          <div class="icon">♫</div>
          <h1>Moozie Player</h1>
          <p>
            The application shell is not available yet.
            Connect to the internet once and reload the app so
            the offline version can be installed and cached.
          </p>
        </main>
      </body>
      </html>
    `,
    {
      status: 503,
      statusText: "Offline",
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8"
      }
    }
  );
}

/* ==========================================================================
   SERVICE WORKER MESSAGE API
   --------------------------------------------------------------------------
   These commands aren't required by app.js right now, but make the worker
   easier to maintain and update later.
   ========================================================================== */

self.addEventListener(
  "message",
  (event) => {
    if (!event.data) {
      return;
    }

    /*
      Optional explicit activation command.

      A future UI can send:

        navigator.serviceWorker.controller.postMessage({
          type: "SKIP_WAITING"
        });

      when the user explicitly clicks "Update".
    */
    if (
      event.data.type ===
      "SKIP_WAITING"
    ) {
      self.skipWaiting();
    }

    /*
      Useful during development/debugging.
    */
    if (
      event.data.type ===
      "CLEAR_CACHE"
    ) {
      event.waitUntil(
        clearApplicationCaches()
      );
    }
  }
);

async function clearApplicationCaches() {
  const cacheNames =
    await caches.keys();

  await Promise.all(
    cacheNames
      .filter(
        (name) =>
          name.startsWith(
            "offline-music-"
          )
      )
      .map(
        (name) =>
          caches.delete(name)
      )
  );
}
