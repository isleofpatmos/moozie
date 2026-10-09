/* ==========================================================================
   Offline Music — app.js
   --------------------------------------------------------------------------
   Pure client-side music player for Chromium / Chromebook.

   Responsibilities:
   - File System Access API folder selection and permission recovery
   - Recursive local folder scanning
   - IndexedDB library persistence
   - LocalStorage settings persistence
   - HTML5 Audio playback
   - Shuffle / Repeat Off / Repeat All / Repeat Single
   - Volume + mute persistence
   - Last-track persistence
   - Playlist rendering and filtering
   - Responsive panel collapsing
   - PWA service-worker registration
   - Graceful handling of unsupported browsers, empty folders, permissions,
     missing files and audio metadata errors
   ========================================================================== */

"use strict";

/* ==========================================================================
   CONSTANTS
   ========================================================================== */

const APP_VERSION = "1.0.0";
const DB_NAME = "offline-music-db";
const DB_VERSION = 1;

const TRACK_STORE = "tracks";
const META_STORE = "meta";

const SETTINGS_KEY = "offlineMusic.settings.v1";

const SUPPORTED_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "flac",
  "ogg"
]);

const DEFAULT_SETTINGS = {
  extensions: {
    mp3: true,
    wav: true,
    m4a: true,
    flac: true,
    ogg: true
  },

  volume: 0.7,
  muted: false,

  shuffle: false,
  repeatMode: "off",

  leftCollapsed: false,
  rightCollapsed: false,

  sortDirection: "asc",

  lastTrackId: null,
  lastPosition: 0
};

/* ==========================================================================
   DOM REFERENCES
   ========================================================================== */

const app = document.getElementById("app");

const audio = document.getElementById("audioPlayer");

const playlist = document.getElementById("playlist");
const playlistEmptyState = document.getElementById("playlistEmptyState");
const playlistCount = document.getElementById("playlistCount");

const currentTrackTitle = document.getElementById("currentTrackTitle");
const currentTrackArtist = document.getElementById("currentTrackArtist");
const playingContext = document.getElementById("playingContext");

const albumArt = document.getElementById("albumArt");

const progressTrack = document.getElementById("progressTrack");
const progressFill = document.getElementById("progressFill");
const currentTimeElement = document.getElementById("currentTime");
const remainingTimeElement = document.getElementById("remainingTime");

const playPauseButton = document.getElementById("playPauseButton");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");

const previousButton = document.getElementById("previousButton");
const nextButton = document.getElementById("nextButton");

const shuffleButton = document.getElementById("shuffleButton");

const repeatButton = document.getElementById("repeatButton");
const repeatIcon = document.getElementById("repeatIcon");
const repeatLabel = document.getElementById("repeatLabel");

const volumeButton = document.getElementById("volumeButton");
const volumeHighIcon = document.getElementById("volumeHighIcon");
const volumeMutedIcon = document.getElementById("volumeMutedIcon");
const volumeSlider = document.getElementById("volumeSlider");

const selectMusicFolderButton =
  document.getElementById("selectMusicFolder");

const resetSettingsButton =
  document.getElementById("resetSettings");

const sortPlaylistButton =
  document.getElementById("sortPlaylistButton");

const brandMarkToggle =
  document.getElementById("brandMarkToggle");

const toggleLeftPanelButton =
  document.getElementById("toggleLeftPanel");

const toggleRightPanelButton =
  document.getElementById("toggleRightPanel");

const leftPanelToggleIcon =
  document.getElementById("leftPanelToggleIcon");

const rightPanelToggleIcon =
  document.getElementById("rightPanelToggleIcon");

const systemBanner =
  document.getElementById("systemBanner");

const systemBannerText =
  document.getElementById("systemBannerText");

/* ==========================================================================
   STATE
   ========================================================================== */

const state = {
  db: null,

  settings: loadSettings(),

  tracks: [],

  /*
    Tracks currently visible according to the extension filter.
  */
  visibleTracks: [],

  /*
    Actual track currently loaded/selected.
  */
  currentTrackId: null,
  currentTrackIndex: -1,

  /*
    Shuffle order stores track IDs, not array indexes.
    This makes it stable when the visible playlist gets resorted.
  */
  shuffleOrder: [],
  shufflePosition: -1,

  /*
    Currently selected local music directory.
  */
  directoryHandle: null,

  /*
    Currently active object URL.
  */
  objectUrl: null,

  /*
    Used to prevent old asynchronous operations from changing state
    after a newer track has already been selected.
  */
  loadGeneration: 0,

  /*
    Prevents several simultaneous folder scans.
  */
  isScanning: false,

  /*
    Animation frame used for smooth progress updates.
  */
  progressAnimationFrame: null,

  /*
    Used to restore the last position once the audio metadata is known.
  */
  pendingResumePosition: 0,

  /*
    Small timer used for delayed saving of the current playback position.
  */
  savePositionTimer: null,

  /*
    Used to distinguish deliberate source changes from natural endings.
  */
  isChangingTrack: false,

  /*
    Temporary message timer.
  */
  bannerTimer: null
};

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  try {
    bindEvents();

    applySettingsToUI();

    setVolumeFromSettings();

    updatePlaybackControls();
    updateShuffleUI();
    updateRepeatUI();
    updatePanelUI();

    setStatus(
      "Ready",
      "No music folder has been indexed yet.",
      "ready"
    );

    await openDatabase();

    /*
      Load previously indexed metadata immediately. This means the
      playlist can remain visible after restarting the app even before
      directory permission is granted again.
    */
    await loadStoredTracks();

    /*
      Recover the previously selected directory handle if one exists.
    */
    await recoverStoredDirectoryHandle();

    /*
      If IndexedDB contains a library, determine whether Chrome still
      allows access to the previously selected directory.
    */
    await evaluateDirectoryPermission();

    /*
      Restore the last track visually. Actual file access happens only
      when playback is requested, because Chrome may require a fresh
      permission grant after restart.
    */
    restoreLastTrackUI();

    /*
      Register the PWA service worker.
    */
    await registerServiceWorker();

    /*
      Give the user a useful initial state.
    */
    updateConnectivityBanner();

    window.addEventListener(
      "online",
      updateConnectivityBanner
    );

    window.addEventListener(
      "offline",
      updateConnectivityBanner
    );

    /*
      Persist the last known playback position before navigation/
      application termination.
    */
    window.addEventListener(
      "beforeunload",
      savePlaybackStateImmediately
    );

  } catch (error) {
    console.error("Application initialization failed:", error);

    showBanner(
      "The music player could not initialize correctly.",
      "error",
      6000
    );

    setStatus(
      "Error",
      error?.message || "Initialization failed.",
      "error"
    );
  }
}

/* ==========================================================================
   EVENT BINDING
   ========================================================================== */

function bindEvents() {
  /*
    Folder access
  */
  selectMusicFolderButton.addEventListener(
    "click",
    handleMusicFolderButtonClick
  );

  /*
    Main playback
  */
  playPauseButton.addEventListener(
    "click",
    togglePlayback
  );

  previousButton.addEventListener(
    "click",
    previousTrack
  );

  nextButton.addEventListener(
    "click",
    nextTrack
  );

  /*
    Shuffle / repeat
  */
  shuffleButton.addEventListener(
    "click",
    toggleShuffle
  );

  repeatButton.addEventListener(
    "click",
    cycleRepeatMode
  );

  /*
    Volume
  */
  volumeButton.addEventListener(
    "click",
    toggleMute
  );

  volumeSlider.addEventListener(
    "input",
    handleVolumeInput
  );

  /*
    Progress / seeking
  */
  progressTrack.addEventListener(
    "click",
    handleProgressClick
  );

  progressTrack.addEventListener(
    "keydown",
    handleProgressKeyboard
  );

  /*
    Playlist
  */
  playlist.addEventListener(
    "click",
    handlePlaylistClick
  );

  sortPlaylistButton.addEventListener(
    "click",
    toggleSortDirection
  );

  /*
    Extension filters
  */
  const extensionInputs =
    document.querySelectorAll(
      'input[name="extension"]'
    );

  extensionInputs.forEach((input) => {
    input.addEventListener(
      "change",
      handleExtensionFilterChange
    );
  });

  /*
    Panels
  */
  brandMarkToggle.addEventListener(
    "click",
    toggleLeftPanel
  );

  toggleLeftPanelButton.addEventListener(
    "click",
    toggleLeftPanel
  );

  toggleRightPanelButton.addEventListener(
    "click",
    toggleRightPanel
  );

  /*
    Settings reset
  */
  resetSettingsButton.addEventListener(
    "click",
    resetAppSettings
  );

  /*
    HTML audio events
  */
  audio.addEventListener(
    "loadedmetadata",
    handleAudioLoadedMetadata
  );

  audio.addEventListener(
    "canplay",
    handleAudioCanPlay
  );

  audio.addEventListener(
    "timeupdate",
    handleAudioTimeUpdate
  );

  audio.addEventListener(
    "play",
    handleAudioPlay
  );

  audio.addEventListener(
    "pause",
    handleAudioPause
  );

  audio.addEventListener(
    "ended",
    handleAudioEnded
  );

  audio.addEventListener(
    "error",
    handleAudioError
  );

  audio.addEventListener(
    "volumechange",
    handleAudioVolumeChange
  );

  /*
    Keyboard shortcuts make the Chromebook experience nicer without
    interfering with normal typing fields.
  */
  document.addEventListener(
    "keydown",
    handleGlobalKeyboard
  );
}

/* ==========================================================================
   SETTINGS — LOCALSTORAGE
   ========================================================================== */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);

    if (!raw) {
      return structuredClone(DEFAULT_SETTINGS);
    }

    const parsed = JSON.parse(raw);

    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      extensions: {
        ...DEFAULT_SETTINGS.extensions,
        ...(parsed.extensions || {})
      }
    };
  } catch (error) {
    console.warn(
      "Could not load saved settings. Using defaults.",
      error
    );

    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify(state.settings)
    );
  } catch (error) {
    console.warn(
      "Could not persist settings:",
      error
    );
  }
}

/* ==========================================================================
   INDEXEDDB
   ========================================================================== */

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(
        new Error(
          "IndexedDB is not available in this browser."
        )
      );
      return;
    }

    const request = indexedDB.open(
      DB_NAME,
      DB_VERSION
    );

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        const trackStore = db.createObjectStore(
          TRACK_STORE,
          { keyPath: "id" }
        );

        trackStore.createIndex(
          "name",
          "name",
          { unique: false }
        );

        trackStore.createIndex(
          "relativePath",
          "relativePath",
          { unique: false }
        );
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(
          META_STORE,
          { keyPath: "key" }
        );
      }
    };

    request.onsuccess = () => {
      state.db = request.result;

      state.db.onversionchange = () => {
        state.db.close();
      };

      resolve(state.db);
    };

    request.onerror = () => {
      reject(
        request.error ||
        new Error("Could not open IndexedDB.")
      );
    };
  });
}

/* --------------------------------------------------------------------------
   Generic IndexedDB helpers
   -------------------------------------------------------------------------- */

function dbTransaction(
  storeName,
  mode = "readonly"
) {
  return state.db.transaction(
    storeName,
    mode
  ).objectStore(storeName);
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(
        request.error ||
        new Error("IndexedDB request failed.")
      );
    };
  });
}

/* ==========================================================================
   DIRECTORY HANDLE PERSISTENCE
   ========================================================================== */

async function saveDirectoryHandle(handle) {
  await idbRequest(
    dbTransaction(
      META_STORE,
      "readwrite"
    ).put({
      key: "directoryHandle",
      value: handle
    })
  );
}

async function getStoredDirectoryHandle() {
  return idbRequest(
    dbTransaction(
      META_STORE,
      "readonly"
    ).get("directoryHandle")
  );
}

/* ==========================================================================
   STORED TRACK METADATA
   ========================================================================== */

async function loadStoredTracks() {
  if (!state.db) {
    return;
  }

  const storedTracks = await idbRequest(
    dbTransaction(
      TRACK_STORE,
      "readonly"
    ).getAll()
  );

  state.tracks = Array.isArray(storedTracks)
    ? storedTracks
    : [];

  applyCurrentFilterAndRender();
}

async function replaceStoredTracks(tracks) {
  const store = dbTransaction(
    TRACK_STORE,
    "readwrite"
  );

  await new Promise((resolve, reject) => {
    const clearRequest = store.clear();

    clearRequest.onerror = () => {
      reject(
        clearRequest.error ||
        new Error("Could not clear old library.")
      );
    };

    clearRequest.onsuccess = () => {
      if (!tracks.length) {
        resolve();
        return;
      }

      let completed = 0;
      let failed = false;

      for (const track of tracks) {
        const request = store.put(track);

        request.onerror = () => {
          if (failed) return;

          failed = true;

          reject(
            request.error ||
            new Error("Could not save track metadata.")
          );
        };

        request.onsuccess = () => {
          completed += 1;

          if (
            completed === tracks.length &&
            !failed
          ) {
            resolve();
          }
        };
      }
    };
  });
}

/* ==========================================================================
   DIRECTORY / PERMISSION RECOVERY
   ========================================================================== */

async function recoverStoredDirectoryHandle() {
  try {
    const handle = await getStoredDirectoryHandle();

    if (
      handle &&
      handle.kind === "directory"
    ) {
      state.directoryHandle = handle;
    }
  } catch (error) {
    console.warn(
      "Stored directory handle could not be recovered:",
      error
    );

    state.directoryHandle = null;
  }
}

async function evaluateDirectoryPermission() {
  if (!state.directoryHandle) {
    updateFolderButtonState("select");
    return;
  }

  try {
    const permission =
      await state.directoryHandle.queryPermission({
        mode: "read"
      });

    if (permission === "granted") {
      updateFolderButtonState("rescan");

      setStatus(
        "Ready",
        state.tracks.length
          ? "Music library is available."
          : "Folder access is available but no songs are indexed.",
        "ready"
      );
    } else {
      updateFolderButtonState("reconnect");

      if (state.tracks.length > 0) {
        showBanner(
          "Your music library is saved, but folder access needs to be granted again.",
          "warning",
          7000
        );

        setStatus(
          "Permission required",
          "Click “Reconnect Music Folder” to restore access.",
          "warning"
        );
      }
    }
  } catch (error) {
    console.warn(
      "Could not check directory permission:",
      error
    );

    updateFolderButtonState("reconnect");
  }
}

async function requestDirectoryPermission(handle) {
  if (!handle) {
    return false;
  }

  try {
    const permission =
      await handle.requestPermission({
        mode: "read"
      });

    return permission === "granted";
  } catch (error) {
    console.warn(
      "Directory permission request failed:",
      error
    );

    return false;
  }
}

/* ==========================================================================
   FOLDER SELECTION / SCANNING
   ========================================================================== */

async function handleMusicFolderButtonClick() {
  if (
    !window.isSecureContext ||
    !("showDirectoryPicker" in window)
  ) {
    showUnsupportedFileSystemMessage();
    return;
  }

  /*
    First attempt to reuse a previously selected folder.

    This is important because File System Access permissions may show
    "prompt" after a browser restart. Since this click is initiated
    by the user, requestPermission() is allowed to show the Chrome
    permission prompt.
  */
  if (state.directoryHandle) {
    try {
      const permission =
        await state.directoryHandle.queryPermission({
          mode: "read"
        });

      if (permission !== "granted") {
        const granted =
          await requestDirectoryPermission(
            state.directoryHandle
          );

        if (!granted) {
          showBanner(
            "Folder permission was not granted.",
            "warning",
            5000
          );

          updateFolderButtonState("reconnect");
          return;
        }
      }

      await scanCurrentDirectory();
      return;

    } catch (error) {
      console.warn(
        "Stored directory handle could not be reused:",
        error
      );

      /*
        Fall through to a fresh folder picker.
      */
    }
  }

  /*
    No usable stored directory. Open a fresh picker.
  */
  try {
    const handle =
      await window.showDirectoryPicker({
        mode: "read",
        id: "offline-music-library"
      });

    if (!handle) {
      return;
    }

    state.directoryHandle = handle;

    await saveDirectoryHandle(handle);

    updateFolderButtonState("rescan");

    await scanCurrentDirectory();

  } catch (error) {
    /*
      AbortError simply means the user cancelled the picker.
    */
    if (
      error &&
      error.name === "AbortError"
    ) {
      return;
    }

    console.error(
      "Could not select music folder:",
      error
    );

    showBanner(
      "The music folder could not be selected.",
      "error",
      6000
    );

    setStatus(
      "Folder error",
      error?.message ||
      "Could not access the selected folder.",
      "error"
    );
  }
}

async function scanCurrentDirectory() {
  if (!state.directoryHandle) {
    return;
  }

  if (state.isScanning) {
    return;
  }

  state.isScanning = true;

  updateFolderButtonState("scanning");

  setStatus(
    "Scanning",
    "Searching for audio files...",
    "scanning"
  );

  showBanner(
    "Scanning your music folder…",
    "ready"
  );

  try {
    /*
      Always scan all supported audio types.

      The extension checkboxes control what is displayed in the
      playlist rather than what gets permanently stored. This means
      the user can enable a previously disabled format without
      having to rescan the folder.
    */
    const scannedTracks = [];

    const totalStats = {
      filesSeen: 0,
      supportedFiles: 0,
      failedFiles: 0,
      directories: 0
    };

    await scanDirectoryRecursive(
      state.directoryHandle,
      [],
      scannedTracks,
      totalStats
    );

    /*
      Sort by name before saving.
    */
    scannedTracks.sort(compareTracksByName);

    /*
      Replace the old metadata with the latest scan.
    */
    await replaceStoredTracks(
      scannedTracks
    );

    state.tracks = scannedTracks;

    /*
      Preserve the last selected track if it still exists.
    */
    if (
      state.currentTrackId &&
      !state.tracks.some(
        (track) => track.id === state.currentTrackId
      )
    ) {
      state.currentTrackId = null;
      state.currentTrackIndex = -1;

      state.settings.lastTrackId = null;
      state.settings.lastPosition = 0;

      saveSettings();

      resetNowPlayingUI();
    }

    /*
      Rebuild shuffle state because the playlist changed.
    */
    rebuildShuffleOrder();

    applyCurrentFilterAndRender();

    updateFolderButtonState("rescan");

    if (scannedTracks.length === 0) {
      setStatus(
        "Folder is empty",
        "No supported music files were found.",
        "warning"
      );

      showBanner(
        "No supported audio files were found in that folder.",
        "warning",
        7000
      );

    } else {
      setStatus(
        "Ready",
        `${formatNumber(scannedTracks.length)} songs indexed.`,
        "ready"
      );

      showBanner(
        `${formatNumber(scannedTracks.length)} songs indexed.`,
        "ready",
        3500
      );
    }

  } catch (error) {
    console.error(
      "Music folder scan failed:",
      error
    );

    setStatus(
      "Scan failed",
      error?.message ||
      "The selected folder could not be scanned.",
      "error"
    );

    showBanner(
      "The music folder could not be scanned.",
      "error",
      6000
    );

  } finally {
    state.isScanning = false;

    if (state.directoryHandle) {
      updateFolderButtonState("rescan");
    } else {
      updateFolderButtonState("select");
    }
  }
}

/**
 * Recursively walks a File System Access directory handle.
 */
async function scanDirectoryRecursive(
  directoryHandle,
  pathSegments,
  output,
  stats
) {
  stats.directories += 1;

  for await (
    const [name, handle]
    of directoryHandle.entries()
  ) {
    if (handle.kind === "directory") {
      await scanDirectoryRecursive(
        handle,
        [...pathSegments, name],
        output,
        stats
      );

      continue;
    }

    if (handle.kind !== "file") {
      continue;
    }

    stats.filesSeen += 1;

    const extension =
      getFileExtension(name);

    if (
      !extension ||
      !SUPPORTED_EXTENSIONS.has(extension)
    ) {
      continue;
    }

    stats.supportedFiles += 1;

    try {
      const file = await handle.getFile();

      const relativePath = [
        ...pathSegments,
        name
      ].join("/");

      const track = {
        /*
          Path acts as a stable identity within the selected folder.
        */
        id: normalizePath(relativePath),

        name: parseTrackName(name),

        artist: parseArtist(name),

        extension,

        relativePath,

        pathSegments: [
          ...pathSegments
        ],

        size: file.size,

        lastModified: file.lastModified,

        duration: 0,

        indexedAt: Date.now()
      };

      /*
        Metadata duration is best-effort. An unsupported/corrupt file
        should not prevent the rest of the library from being indexed.
      */
      try {
        track.duration =
          await getAudioDuration(file);
      } catch (durationError) {
        console.warn(
          `Could not read duration for ${name}:`,
          durationError
        );

        track.duration = 0;
      }

      output.push(track);

      /*
        Give the browser/UI event loop breathing room on huge libraries.
      */
      if (
        stats.supportedFiles % 10 === 0
      ) {
        setStatus(
          "Scanning",
          `${formatNumber(
            stats.supportedFiles
          )} audio files found…`,
          "scanning"
        );

        await yieldToBrowser();
      }

    } catch (error) {
      stats.failedFiles += 1;

      console.warn(
        `Could not index file "${name}":`,
        error
      );
    }
  }
}

/**
 * Reads only the metadata duration through an object URL.
 *
 * No entire song is decoded into memory.
 */
function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const tempAudio = document.createElement("audio");
    const url = URL.createObjectURL(file);

    let finished = false;

    const cleanup = () => {
      if (finished) return;

      finished = true;

      tempAudio.removeAttribute("src");
      tempAudio.load();

      URL.revokeObjectURL(url);
    };

    const timeout = setTimeout(() => {
      cleanup();

      /*
        Duration could not be determined within a reasonable time.
      */
      reject(
        new Error(
          "Timed out while reading audio metadata."
        )
      );
    }, 12000);

    tempAudio.preload = "metadata";

    tempAudio.onloadedmetadata = () => {
      clearTimeout(timeout);

      const duration =
        Number.isFinite(tempAudio.duration)
          ? tempAudio.duration
          : 0;

      cleanup();

      resolve(duration);
    };

    tempAudio.onerror = () => {
      clearTimeout(timeout);

      cleanup();

      reject(
        new Error(
          "Audio metadata could not be read."
        )
      );
    };

    tempAudio.src = url;
  });
}

/* ==========================================================================
   DIRECTORY FILE ACCESS
   ========================================================================== */

async function getFileFromCurrentDirectory(track) {
  if (!state.directoryHandle) {
    throw new Error(
      "No music folder is currently connected."
    );
  }

  let currentHandle =
    state.directoryHandle;

  /*
    Walk the directory tree using the saved relative path.
  */
  for (
    const segment
    of track.pathSegments || []
  ) {
    currentHandle =
      await currentHandle.getDirectoryHandle(
        segment
      );
  }

  const fileHandle =
    await currentHandle.getFileHandle(
      track.nameWithExtension ||
      getFileNameFromPath(track.relativePath)
    );

  return fileHandle.getFile();
}

/*
  The database stores the parsed display name separately, so the actual
  filesystem filename is reconstructed from the relative path.
*/
function getFileNameFromPath(path) {
  const normalized =
    String(path || "").replaceAll("\\", "/");

  const pieces = normalized.split("/");

  return pieces[pieces.length - 1] || "";
}

/* ==========================================================================
   PLAYLIST FILTERING / SORTING
   ========================================================================== */

function applyCurrentFilterAndRender() {
  const enabledExtensions =
    getEnabledExtensions();

  state.visibleTracks =
    state.tracks.filter((track) =>
      enabledExtensions.has(track.extension)
    );

  sortVisibleTracks();

  ensureCurrentTrackStillVisible();

  updatePlaylistCount();

  renderPlaylist();
  updateCurrentTrackIndex();

  /*
    If shuffle is already enabled, the available set may have changed.
  */
  rebuildShuffleOrder(false);
}

function getEnabledExtensions() {
  const enabled = new Set();

  for (
    const extension
    of SUPPORTED_EXTENSIONS
  ) {
    if (
      state.settings.extensions[extension]
    ) {
      enabled.add(extension);
    }
  }

  return enabled;
}

function sortVisibleTracks() {
  state.visibleTracks.sort(
    (a, b) => {
      const result =
        compareTracksByName(a, b);

      return state.settings.sortDirection === "asc"
        ? result
        : -result;
    }
  );
}

function compareTracksByName(a, b) {
  return String(a.name)
    .localeCompare(
      String(b.name),
      undefined,
      {
        sensitivity: "base",
        numeric: true
      }
    );
}

function toggleSortDirection() {
  state.settings.sortDirection =
    state.settings.sortDirection === "asc"
      ? "desc"
      : "asc";

  saveSettings();

  sortVisibleTracks();

  renderPlaylist();
}

/* ==========================================================================
   PLAYLIST RENDERING
   ========================================================================== */

function renderPlaylist() {
  /*
    Remove generated children while preserving our empty-state element.
  */
  const generatedItems =
    playlist.querySelectorAll(
      ".track-item"
    );

  generatedItems.forEach((item) => {
    item.remove();
  });

  playlistEmptyState.classList.toggle(
    "hidden",
    state.visibleTracks.length > 0
  );

  if (state.visibleTracks.length === 0) {
    return;
  }

  const fragment =
    document.createDocumentFragment();

  state.visibleTracks.forEach(
    (track, index) => {
      const button =
        document.createElement("button");

      button.type = "button";
      button.className = "track-item";

      button.dataset.trackId = track.id;

      button.setAttribute(
        "aria-label",
        `Play ${track.name}`
      );

      button.setAttribute(
        "aria-setsize",
        String(state.visibleTracks.length)
      );

      button.setAttribute(
        "aria-posinset",
        String(index + 1)
      );

      if (
        track.id === state.currentTrackId
      ) {
        button.classList.add(
          "is-active"
        );
      }

      const art =
        document.createElement("span");

      art.className = "track-art";
      art.setAttribute(
        "aria-hidden",
        "true"
      );

      art.innerHTML = `
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 18V5l10-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="16" cy="16" r="3" />
        </svg>
      `;

      const info =
        document.createElement("span");

      info.className = "track-info";

      const name =
        document.createElement("span");

      name.className = "track-name";
      name.textContent =
        track.name || "Unknown track";

      const artist =
        document.createElement("span");

      artist.className = "track-artist";
      artist.textContent =
        track.artist || "Unknown artist";

      info.appendChild(name);
      info.appendChild(artist);

      const duration =
        document.createElement("span");

      duration.className =
        "track-duration";

      duration.textContent =
        formatTime(track.duration);

      button.appendChild(art);
      button.appendChild(info);
      button.appendChild(duration);

      fragment.appendChild(button);
    }
  );

  playlist.appendChild(fragment);
}

function updatePlaylistCount() {
  const count =
    state.visibleTracks.length;

  playlistCount.textContent =
    `${formatNumber(count)} ${
      count === 1 ? "song" : "songs"
    }`;
}

function handlePlaylistClick(event) {
  const trackButton =
    event.target.closest(
      ".track-item"
    );

  if (!trackButton) {
    return;
  }

  const trackId =
    trackButton.dataset.trackId;

  if (!trackId) {
    return;
  }

  playTrackById(trackId);
}

/* ==========================================================================
   CURRENT TRACK UI
   ========================================================================== */

function restoreLastTrackUI() {
  if (!state.settings.lastTrackId) {
    resetNowPlayingUI();
    return;
  }

  const track =
    state.tracks.find(
      (item) =>
        item.id ===
        state.settings.lastTrackId
    );

  if (!track) {
    resetNowPlayingUI();
    return;
  }

  state.currentTrackId =
    track.id;

  state.pendingResumePosition =
    Number(state.settings.lastPosition) || 0;

  updateCurrentTrackUI(track);
  updateCurrentTrackIndex();

  renderPlaylist();
}

function ensureCurrentTrackStillVisible() {
  if (!state.currentTrackId) {
    return;
  }

  const stillVisible =
    state.visibleTracks.some(
      (track) =>
        track.id === state.currentTrackId
    );

  if (!stillVisible) {
    /*
      Keep the selected track metadata but don't force it out of
      "current track" state. This becomes useful if the user toggles
      its extension back on.
    */
    return;
  }
}

function updateCurrentTrackIndex() {
  state.currentTrackIndex =
    state.visibleTracks.findIndex(
      (track) =>
        track.id === state.currentTrackId
    );
}

function updateCurrentTrackUI(track) {
  if (!track) {
    resetNowPlayingUI();
    return;
  }

  currentTrackTitle.textContent =
    track.name || "Unknown track";

  currentTrackArtist.textContent =
    track.artist || "Unknown artist";

  playingContext.textContent =
    audio.src
      ? "Now playing"
      : "Ready to play";

  playlist
    .querySelectorAll(
      ".track-item.is-active"
    )
    .forEach((item) => {
      item.classList.remove(
        "is-active"
      );
    });

  const currentButton =
    playlist.querySelector(
      `[data-track-id="${cssEscape(track.id)}"]`
    );

  currentButton?.classList.add(
    "is-active"
  );

  updateDocumentTitle(
    track.name
  );
}

function resetNowPlayingUI() {
  currentTrackTitle.textContent =
    "No track selected";

  currentTrackArtist.textContent =
    state.tracks.length
      ? "Select a track to begin"
      : "Select a folder to begin";

  playingContext.textContent =
    "Not playing";

  currentTimeElement.textContent =
    "0:00";

  remainingTimeElement.textContent =
    "-0:00";

  progressFill.style.width =
    "0%";

  progressTrack.setAttribute(
    "aria-valuemax",
    "0"
  );

  progressTrack.setAttribute(
    "aria-valuenow",
    "0"
  );

  albumArt.classList.remove(
    "is-playing"
  );

  updateDocumentTitle();

  playlist
    .querySelectorAll(
      ".track-item.is-active"
    )
    .forEach((item) => {
      item.classList.remove(
        "is-active"
      );
    });
}

function updateDocumentTitle(trackName = null) {
  document.title =
    trackName
      ? `${trackName} — Moozie Player`
      : "Moozie Player";
}

/* ==========================================================================
   TRACK PLAYBACK
   ========================================================================== */

async function playTrackById(trackId) {
  const track =
    state.tracks.find(
      (item) => item.id === trackId
    );

  if (!track) {
    showBanner(
      "That track is no longer in the indexed library.",
      "warning",
      5000
    );

    return;
  }

  if (!state.directoryHandle) {
    showPermissionRequiredMessage();
    return;
  }

  /*
    Make sure the selected directory is still accessible.
  */
  try {
    const permission =
      await state.directoryHandle.queryPermission({
        mode: "read"
      });

    if (permission !== "granted") {
      showPermissionRequiredMessage();
      return;
    }
  } catch (error) {
    console.warn(
      "Could not verify folder permission:",
      error
    );

    showPermissionRequiredMessage();
    return;
  }

  const generation =
    ++state.loadGeneration;

  state.isChangingTrack = true;

  try {
    /*
      Stop the old track first.
    */
    stopProgressAnimation();

    audio.pause();

    revokeActiveObjectUrl();

    const file =
      await getFileFromCurrentDirectory(
        track
      );

    if (
      generation !== state.loadGeneration
    ) {
      return;
    }

    const url =
      URL.createObjectURL(file);

    state.objectUrl = url;

    audio.src = url;

    audio.loop =
      state.settings.repeatMode ===
      "single";

    state.currentTrackId =
      track.id;

    state.pendingResumePosition = 0;

    updateCurrentTrackIndex();
    updateCurrentTrackUI(track);

    /*
      Save selection immediately.
    */
    state.settings.lastTrackId =
      track.id;

    state.settings.lastPosition = 0;

    saveSettings();

    /*
      Load the actual audio source.
    */
    audio.load();

    /*
      Wait until enough information exists to begin playback.
      play() can still reject due to browser restrictions, so it
      is handled below.
    */
    await audio.play();

    if (
      generation !== state.loadGeneration
    ) {
      return;
    }

    updatePlaybackControls();
    startProgressAnimation();

  } catch (error) {
    console.error(
      `Could not play "${track.name}":`,
      error
    );

    revokeActiveObjectUrl();

    if (
      error?.name === "NotAllowedError"
    ) {
      /*
        Usually caused by browser autoplay restrictions.
      */
      showBanner(
        "Chrome blocked playback. Click Play to start the track.",
        "warning",
        5000
      );

    } else if (
      error?.name === "NotFoundError"
    ) {
      showBanner(
        "That file could not be found. Try rescanning the folder.",
        "error",
        6000
      );

    } else {
      showBanner(
        `Could not play "${track.name}".`,
        "error",
        5000
      );
    }

    playingContext.textContent =
      "Playback unavailable";

    updatePlaybackControls();

  } finally {
    state.isChangingTrack = false;
  }
}

async function togglePlayback() {
  if (!state.currentTrackId) {
    const firstTrack =
      getFirstPlayableTrack();

    if (!firstTrack) {
      showBanner(
        state.tracks.length
          ? "No tracks are enabled by the current file-type filters."
          : "Select a music folder first.",
        "warning",
        5000
      );

      return;
    }

    await playTrackById(
      firstTrack.id
    );

    return;
  }

  if (!audio.src) {
    await playTrackById(
      state.currentTrackId
    );

    return;
  }

  if (audio.paused) {
    try {
      await audio.play();

    } catch (error) {
      console.error(
        "Playback failed:",
        error
      );

      showBanner(
        "Playback could not be started.",
        "error",
        5000
      );
    }
  } else {
    audio.pause();
  }
}

function getFirstPlayableTrack() {
  if (!state.visibleTracks.length) {
    return null;
  }

  if (
    state.settings.shuffle &&
    state.shuffleOrder.length
  ) {
    return (
      state.tracks.find(
        (track) =>
          track.id ===
          state.shuffleOrder[0]
      ) ||
      state.visibleTracks[0]
    );
  }

  return state.visibleTracks[0];
}

/* ==========================================================================
   NEXT / PREVIOUS
   ========================================================================== */

async function nextTrack() {
  if (!state.visibleTracks.length) {
    return;
  }

  /*
    When shuffle is enabled, walk through the shuffled cycle.
  */
  if (state.settings.shuffle) {
    await nextShuffledTrack();
    return;
  }

  const currentIndex =
    state.visibleTracks.findIndex(
      (track) =>
        track.id ===
        state.currentTrackId
    );

  if (currentIndex === -1) {
    await playTrackById(
      state.visibleTracks[0].id
    );

    return;
  }

  const isLast =
    currentIndex >=
    state.visibleTracks.length - 1;

  if (isLast) {
    if (
      state.settings.repeatMode ===
      "all"
    ) {
      await playTrackById(
        state.visibleTracks[0].id
      );

    } else {
      /*
        Repeat Single never normally reaches this path because
        audio.loop handles it natively.
      */
      stopPlaybackAtEnd();
    }

    return;
  }

  await playTrackById(
    state.visibleTracks[currentIndex + 1].id
  );
}

async function previousTrack() {
  if (!state.visibleTracks.length) {
    return;
  }

  /*
    Standard music-player behavior:
    if more than three seconds into the current track, Previous
    restarts the current song instead of going back immediately.
  */
  if (
    audio.src &&
    audio.currentTime > 3
  ) {
    audio.currentTime = 0;

    return;
  }

  if (state.settings.shuffle) {
    await previousShuffledTrack();
    return;
  }

  const currentIndex =
    state.visibleTracks.findIndex(
      (track) =>
        track.id ===
        state.currentTrackId
    );

  if (currentIndex === -1) {
    await playTrackById(
      state.visibleTracks[0].id
    );

    return;
  }

  if (currentIndex === 0) {
    if (
      state.settings.repeatMode ===
      "all"
    ) {
      await playTrackById(
        state.visibleTracks[
          state.visibleTracks.length - 1
        ].id
      );
    } else {
      audio.currentTime = 0;
    }

    return;
  }

  await playTrackById(
    state.visibleTracks[currentIndex - 1].id
  );
}

/* ==========================================================================
   SHUFFLE
   ========================================================================== */

function toggleShuffle() {
  state.settings.shuffle =
    !state.settings.shuffle;

  saveSettings();

  if (state.settings.shuffle) {
    buildFreshShuffleCycle();
  } else {
    state.shuffleOrder = [];
    state.shufflePosition = -1;
  }

  updateShuffleUI();

  showBanner(
    state.settings.shuffle
      ? "Shuffle enabled."
      : "Shuffle disabled.",
    "ready",
    2200
  );
}

function buildFreshShuffleCycle(
  preserveCurrent = true
) {
  const ids =
    state.visibleTracks.map(
      (track) => track.id
    );

  if (!ids.length) {
    state.shuffleOrder = [];
    state.shufflePosition = -1;
    return;
  }

  const currentId =
    preserveCurrent
      ? state.currentTrackId
      : null;

  /*
    Fisher-Yates shuffle.
  */
  const shuffled = [
    ...ids
  ];

  for (
    let i = shuffled.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [
      shuffled[i],
      shuffled[j]
    ] = [
      shuffled[j],
      shuffled[i]
    ];
  }

  /*
    If a current track exists, place it at the beginning so that
    enabling shuffle doesn't unexpectedly change the currently
    playing song.
  */
  if (
    currentId &&
    shuffled.includes(currentId)
  ) {
    const index =
      shuffled.indexOf(currentId);

    shuffled.splice(index, 1);

    shuffled.unshift(currentId);

    state.shufflePosition = 0;
  } else {
    state.shufflePosition = -1;
  }

  state.shuffleOrder = shuffled;
}

function rebuildShuffleOrder(
  preserveCurrent = true
) {
  if (!state.settings.shuffle) {
    return;
  }

  const validIds =
    new Set(
      state.visibleTracks.map(
        (track) => track.id
      )
    );

  const oldOrder =
    state.shuffleOrder.filter(
      (id) => validIds.has(id)
    );

  const missingIds =
    state.visibleTracks
      .map((track) => track.id)
      .filter(
        (id) => !oldOrder.includes(id)
      );

  if (!oldOrder.length) {
    buildFreshShuffleCycle(
      preserveCurrent
    );

    return;
  }

  state.shuffleOrder = [
    ...oldOrder,
    ...shuffleArray(missingIds)
  ];

  state.shufflePosition =
    state.shuffleOrder.indexOf(
      state.currentTrackId
    );
}

function shuffleArray(array) {
  const result = [
    ...array
  ];

  for (
    let i = result.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [
      result[i],
      result[j]
    ] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

async function nextShuffledTrack() {
  if (!state.shuffleOrder.length) {
    buildFreshShuffleCycle(
      false
    );
  }

  if (!state.shuffleOrder.length) {
    return;
  }

  /*
    If current track isn't represented in the cycle yet, start
    immediately from the first track.
  */
  if (state.shufflePosition === -1) {
    state.shufflePosition = 0;

    await playTrackById(
      state.shuffleOrder[
        state.shufflePosition
      ]
    );

    return;
  }

  const nextPosition =
    state.shufflePosition + 1;

  if (
    nextPosition >=
    state.shuffleOrder.length
  ) {
    if (
      state.settings.repeatMode ===
      "all"
    ) {
      /*
        New cycle = randomized again.
      */
      buildFreshShuffleCycle(
        false
      );

      state.shufflePosition = 0;

      await playTrackById(
        state.shuffleOrder[0]
      );

    } else {
      stopPlaybackAtEnd();
    }

    return;
  }

  state.shufflePosition =
    nextPosition;

  await playTrackById(
    state.shuffleOrder[
      state.shufflePosition
    ]
  );
}

async function previousShuffledTrack() {
  if (!state.shuffleOrder.length) {
    buildFreshShuffleCycle();
  }

  if (
    state.shufflePosition <= 0
  ) {
    state.shufflePosition = 0;

    audio.currentTime = 0;

    return;
  }

  state.shufflePosition -= 1;

  await playTrackById(
    state.shuffleOrder[
      state.shufflePosition
    ]
  );
}

/* ==========================================================================
   REPEAT
   ========================================================================== */

function cycleRepeatMode() {
  const modes = [
    "off",
    "all",
    "single"
  ];

  const currentIndex =
    modes.indexOf(
      state.settings.repeatMode
    );

  const nextIndex =
    (currentIndex + 1) %
    modes.length;

  state.settings.repeatMode =
    modes[nextIndex];

  audio.loop =
    state.settings.repeatMode ===
    "single";

  saveSettings();

  updateRepeatUI();

  const labels = {
    off: "Repeat off.",
    all: "Repeat all enabled.",
    single: "Repeat single enabled."
  };

  showBanner(
    labels[state.settings.repeatMode],
    "ready",
    2200
  );
}

function updateRepeatUI() {
  const mode =
    state.settings.repeatMode;

  repeatButton.classList.toggle(
    "is-active",
    mode !== "off"
  );

  repeatButton.setAttribute(
    "aria-pressed",
    String(mode !== "off")
  );

  let label = "Repeat";

  if (mode === "all") {
    label = "Repeat All";
  }

  if (mode === "single") {
    label = "Repeat 1";
  }

  repeatLabel.textContent = label;

  repeatButton.title =
    `Repeat: ${label}`;

  repeatButton.setAttribute(
    "aria-label",
    `Repeat: ${label}`
  );

  if (mode === "single") {
    repeatIcon.innerHTML = `
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
      <text
        x="12"
        y="15"
        text-anchor="middle"
        font-size="7"
        font-weight="700"
        fill="currentColor"
        stroke="none"
      >1</text>
    `;
  } else {
    repeatIcon.innerHTML = `
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    `;
  }
}

/* ==========================================================================
   AUDIO EVENTS
   ========================================================================== */

function handleAudioLoadedMetadata() {
  const duration =
    Number.isFinite(audio.duration)
      ? audio.duration
      : 0;

  progressTrack.setAttribute(
    "aria-valuemax",
    String(Math.round(duration))
  );

  progressTrack.setAttribute(
    "aria-valuenow",
    String(
      Math.round(
        Number.isFinite(audio.currentTime)
          ? audio.currentTime
          : 0
      )
    )
  );

  /*
    Restore the previous playback position when appropriate.
  */
  if (
    state.pendingResumePosition > 0 &&
    state.pendingResumePosition <
      duration
  ) {
    try {
      audio.currentTime =
        state.pendingResumePosition;
    } catch {
      // Ignore browsers that reject the initial seek.
    }
  }

  state.pendingResumePosition = 0;

  updateProgressUI();
}

function handleAudioCanPlay() {
  /*
    This doesn't automatically call play.
    The user remains in control.
  */
  playingContext.textContent =
    audio.paused
      ? "Ready to play"
      : "Now playing";

  updatePlaybackControls();
}

function handleAudioTimeUpdate() {
  updateProgressUI();

  schedulePlaybackStateSave();
}

function handleAudioPlay() {
  albumArt.classList.add(
    "is-playing"
  );

  playingContext.textContent =
    "Now playing";

  updatePlaybackControls();

  startProgressAnimation();
}

function handleAudioPause() {
  albumArt.classList.remove(
    "is-playing"
  );

  if (audio.currentTime > 0) {
    playingContext.textContent =
      "Paused";
  } else {
    playingContext.textContent =
      "Ready to play";
  }

  updatePlaybackControls();

  stopProgressAnimation();

  schedulePlaybackStateSave();
}

async function handleAudioEnded() {
  stopProgressAnimation();

  /*
    Repeat Single uses audio.loop, so browsers normally do not emit
    ended for each loop. This branch is kept as a defensive fallback.
  */
  if (
    state.settings.repeatMode ===
    "single"
  ) {
    try {
      audio.currentTime = 0;
      await audio.play();
    } catch (error) {
      console.warn(
        "Repeat-single restart failed:",
        error
      );
    }

    return;
  }

  await nextTrack();
}

function handleAudioError() {
  if (
    state.isChangingTrack
  ) {
    return;
  }

  const mediaError =
    audio.error;

  console.error(
    "Audio playback error:",
    mediaError
  );

  showBanner(
    "This audio file could not be played by Chrome.",
    "error",
    6000
  );

  playingContext.textContent =
    "Playback error";

  updatePlaybackControls();
}

function handleAudioVolumeChange() {
  /*
    We don't trust the slider alone because mute can be triggered
    programmatically as well.
  */
  state.settings.muted =
    Boolean(audio.muted);

  if (!audio.muted) {
    state.settings.volume =
      clamp(
        audio.volume,
        0,
        1
      );
  }

  updateVolumeUI();
}

/* ==========================================================================
   PLAYBACK PROGRESS
   ========================================================================== */

function updateProgressUI() {
  const duration =
    Number.isFinite(audio.duration)
      ? audio.duration
      : 0;

  const current =
    Number.isFinite(audio.currentTime)
      ? audio.currentTime
      : 0;

  const percentage =
    duration > 0
      ? clamp(
          (current / duration) * 100,
          0,
          100
        )
      : 0;

  progressFill.style.width =
    `${percentage}%`;

  currentTimeElement.textContent =
    formatTime(current);

  const remaining =
    Math.max(
      0,
      duration - current
    );

  remainingTimeElement.textContent =
    `-${formatTime(remaining)}`;

  progressTrack.setAttribute(
    "aria-valuemax",
    String(Math.round(duration))
  );

  progressTrack.setAttribute(
    "aria-valuenow",
    String(Math.round(current))
  );

  progressTrack.setAttribute(
    "aria-valuetext",
    `${formatTime(current)} of ${formatTime(duration)}`
  );
}

function handleProgressClick(event) {
  if (
    !Number.isFinite(audio.duration) ||
    audio.duration <= 0
  ) {
    return;
  }

  const rect =
    progressTrack.getBoundingClientRect();

  const relativeX =
    clamp(
      event.clientX - rect.left,
      0,
      rect.width
    );

  const percentage =
    rect.width > 0
      ? relativeX / rect.width
      : 0;

  audio.currentTime =
    audio.duration * percentage;

  updateProgressUI();
}

function handleProgressKeyboard(event) {
  if (
    !Number.isFinite(audio.duration) ||
    audio.duration <= 0
  ) {
    return;
  }

  const step = 5;

  switch (event.key) {
    case "ArrowRight":
      event.preventDefault();

      audio.currentTime =
        Math.min(
          audio.duration,
          audio.currentTime + step
        );

      break;

    case "ArrowLeft":
      event.preventDefault();

      audio.currentTime =
        Math.max(
          0,
          audio.currentTime - step
        );

      break;

    case "Home":
      event.preventDefault();

      audio.currentTime = 0;

      break;

    case "End":
      event.preventDefault();

      audio.currentTime =
        audio.duration;

      break;

    default:
      return;
  }

  updateProgressUI();
}

/* ==========================================================================
   SMOOTH PROGRESS ANIMATION
   ========================================================================== */

function startProgressAnimation() {
  stopProgressAnimation();

  const animate = () => {
    if (
      audio.paused ||
      audio.ended
    ) {
      state.progressAnimationFrame =
        null;

      return;
    }

    updateProgressUI();

    state.progressAnimationFrame =
      requestAnimationFrame(
        animate
      );
  };

  state.progressAnimationFrame =
    requestAnimationFrame(
      animate
    );
}

function stopProgressAnimation() {
  if (
    state.progressAnimationFrame !== null
  ) {
    cancelAnimationFrame(
      state.progressAnimationFrame
    );

    state.progressAnimationFrame =
      null;
  }
}

/* ==========================================================================
   PLAYBACK UI
   ========================================================================== */

function updatePlaybackControls() {
  const isPlaying =
    !audio.paused &&
    !audio.ended &&
    Boolean(audio.src);

  playIcon.classList.toggle(
    "hidden",
    isPlaying
  );

  pauseIcon.classList.toggle(
    "hidden",
    !isPlaying
  );

  playPauseButton.setAttribute(
    "aria-label",
    isPlaying
      ? "Pause"
      : "Play"
  );

  playPauseButton.title =
    isPlaying
      ? "Pause"
      : "Play";

  /*
    Disable transport buttons when there is no playlist.
  */
  const hasTracks =
    state.visibleTracks.length > 0;

  previousButton.disabled =
    !hasTracks;

  nextButton.disabled =
    !hasTracks;

  previousButton.style.opacity =
    hasTracks ? "" : "0.4";

  nextButton.style.opacity =
    hasTracks ? "" : "0.4";
}

/* ==========================================================================
   VOLUME
   ========================================================================== */

function setVolumeFromSettings() {
  const volume =
    clamp(
      Number(state.settings.volume),
      0,
      1
    );

  state.settings.volume =
    Number.isFinite(volume)
      ? volume
      : DEFAULT_SETTINGS.volume;

  audio.volume =
    state.settings.volume;

  audio.muted =
    Boolean(state.settings.muted);

  volumeSlider.value =
    String(state.settings.volume);

  updateVolumeUI();
}

function handleVolumeInput() {
  const volume =
    clamp(
      Number(volumeSlider.value),
      0,
      1
    );

  audio.volume = volume;

  /*
    Changing the slider from 0 implicitly un-mutes the player.
  */
  if (volume > 0) {
    audio.muted = false;

    state.settings.muted =
      false;
  }

  state.settings.volume =
    volume;

  saveSettings();

  updateVolumeUI();
}

function toggleMute() {
  if (audio.muted) {
    /*
      Restore a sensible previous volume.
    */
    const restoredVolume =
      state.settings.volume > 0
        ? state.settings.volume
        : DEFAULT_SETTINGS.volume;

    audio.volume =
      restoredVolume;

    audio.muted = false;

    state.settings.volume =
      restoredVolume;

    state.settings.muted =
      false;

  } else {
    audio.muted = true;

    state.settings.muted =
      true;
  }

  saveSettings();

  updateVolumeUI();
}

function updateVolumeUI() {
  const muted =
    audio.muted ||
    audio.volume <= 0;

  volumeHighIcon.classList.toggle(
    "hidden",
    muted
  );

  volumeMutedIcon.classList.toggle(
    "hidden",
    !muted
  );

  volumeButton.setAttribute(
    "aria-label",
    muted
      ? "Unmute"
      : "Mute"
  );

  volumeButton.title =
    muted
      ? "Unmute"
      : "Mute";

  volumeSlider.value =
    String(
      clamp(
        Number(audio.volume),
        0,
        1
      )
    );

  const percentage =
    clamp(
      Number(audio.volume) * 100,
      0,
      100
    );

  volumeSlider.style.setProperty(
    "--volume-progress",
    `${percentage}%`
  );
}

/* ==========================================================================
   SHUFFLE UI
   ========================================================================== */

function updateShuffleUI() {
  const active =
    Boolean(state.settings.shuffle);

  shuffleButton.classList.toggle(
    "is-active",
    active
  );

  shuffleButton.setAttribute(
    "aria-pressed",
    String(active)
  );

  shuffleButton.setAttribute(
    "aria-label",
    active
      ? "Shuffle on"
      : "Shuffle off"
  );

  shuffleButton.title =
    active
      ? "Shuffle: On"
      : "Shuffle: Off";
}

/* ==========================================================================
   EXTENSION FILTERS
   ========================================================================== */

function handleExtensionFilterChange(
  event
) {
  const extension =
    event.target.value;

  if (
    !SUPPORTED_EXTENSIONS.has(
      extension
    )
  ) {
    return;
  }

  state.settings.extensions[
    extension
  ] = Boolean(
    event.target.checked
  );

  saveSettings();

  applyCurrentFilterAndRender();

  const visible =
    state.visibleTracks.length;

  if (!visible) {
    setStatus(
      "No visible tracks",
      "Enable at least one file type or select a different folder.",
      "warning"
    );
  } else {
    setStatus(
      "Ready",
      `${formatNumber(visible)} songs available in the playlist.`,
      "ready"
    );
  }
}

/* ==========================================================================
   PANEL COLLAPSING
   ========================================================================== */

function toggleLeftPanel() {
  state.settings.leftCollapsed =
    !state.settings.leftCollapsed;

  saveSettings();

  updatePanelUI();
}

function toggleRightPanel() {
  state.settings.rightCollapsed =
    !state.settings.rightCollapsed;

  saveSettings();

  updatePanelUI();
}

function updatePanelUI() {
  app.classList.toggle(
    "left-collapsed",
    Boolean(
      state.settings.leftCollapsed
    )
  );

  app.classList.toggle(
    "right-collapsed",
    Boolean(
      state.settings.rightCollapsed
    )
  );

  if (
    state.settings.leftCollapsed
  ) {
    leftPanelToggleIcon.innerHTML = `
      <path d="m9 18 6-6-6-6" />
    `;

    toggleLeftPanelButton.setAttribute(
      "aria-label",
      "Expand playlist"
    );

    toggleLeftPanelButton.title =
      "Expand playlist";

    /*
      When collapsed the chevron is hidden, so the brand mark is the
      visible expand control. Keep its accessible name in sync.
    */
    brandMarkToggle.setAttribute(
      "aria-label",
      "Expand playlist"
    );

    brandMarkToggle.title =
      "Expand playlist";
  } else {
    leftPanelToggleIcon.innerHTML = `
      <path d="m15 18-6-6 6-6" />
    `;

    toggleLeftPanelButton.setAttribute(
      "aria-label",
      "Collapse playlist"
    );

    toggleLeftPanelButton.title =
      "Collapse playlist";

    brandMarkToggle.setAttribute(
      "aria-label",
      "Collapse playlist"
    );

    brandMarkToggle.title =
      "Collapse playlist";
  }

  if (
    state.settings.rightCollapsed
  ) {
    rightPanelToggleIcon.innerHTML = `
      <path d="m15 18-6-6 6-6" />
    `;

    toggleRightPanelButton.setAttribute(
      "aria-label",
      "Expand settings"
    );

    toggleRightPanelButton.title =
      "Expand settings";
  } else {
    rightPanelToggleIcon.innerHTML = `
      <path d="m9 18 6-6-6-6" />
    `;

    toggleRightPanelButton.setAttribute(
      "aria-label",
      "Collapse settings"
    );

    toggleRightPanelButton.title =
      "Collapse settings";
  }
}

/* ==========================================================================
   SETTINGS RESET
   ========================================================================== */

async function resetAppSettings() {
  const confirmed =
    window.confirm(
      "Reset your player settings?\n\n" +
      "This will restore volume, shuffle, repeat, panel layout, " +
      "file-type filters and last-track preferences to their defaults.\n\n" +
      "Your indexed music library will not be deleted."
    );

  if (!confirmed) {
    return;
  }

  state.settings =
    structuredClone(DEFAULT_SETTINGS);

  saveSettings();

  /*
    Reset audio state.
  */
  audio.pause();

  audio.currentTime = 0;

  audio.muted = false;

  audio.volume =
    DEFAULT_SETTINGS.volume;

  state.pendingResumePosition = 0;

  /*
    Reset playback mode.
  */
  state.settings.shuffle = false;

  state.settings.repeatMode = "off";

  audio.loop = false;

  state.shuffleOrder = [];
  state.shufflePosition = -1;

  /*
    Reset track memory.
  */
  state.settings.lastTrackId = null;
  state.settings.lastPosition = 0;

  state.currentTrackId = null;
  state.currentTrackIndex = -1;

  revokeActiveObjectUrl();

  /*
    Apply UI.
  */
  applySettingsToUI();

  setVolumeFromSettings();
  updateShuffleUI();
  updateRepeatUI();
  updatePanelUI();

  updatePlaybackControls();

  resetNowPlayingUI();

  renderPlaylist();

  showBanner(
    "Player settings have been reset.",
    "ready",
    3500
  );
}

function applySettingsToUI() {
  /*
    Extension checkboxes.
  */
  const inputs =
    document.querySelectorAll(
      'input[name="extension"]'
    );

  inputs.forEach((input) => {
    input.checked =
      Boolean(
        state.settings.extensions[
          input.value
        ]
      );
  });

  volumeSlider.value =
    String(
      clamp(
        Number(state.settings.volume),
        0,
        1
      )
    );
}

/* ==========================================================================
   FOLDER BUTTON STATES
   ========================================================================== */

function updateFolderButtonState(
  mode
) {
  if (!selectMusicFolderButton) {
    return;
  }

  const iconMarkup = `
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" />
      <path d="M12 11v5" />
      <path d="m10 13 2-2 2 2" />
    </svg>
  `;

  const scanIconMarkup = `
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v6h-6" />
    </svg>
  `;

  const spinnerMarkup = `
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      aria-hidden="true"
      style="animation: offlineMusicSpin 0.9s linear infinite;"
    >
      <path d="M12 2v4" />
      <path d="m16.24 3.76-2.12 2.12" />
      <path d="M22 12h-4" />
      <path d="m20.24 16.24-2.12-2.12" />
      <path d="M12 22v-4" />
      <path d="m7.76 20.24 2.12-2.12" />
      <path d="M2 12h4" />
      <path d="m3.76 7.76 2.12 2.12" />
    </svg>
  `;

  /*
    Inject the spinner animation once.
  */
  if (
    !document.getElementById(
      "offlineMusicSpinStyle"
    )
  ) {
    const style =
      document.createElement("style");

    style.id =
      "offlineMusicSpinStyle";

    style.textContent = `
      @keyframes offlineMusicSpin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;

    document.head.appendChild(style);
  }

  switch (mode) {
    case "reconnect":
      selectMusicFolderButton.innerHTML = `
        ${iconMarkup}
        <span>Reconnect Music Folder</span>
      `;
      selectMusicFolderButton.disabled = false;
      break;

    case "rescan":
      selectMusicFolderButton.innerHTML = `
        ${scanIconMarkup}
        <span>Rescan Music Folder</span>
      `;
      selectMusicFolderButton.disabled = false;
      break;

    case "scanning":
      selectMusicFolderButton.innerHTML = `
        ${spinnerMarkup}
        <span>Scanning Music Folder…</span>
      `;
      selectMusicFolderButton.disabled = true;
      break;

    case "select":
    default:
      selectMusicFolderButton.innerHTML = `
        ${iconMarkup}
        <span>Select Music Folder</span>
      `;
      selectMusicFolderButton.disabled = false;
      break;
  }
}

/* ==========================================================================
   STATUS UI
   ========================================================================== */

/*
  The "Library Status" card was removed from the UI, so setStatus() is now a
  no-op. It is kept as a function (with the same signature) so all existing
  call sites remain valid. Every important status (errors, permission
  prompts, scan summaries) is surfaced to the user via showBanner(), so no
  meaningful feedback is lost.
*/
function setStatus(
  title,
  message,
  type = "ready"
) {
  void title;
  void message;
  void type;
}

function showBanner(
  message,
  type = "ready",
  duration = 3500
) {
  clearTimeout(
    state.bannerTimer
  );

  systemBannerText.textContent =
    message;

  systemBanner.classList.remove(
    "is-warning",
    "is-error"
  );

  if (type === "warning") {
    systemBanner.classList.add(
      "is-warning"
    );
  }

  if (type === "error") {
    systemBanner.classList.add(
      "is-error"
    );
  }

  systemBanner.classList.add(
    "is-visible"
  );

  state.bannerTimer =
    setTimeout(() => {
      systemBanner.classList.remove(
        "is-visible"
      );
    }, duration);
}

/* ==========================================================================
   CONNECTIVITY / OFFLINE STATUS
   ========================================================================== */

function updateConnectivityBanner() {
  /*
    Offline is expected and completely valid once assets are cached.
  */
  if (!navigator.onLine) {
    showBanner(
      "Offline mode — your music library remains available locally.",
      "ready",
      5000
    );

    return;
  }

  /*
    Don't show a permanent "online" message; it would just add noise.
  */
}

/* ==========================================================================
   FILE SYSTEM API SUPPORT
   ========================================================================== */

function showUnsupportedFileSystemMessage() {
  if (
    !window.isSecureContext
  ) {
    showBanner(
      "Folder access requires a secure PWA/HTTPS context. Open the installed app or use HTTPS.",
      "error",
      7000
    );

    setStatus(
      "Secure context required",
      "Chrome's File System Access API is unavailable here.",
      "error"
    );

    return;
  }

  if (
    !("showDirectoryPicker" in window)
  ) {
    showBanner(
      "This browser does not support the File System Access API.",
      "error",
      7000
    );

    setStatus(
      "Unsupported browser",
      "Use a current Chromium-based browser such as Chrome.",
      "error"
    );
  }
}

function showPermissionRequiredMessage() {
  updateFolderButtonState(
    "reconnect"
  );

  showBanner(
    "Folder permission is required. Click “Reconnect Music Folder” to grant access.",
    "warning",
    7000
  );

  setStatus(
    "Permission required",
    "Your library is saved, but Chrome needs permission to access the music folder.",
    "warning"
  );
}

/* ==========================================================================
   PWA SERVICE WORKER
   ========================================================================== */

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    console.warn(
      "Service Worker API is unavailable."
    );

    return;
  }

  if (!window.isSecureContext) {
    console.warn(
      "Service workers require HTTPS or localhost."
    );

    return;
  }

  try {
    const registration =
      await navigator.serviceWorker.register(
        "./sw.js",
        {
          scope: "./"
        }
      );

    console.info(
      "Service worker registered:",
      registration.scope
    );

    /*
      Ask the browser to keep this origin's storage (including the service
      worker cache) persistent. On Chromebooks Chrome may otherwise evict the
      cache under storage pressure, which would force a reload from the
      network. This makes the offline copy stick across restarts.
    */
    await requestPersistentStorage();

    /*
      Confirm to the user when the app is ready to launch offline. On the
      very first visit the worker controls the page only after a reload, so
      we let them know the offline copy will be available next time.
    */
    if (navigator.serviceWorker.controller) {
      showBanner(
        "Offline copy is ready. You can now open this app without internet.",
        "ready",
        5000
      );
    } else {
      showBanner(
        "Setting up offline access. Reload once more to finish, then it will open without internet.",
        "ready",
        7000
      );
    }

    /*
      When the service worker has an update, let it take control after
      reload rather than unexpectedly refreshing the app mid-session.
    */
    registration.addEventListener(
      "updatefound",
      () => {
        const newWorker =
          registration.installing;

        if (!newWorker) {
          return;
        }

        newWorker.addEventListener(
          "statechange",
          () => {
            if (
              newWorker.state ===
              "installed" &&
              navigator.serviceWorker.controller
            ) {
              showBanner(
                "A new version of Moozie Player is available. Reload to update.",
                "ready",
                7000
              );
            }
          }
        );
      }
    );

  } catch (error) {
    /*
      The player itself still works even if service-worker registration
      fails; only offline asset caching is affected.
    */
    console.warn(
      "Service worker registration failed:",
      error
    );

    showBanner(
      "Offline caching could not be initialized. The player can still run for this session.",
      "warning",
      6000
    );
  }
}

/*
  Request persistent storage so the service worker cache (and thus the
  offline app shell) is not evicted by the browser under storage pressure.
  This is especially important on Chromebooks. Best-effort: if the API is
  missing or the grant is denied, the app still works — it just becomes
  eligible for automatic eviction again.
*/
async function requestPersistentStorage() {
  if (
    !navigator.storage ||
    typeof navigator.storage.persist !== "function"
  ) {
    return;
  }

  try {
    const alreadyPersisted =
      await navigator.storage.persisted();

    if (alreadyPersisted) {
      return;
    }

    const granted =
      await navigator.storage.persist();

    console.info(
      "Persistent storage granted:",
      granted
    );
  } catch (error) {
    console.warn(
      "Could not request persistent storage:",
      error
    );
  }
}

/* ==========================================================================
   PLAYBACK STATE PERSISTENCE
   ========================================================================== */

function schedulePlaybackStateSave() {
  if (
    state.savePositionTimer
  ) {
    return;
  }

  state.savePositionTimer =
    setTimeout(() => {
      state.savePositionTimer =
        null;

      savePlaybackStateImmediately();
    }, 1200);
}

function savePlaybackStateImmediately() {
  if (state.currentTrackId) {
    state.settings.lastTrackId =
      state.currentTrackId;

    state.settings.lastPosition =
      Number.isFinite(
        audio.currentTime
      )
        ? audio.currentTime
        : 0;
  } else {
    state.settings.lastTrackId = null;
    state.settings.lastPosition = 0;
  }

  saveSettings();
}

function stopPlaybackAtEnd() {
  audio.pause();

  /*
    Leave the progress at the end of the track.
  */
  updatePlaybackControls();
  updateProgressUI();
}

/* ==========================================================================
   TRACK META HELPERS
   ========================================================================== */

function getFileExtension(filename) {
  const normalized =
    String(filename || "")
      .trim()
      .toLowerCase();

  const dotIndex =
    normalized.lastIndexOf(".");

  if (
    dotIndex === -1 ||
    dotIndex === normalized.length - 1
  ) {
    return "";
  }

  return normalized.slice(
    dotIndex + 1
  );
}

/**
 * Attempts a light-weight filename metadata extraction.
 *
 * Since this version is intentionally dependency-free, we don't pull in
 * an ID3 / MP4 metadata library. Formats whose metadata isn't available
 * through standard browser media APIs therefore fall back gracefully
 * to the filename.
 *
 * Examples:
 *   "Wizkid - Essence.mp3"
 *   -> artist: Wizkid
 *   -> title: Essence
 */
function parseTrackName(filename) {
  const base =
    removeExtension(filename)
      .trim();

  const separatorPatterns = [
    " - ",
    " – ",
    " — "
  ];

  for (
    const separator
    of separatorPatterns
  ) {
    if (
      base.includes(separator)
    ) {
      const pieces =
        base.split(separator);

      if (pieces.length >= 2) {
        return pieces
          .slice(1)
          .join(separator)
          .trim() || base;
      }
    }
  }

  return base;
}

function parseArtist(filename) {
  const base =
    removeExtension(filename)
      .trim();

  const separatorPatterns = [
    " - ",
    " – ",
    " — "
  ];

  for (
    const separator
    of separatorPatterns
  ) {
    if (
      base.includes(separator)
    ) {
      const pieces =
        base.split(separator);

      if (
        pieces.length >= 2 &&
        pieces[0].trim()
      ) {
        return pieces[0].trim();
      }
    }
  }

  return "Local file";
}

function removeExtension(filename) {
  const extension =
    getFileExtension(filename);

  if (!extension) {
    return filename;
  }

  return filename.slice(
    0,
    -(extension.length + 1)
  );
}

function normalizePath(path) {
  return String(path || "")
    .replaceAll("\\", "/")
    .replace(
      /^\/+/,
      ""
    );
}

/* ==========================================================================
   CURRENT TRACK LOOKUP / ARRAY HELPERS
   ========================================================================== */

function ensureCurrentTrackId() {
  if (state.currentTrackId) {
    return state.currentTrackId;
  }

  return (
    state.visibleTracks[0]?.id ||
    null
  );
}

/* ==========================================================================
   OBJECT URL CLEANUP
   ========================================================================== */

function revokeActiveObjectUrl() {
  if (!state.objectUrl) {
    return;
  }

  URL.revokeObjectURL(
    state.objectUrl
  );

  state.objectUrl = null;
}

/* ==========================================================================
   KEYBOARD SHORTCUTS
   ========================================================================== */

function handleGlobalKeyboard(event) {
  /*
    Never hijack keyboard shortcuts while the user is interacting
    with a form/input.
  */
  const target =
    event.target;

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  ) {
    return;
  }

  /*
    Space — Play / Pause
  */
  if (
    event.code === "Space"
  ) {
    /*
      Don't steal Space when a button has focus.
    */
    if (
      target instanceof HTMLButtonElement
    ) {
      return;
    }

    event.preventDefault();

    togglePlayback();

    return;
  }

  /*
    Arrow keys — seek while not focused on the progress control.
  */
  if (
    event.key === "ArrowLeft"
  ) {
    if (
      Number.isFinite(
        audio.duration
      )
    ) {
      event.preventDefault();

      audio.currentTime =
        Math.max(
          0,
          audio.currentTime - 5
        );
    }

    return;
  }

  if (
    event.key === "ArrowRight"
  ) {
    if (
      Number.isFinite(
        audio.duration
      )
    ) {
      event.preventDefault();

      audio.currentTime =
        Math.min(
          audio.duration,
          audio.currentTime + 5
        );
    }

    return;
  }

  /*
    M — Mute
  */
  if (
    event.key.toLowerCase() === "m"
  ) {
    toggleMute();

    return;
  }

  /*
    N — Next
  */
  if (
    event.key.toLowerCase() === "n"
  ) {
    nextTrack();

    return;
  }

  /*
    P — Previous
  */
  if (
    event.key.toLowerCase() === "p"
  ) {
    previousTrack();
  }
}

/* ==========================================================================
   MISC HELPERS
   ========================================================================== */

function cssEscape(value) {
  /*
    CSS.escape() exists in modern Chrome. This fallback prevents a
    malformed track path from breaking playlist highlighting.
  */
  if (
    window.CSS &&
    typeof window.CSS.escape ===
      "function"
  ) {
    return window.CSS.escape(
      value
    );
  }

  return String(value)
    .replace(
      /([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g,
      "\\$1"
    );
}

function formatTime(seconds) {
  if (
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "0:00";
  }

  const totalSeconds =
    Math.floor(seconds);

  const hours =
    Math.floor(
      totalSeconds / 3600
    );

  const minutes =
    Math.floor(
      (totalSeconds % 3600) / 60
    );

  const remainingSeconds =
    totalSeconds % 60;

  if (hours > 0) {
    return [
      hours,
      String(minutes).padStart(2, "0"),
      String(remainingSeconds).padStart(
        2,
        "0"
      )
    ].join(":");
  }

  return [
    minutes,
    String(
      remainingSeconds
    ).padStart(2, "0")
  ].join(":");
}

function formatNumber(number) {
  return new Intl.NumberFormat().format(
    Number(number) || 0
  );
}

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.min(
    maximum,
    Math.max(
      minimum,
      Number(value)
    )
  );
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    setTimeout(
      resolve,
      0
    );
  });
}

/* ==========================================================================
   CLEANUP
   ========================================================================== */

window.addEventListener(
  "pagehide",
  () => {
    stopProgressAnimation();

    revokeActiveObjectUrl();

    savePlaybackStateImmediately();
  }
);