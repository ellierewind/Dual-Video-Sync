(() => {
// Global variables
let video1 = document.getElementById('video1');
let video2 = document.getElementById('video2');
let syncPoint1 = null;
let syncPoint2 = null;
let isSynced = false;
let delay = 0;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let isResizing = false;
let resizeState = { startX: 0, startY: 0, startW: 0, startH: 0, startLeft: 0, startTop: 0, handle: '' };
let subtitles1 = [];
let subtitles2 = [];
let subtitlesEnabled1 = true;
let subtitlesEnabled2 = true;
let subtitleFontScale1 = 1;
let subtitleFontScale2 = 1;
let lastSubtitlePath1 = null;
let lastSubtitlePath2 = null;
let externalAssSubtitle1 = null;
let externalAssSubtitle2 = null;
let vobSubTrack1 = null;
let vobSubTrack2 = null;
let vobSubTracks1 = [];
let vobSubTracks2 = [];
let vobSubRenderer1 = null;
let vobSubRenderer2 = null;
let vobSubLoadGeneration1 = 0;
let vobSubLoadGeneration2 = 0;
let audioTrack1 = null;
let audioTrack2 = null;
let audioTracks1 = [];
let audioTracks2 = [];
let dynamicAudioPlayer1 = null;
let dynamicAudioPlayer2 = null;
const SUBTITLE_FONT_SCALE_STEP = 0.1;
const SUBTITLE_FONT_SCALE_MIN = 0.1;
const DEFAULT_FRAME_RATE = 30;
const FRAME_STEP_HOLD_START_DELAY_MS = 350;
const FRAME_STEP_SEEK_TIMEOUT_MS = 900;
let frameRate1 = DEFAULT_FRAME_RATE;
let frameRate2 = DEFAULT_FRAME_RATE;
// Global playback rate that persists across loads
let globalPlaybackRate = 1;
// Track which video is controlled by keyboard shortcuts (1 or 2)
let activeVideo = 1;
const electronAPI = (typeof window !== 'undefined' && window.electronAPI) ? window.electronAPI : null;
const VIDEO_PLAYER_IDS = {
    video1: 'video1',
    video2: 'video2'
};
let lastVideoPath1 = null;
let lastVideoPath2 = null;
let electronZoomFactor = 1;
const WINDOW_ROLES = {
    main: 'main',
    player2: 'player2'
};
const PLAYER2_MODES = {
    overlay: 'overlay',
    window: 'window'
};
let windowRole = WINDOW_ROLES.main;
let player2Mode = PLAYER2_MODES.overlay;
let player2WindowOpen = false;
let player2Ready = false;
let pendingPlayer2Hydration = false;
let suppressPlayer2StateBroadcast = false;
let remotePlayer2State = createEmptyPlayer2State();
let frameStepHoldDirection = 0;
let frameStepHoldRunning = false;
let frameStepHoldStartTimer = null;
let remoteFrameStepHoldDirection = 0;
let remoteFrameStepHoldStartTimer = null;
let remoteFrameStepHoldRunning = false;
let remotePlayer2SeekCommandId = 0;
const remotePlayer2SeekWaiters = new Map();
let remotePlayer2StateRequestId = 0;
const remotePlayer2StateWaiters = new Map();
const frameStepHeldKeys = {
    comma: false,
    period: false
};
const HISTORY_LIMIT = 50;
let undoStack = [];
let redoStack = [];
let revealPlayerControls = () => { };

// ===== Persistence (localStorage) =====
const LS_KEYS = {
    rate: 'dvs:rate',
    overlayGeom: 'dvs:overlay:geom',
    video1Tf: 'dvs:video1:tf',
    video2Tf: 'dvs:video2:tf',
    subtitleFontScale1: 'dvs:subtitle1:fontScale',
    subtitleFontScale2: 'dvs:subtitle2:fontScale',
    vobSubChoice1: 'dvs:vobsub1:choice',
    vobSubChoice2: 'dvs:vobsub2:choice',
    audioChoice1: 'dvs:audio1:choice',
    audioChoice2: 'dvs:audio2:choice',
    profiles: 'dvs:profiles'
};
const ELECTRON_SESSION_SAVE_DELAY_MS = 700;
let electronSessionSaveTimer = null;

function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch { }
}

function hasVideoSource(video, fallbackPath) {
    return !!((video && (video.currentSrc || video.src)) || fallbackPath);
}

function readPlayerTimeOrNull(video, fallbackPath) {
    if (!hasVideoSource(video, fallbackPath)) return null;
    return Number.isFinite(video?.currentTime) ? video.currentTime : 0;
}

function buildElectronPlaybackSession() {
    if (!electronAPI || !isMainWindow()) return null;

    const player2HasSource = isElectronWindowMode()
        ? !!(remotePlayer2State.src || lastVideoPath2)
        : hasVideoSource(video2, lastVideoPath2);

    return {
        video1Time: readPlayerTimeOrNull(video1, lastVideoPath1),
        video2Time: player2HasSource ? getPlayer2Time() : null,
        syncPoint1: Number.isFinite(syncPoint1) ? syncPoint1 : null,
        syncPoint2: Number.isFinite(syncPoint2) ? syncPoint2 : null,
        isSynced: !!isSynced,
        delay: Number.isFinite(delay) ? delay : 0,
        updatedAt: Date.now()
    };
}

async function persistElectronPlaybackSessionNow() {
    if (!electronAPI || !isMainWindow()) return;
    if (electronSessionSaveTimer) {
        clearTimeout(electronSessionSaveTimer);
        electronSessionSaveTimer = null;
    }
    const session = buildElectronPlaybackSession();
    if (!session) return;
    try {
        await electronAPI.setPlaybackSession(session);
    } catch {
        // no-op: app still works without session persistence
    }
}

function schedulePersistElectronPlaybackSession(delayMs) {
    if (!electronAPI || !isMainWindow()) return;
    if (electronSessionSaveTimer) clearTimeout(electronSessionSaveTimer);
    electronSessionSaveTimer = window.setTimeout(() => {
        electronSessionSaveTimer = null;
        persistElectronPlaybackSessionNow();
    }, Number.isFinite(delayMs) ? delayMs : ELECTRON_SESSION_SAVE_DELAY_MS);
}

function waitForVideoMetadata(video, timeoutMs = 1500) {
    if (!video) return Promise.resolve();
    if (video.readyState >= 1) return Promise.resolve();

    return new Promise((resolve) => {
        let finished = false;
        const done = () => {
            if (finished) return;
            finished = true;
            resolve();
        };
        video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, timeoutMs);
    });
}

async function restoreVideoTimestamp(video, time) {
    if (!video || !Number.isFinite(time) || !hasVideoSource(video)) return;
    await waitForVideoMetadata(video);
    try { video.currentTime = Math.max(0, time); } catch { }
}

async function restoreElectronPlaybackSession() {
    if (!electronAPI || !isMainWindow()) return;

    try {
        const session = await electronAPI.getPlaybackSession();
        if (!session || typeof session !== 'object') return;

        applySyncMeta({
            syncPoint1: session.syncPoint1,
            syncPoint2: session.syncPoint2,
            isSynced: session.isSynced,
            delay: session.delay
        });

        await restoreVideoTimestamp(video1, session.video1Time);

        if (isElectronWindowMode()) {
            remotePlayer2State = mergeRemotePlayer2State({
                currentTime: Number.isFinite(session.video2Time) ? session.video2Time : 0,
                paused: true,
                updatedAt: Date.now()
            });
            pendingPlayer2Hydration = true;
            if (player2WindowOpen) sendHydrateToPlayer2Window();
        } else {
            await restoreVideoTimestamp(video2, session.video2Time);
        }
    } catch {
        // no-op: app still works without restoring prior session
    }
}

function createEmptyPlayer2State() {
    return {
        src: '',
        filePath: null,
        currentTime: 0,
        duration: 0,
        paused: true,
        volume: 1,
        muted: false,
        playbackRate: 1,
        updatedAt: Date.now(),
        subtitles: [],
        subtitlePath: null,
        externalAssSubtitle: null,
        subtitlesEnabled: true,
        subtitleFontScale: 1,
        vobSubTrack: null,
        vobSubTracks: [],
        audioTrack: null,
        audioTracks: [],
        frameRate: DEFAULT_FRAME_RATE,
        tf: {
            zoom: 1,
            stretchX: 1,
            stretchY: 1,
            flipX: 1,
            flipY: 1,
            rot: 0,
            tx: 0,
            ty: 0
        }
    };
}

function isPlayer2Window() {
    return windowRole === WINDOW_ROLES.player2;
}

function isMainWindow() {
    return !isPlayer2Window();
}

function isElectronShell() {
    return !!electronAPI;
}

function isElectronWindowMode() {
    return !!electronAPI && isMainWindow() && player2Mode === PLAYER2_MODES.window;
}

function usesLocalPlayer2() {
    return !electronAPI || isPlayer2Window() || player2Mode === PLAYER2_MODES.overlay;
}

function mergeRemotePlayer2State(partial) {
    if (!partial || typeof partial !== 'object') return remotePlayer2State;
    remotePlayer2State = {
        ...remotePlayer2State,
        ...partial,
        updatedAt: Number.isFinite(partial.updatedAt) ? partial.updatedAt : Date.now(),
        subtitles: Array.isArray(partial.subtitles) ? partial.subtitles : remotePlayer2State.subtitles,
        subtitlePath: Object.prototype.hasOwnProperty.call(partial, 'subtitlePath')
            ? (typeof partial.subtitlePath === 'string' ? partial.subtitlePath : null)
            : remotePlayer2State.subtitlePath,
        externalAssSubtitle: Object.prototype.hasOwnProperty.call(partial, 'externalAssSubtitle')
            ? partial.externalAssSubtitle
            : remotePlayer2State.externalAssSubtitle,
        subtitleFontScale: Number.isFinite(partial.subtitleFontScale) ? normalizeSubtitleFontScale(partial.subtitleFontScale) : remotePlayer2State.subtitleFontScale,
        vobSubTracks: Array.isArray(partial.vobSubTracks) ? partial.vobSubTracks : remotePlayer2State.vobSubTracks,
        audioTracks: Array.isArray(partial.audioTracks) ? partial.audioTracks : remotePlayer2State.audioTracks,
        tf: isValidTf(partial.tf) ? cloneTf(partial.tf) : remotePlayer2State.tf
    };
    return remotePlayer2State;
}

function getPlayer2Time() {
    if (usesLocalPlayer2()) return video2.currentTime || 0;
    const base = remotePlayer2State.currentTime || 0;
    if (remotePlayer2State.paused) return base;
    const updatedAt = Number.isFinite(remotePlayer2State.updatedAt) ? remotePlayer2State.updatedAt : Date.now();
    const playbackRate = Number.isFinite(remotePlayer2State.playbackRate) ? remotePlayer2State.playbackRate : 1;
    const elapsed = Math.max(0, (Date.now() - updatedAt) / 1000);
    return base + (elapsed * playbackRate);
}

function getPlayer2Duration() {
    return usesLocalPlayer2() ? (video2.duration || 0) : (remotePlayer2State.duration || 0);
}

function normalizeFrameRate(value) {
    const fps = Number(value);
    return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FRAME_RATE;
}

function getFrameRateForPlayer(playerNum) {
    return normalizeFrameRate(playerNum === 1 ? frameRate1 : frameRate2);
}

function setFrameRateForPlayer(playerNum, value) {
    const nextRate = normalizeFrameRate(value);
    if (playerNum === 1) {
        frameRate1 = nextRate;
    } else {
        frameRate2 = nextRate;
        if (isMainWindow() && isElectronWindowMode()) {
            mergeRemotePlayer2State({ frameRate: nextRate });
        }
    }
    return nextRate;
}

function getPlayerNumFromVideo(video) {
    return video === video1 ? 1 : 2;
}

function isPlayer2Paused() {
    return usesLocalPlayer2() ? !!video2.paused : !!remotePlayer2State.paused;
}

function buildPlayer2Snapshot() {
    if (usesLocalPlayer2()) {
        return {
            src: video2.currentSrc || video2.src || '',
            filePath: lastVideoPath2 || null,
            currentTime: video2.currentTime || 0,
            duration: video2.duration || 0,
            paused: !!video2.paused,
            volume: Number.isFinite(video2.volume) ? video2.volume : 1,
            muted: getPlayerMuted(2),
            playbackRate: Number.isFinite(video2.playbackRate) ? video2.playbackRate : globalPlaybackRate,
            updatedAt: Date.now(),
            subtitles: Array.isArray(subtitles2) ? [...subtitles2] : [],
            subtitlePath: lastSubtitlePath2 || null,
            externalAssSubtitle: externalAssSubtitle2,
            subtitlesEnabled: subtitlesEnabled2 !== false,
            subtitleFontScale: subtitleFontScale2,
            vobSubTrack: vobSubTrack2,
            vobSubTracks: [...vobSubTracks2],
            audioTrack: audioTrack2,
            audioTracks: [...audioTracks2],
            frameRate: getFrameRateForPlayer(2),
            tf: cloneTf(tf2)
        };
    }

    return {
        ...remotePlayer2State,
        subtitles: Array.isArray(remotePlayer2State.subtitles) ? [...remotePlayer2State.subtitles] : [],
        tf: isValidTf(remotePlayer2State.tf) ? cloneTf(remotePlayer2State.tf) : cloneTf(tf2)
    };
}

function buildPlayer2SyncMeta() {
    return {
        syncPoint1,
        syncPoint2,
        isSynced,
        delay,
        globalPlaybackRate,
        activeVideo
    };
}

function snapshotUndoableState() {
    return {
        video1Time: Number.isFinite(video1?.currentTime) ? video1.currentTime : 0,
        video2Time: getPlayer2Time(),
        video1Paused: !!video1?.paused,
        video2Paused: isPlayer2Paused(),
        syncPoint1,
        syncPoint2,
        isSynced,
        delay
    };
}

function statesMatch(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function setPlayButtonState(buttonId, paused) {
    const button = document.getElementById(buttonId);
    if (button) button.textContent = paused ? '▶' : '⏸';
}

function applyUndoableState(state) {
    if (!state || typeof state !== 'object') return;

    syncPoint1 = Number.isFinite(state.syncPoint1) ? state.syncPoint1 : null;
    syncPoint2 = Number.isFinite(state.syncPoint2) ? state.syncPoint2 : null;
    isSynced = !!state.isSynced;
    delay = Number.isFinite(state.delay) ? state.delay : 0;
    lastSyncTime = 0;

    if (Number.isFinite(state.video1Time)) {
        try { video1.currentTime = state.video1Time; } catch { }
        updateProgress(video1, 'progressBar1', 'timeDisplay1');
        updateSubtitles(1, state.video1Time);
    }

    if (Number.isFinite(state.video2Time)) {
        if (isElectronWindowMode()) {
            mergeRemotePlayer2State({ currentTime: state.video2Time, paused: !!state.video2Paused });
            dispatchToPeer({ type: 'player2-seek', currentTime: state.video2Time });
        } else {
            try { video2.currentTime = state.video2Time; } catch { }
            updateProgress(video2, 'progressBar2', 'timeDisplay2');
            updateSubtitles(2, state.video2Time);
        }
    }

    if (state.video1Paused) {
        try { video1.pause(); } catch { }
    } else {
        video1.play().catch(() => { });
    }
    setPlayButtonState('playBtn1', !!state.video1Paused);

    if (isElectronWindowMode()) {
        mergeRemotePlayer2State({ paused: !!state.video2Paused });
        dispatchToPeer({ type: state.video2Paused ? 'player2-pause' : 'player2-play' });
    } else if (state.video2Paused) {
        try { video2.pause(); } catch { }
    } else {
        video2.play().catch(() => { });
    }
    setPlayButtonState('playBtn2', !!state.video2Paused);

    const syncControls = document.getElementById('syncControls');
    if (syncControls) syncControls.style.display = isSynced ? 'none' : '';
    if (isElectronWindowMode()) {
        dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
    }
    schedulePersistElectronPlaybackSession(0);
}

function recordUndoableAction(label, action) {
    if (!isMainWindow()) return false;
    const before = snapshotUndoableState();
    action();
    const after = snapshotUndoableState();
    if (statesMatch(before, after)) return false;

    undoStack.push({ label, before, after });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    return true;
}

async function recordSetSyncPoint() {
    if (isPlayer2Window()) {
        requestPlayer2SetSync();
        return false;
    }

    if (isElectronWindowMode()) {
        await requestFreshRemotePlayer2State();
    }

    return recordUndoableAction('Set Sync Point', setSyncPoint);
}

function undoLastAction() {
    if (isPlayer2Window()) {
        requestMainKeyboardControl('undo');
        return;
    }

    const entry = undoStack.pop();
    if (!entry) {
        showControlNotification('Nothing to undo');
        return;
    }

    redoStack.push(entry);
    applyUndoableState(entry.before);
    showControlNotification(`Undo: ${entry.label}`);
}

function redoLastAction() {
    if (isPlayer2Window()) {
        requestMainKeyboardControl('redo');
        return;
    }

    const entry = redoStack.pop();
    if (!entry) {
        showControlNotification('Nothing to redo');
        return;
    }

    undoStack.push(entry);
    applyUndoableState(entry.after);
    showControlNotification(`Redo: ${entry.label}`);
}

function setActiveVideo(nextVideo, options = {}) {
    if (nextVideo !== 1 && nextVideo !== 2) return;
    activeVideo = nextVideo;

    if (options.notify !== false) {
        showControlNotification(`Controlling Video ${activeVideo}`);
    }

    if (options.broadcast && isMainWindow() && isElectronWindowMode()) {
        dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
    }
}

function requestMainKeyboardControl(action, payload = {}) {
    if (!isPlayer2Window()) return false;
    const localPlayer2State = action === 'set-sync' ? buildPlayer2SyncRequestState() : null;
    dispatchToPeer({
        type: 'player2-request-keyboard-control',
        action,
        activeVideo,
        ...(localPlayer2State ? { player2State: localPlayer2State } : {}),
        ...payload
    });
    return true;
}

function buildPlayer2SyncRequestState() {
    if (!isPlayer2Window()) return null;
    return {
        currentTime: Number.isFinite(video2?.currentTime) ? video2.currentTime : 0,
        duration: Number.isFinite(video2?.duration) ? video2.duration : 0,
        paused: !!video2?.paused,
        playbackRate: Number.isFinite(video2?.playbackRate) ? video2.playbackRate : globalPlaybackRate,
        updatedAt: Date.now()
    };
}

function requestPlayer2SetSync() {
    dispatchToPeer({
        type: 'player2-request-set-sync',
        state: buildPlayer2SyncRequestState()
    });
}

function requestFreshRemotePlayer2State(timeoutMs = 350) {
    if (!isElectronWindowMode() || !player2WindowOpen) return Promise.resolve(remotePlayer2State);

    const commandId = `remote-player2-state-${++remotePlayer2StateRequestId}`;
    return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
            remotePlayer2StateWaiters.delete(commandId);
            resolve(remotePlayer2State);
        }, timeoutMs);

        remotePlayer2StateWaiters.set(commandId, {
            resolve: (state) => {
                window.clearTimeout(timeout);
                resolve(state || remotePlayer2State);
            }
        });

        dispatchToPeer({ type: 'player2-request-state', commandId });
    });
}

function applyTransformHotkey(code, alt, ctrl) {
    const tf = activeVideo === 1 ? tf1 : tf2;

    switch (code) {
        // === Zoom / Rotate90 / Move Up-Right ===
        case 'Numpad9':
            if (alt) { // Rotate â­® 90Â° (clockwise)
                tf.rot += 90; applyTransform();
            } else if (ctrl) { // Move Up-Right
                tf.tx += MOVE_STEP; tf.ty -= MOVE_STEP; applyTransform();
            } else { // Zoom In
                tf.zoom = clamp(tf.zoom + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM); applyTransform();
            }
            return true;
        // === Zoom Out / Rotate â­¯ / Move Down-Left ===
        case 'Numpad1':
            if (alt) { // Rotate â­¯ (counterclockwise) small step
                tf.rot -= ROTATE_STEP; applyTransform();
            } else if (ctrl) { // Move Down-Left
                tf.tx -= MOVE_STEP; tf.ty += MOVE_STEP; applyTransform();
            } else { // Zoom Out
                tf.zoom = clamp(tf.zoom - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM); applyTransform();
            }
            return true;
        // === Horizontal Stretch / Flip H / Move Right ===
        case 'Numpad6':
            if (alt) { // Flip Horizontally (toggle)
                tf.flipX *= -1; applyTransform();
            } else if (ctrl) { // Move Right
                tf.tx += MOVE_STEP; applyTransform();
            } else { // Stretch X
                tf.stretchX = clamp(tf.stretchX + STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform();
            }
            return true;
        // === Horizontal Compress / Flip H / Move Left ===
        case 'Numpad4':
            if (alt) { // Flip Horizontally (toggle)
                tf.flipX *= -1; applyTransform();
            } else if (ctrl) { // Move Left
                tf.tx -= MOVE_STEP; applyTransform();
            } else { // Compress X
                tf.stretchX = clamp(tf.stretchX - STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform();
            }
            return true;
        // === Vertical Stretch / Flip V / Move Up ===
        case 'Numpad8':
            if (alt) { // Flip Vertically (toggle)
                tf.flipY *= -1; applyTransform();
            } else if (ctrl) { // Move Up
                tf.ty -= MOVE_STEP; applyTransform();
            } else { // Stretch Y
                tf.stretchY = clamp(tf.stretchY + STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform();
            }
            return true;
        // === Vertical Compress / Flip V / Move Down ===
        case 'Numpad2':
            if (alt) { // Flip Vertically (toggle)
                tf.flipY *= -1; applyTransform();
            } else if (ctrl) { // Move Down
                tf.ty += MOVE_STEP; applyTransform();
            } else { // Compress Y
                tf.stretchY = clamp(tf.stretchY - STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform();
            }
            return true;
        // === Rotate â­® (clockwise small) / Move Down-Right ===
        case 'Numpad3':
            if (alt) { // Rotate â­®
                tf.rot += ROTATE_STEP; applyTransform();
            } else if (ctrl) { // Move Down-Right
                tf.tx += MOVE_STEP; tf.ty += MOVE_STEP; applyTransform();
            } else {
                return false;
            }
            return true;
        // === Rotate â­¯ 90Â° (counterclockwise) / Move Up-Left ===
        case 'Numpad7':
            if (alt) { // Rotate â­¯ 90Â°
                tf.rot -= 90; applyTransform();
            } else if (ctrl) { // Move Up-Left
                tf.tx -= MOVE_STEP; tf.ty -= MOVE_STEP; applyTransform();
            } else {
                return false;
            }
            return true;
        // === Recenter / Reset ===
        case 'Numpad5':
            if (ctrl) { // Recenter (only translate)
                recenter();
            } else { // Reset all transformations
                resetTransforms();
            }
            return true;
        default:
            return false;
    }
}

function cloneTf(tf) {
    return {
        zoom: Number(tf.zoom),
        stretchX: Number(tf.stretchX),
        stretchY: Number(tf.stretchY),
        flipX: Number(tf.flipX),
        flipY: Number(tf.flipY),
        rot: Number(tf.rot),
        tx: Number(tf.tx),
        ty: Number(tf.ty)
    };
}

function isValidTf(tf) {
    if (!tf || typeof tf !== 'object') return false;
    const keys = ['zoom', 'stretchX', 'stretchY', 'flipX', 'flipY', 'rot', 'tx', 'ty'];
    return keys.every(k => typeof tf[k] === 'number' && Number.isFinite(tf[k]));
}

function getCurrentOverlayGeom(overlayEl) {
    const overlay = overlayEl || document.getElementById('overlayPlayer');
    if (!overlay) return null;
    try {
        const rect = overlay.getBoundingClientRect();
        return {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        };
    } catch {
        return null;
    }
}

function applyOverlayGeom(geom) {
    const overlay = document.getElementById('overlayPlayer');
    if (!overlay || !geom) return false;
    const valid = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!valid(geom.left) || !valid(geom.top) || !valid(geom.width) || !valid(geom.height)) return false;
    overlay.style.left = geom.left + 'px';
    overlay.style.top = geom.top + 'px';
    overlay.style.width = geom.width + 'px';
    overlay.style.height = geom.height + 'px';
    overlay.style.right = 'auto';
    return true;
}

function getProfileSlotFromEvent(event) {
    const code = String(event.code || '');
    if (code.startsWith('Digit') || code.startsWith('Numpad')) {
        const n = parseInt(code.replace('Digit', '').replace('Numpad', ''), 10);
        if (Number.isInteger(n) && n >= 0 && n <= 9) return n;
    }
    if (/^[0-9]$/.test(event.key)) return parseInt(event.key, 10);
    return null;
}

function readProfiles() {
    const raw = lsGet(LS_KEYS.profiles);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeProfiles(profiles) {
    lsSet(LS_KEYS.profiles, JSON.stringify(profiles || {}));
}

function normalizeProfileEntry(raw, slot) {
    if (!raw || typeof raw !== 'object') return null;
    const defaultName = '';
    const explicitName = typeof raw.name === 'string' ? raw.name.trim() : '';

    if (raw.state && typeof raw.state === 'object') {
        return {
            name: explicitName || defaultName,
            state: raw.state
        };
    }

    // Backward compatibility with old profile format: slot => state
    if (isValidTf(raw.tf1) && isValidTf(raw.tf2)) {
        return {
            name: explicitName || defaultName,
            state: raw
        };
    }

    return {
        name: explicitName || defaultName,
        state: null
    };
}

function buildCurrentProfileState() {
    return {
        tf1: cloneTf(tf1),
        tf2: cloneTf(tf2),
        overlayGeom: getCurrentOverlayGeom(),
        subtitleFontScale1,
        subtitleFontScale2,
        activeVideo: activeVideo
    };
}

function applyProfileState(state) {
    if (!state || typeof state !== 'object') return false;
    if (!isValidTf(state.tf1) || !isValidTf(state.tf2)) return false;
    tf1 = cloneTf(state.tf1);
    tf2 = cloneTf(state.tf2);
    applyTransform(1);
    applyTransform(2);
    if (Number.isFinite(state.subtitleFontScale1)) {
        setSubtitleFontScale(1, state.subtitleFontScale1, { notify: false, broadcast: false });
    }
    if (Number.isFinite(state.subtitleFontScale2)) {
        setSubtitleFontScale(2, state.subtitleFontScale2, { notify: false, broadcast: false });
    }

    if (state.overlayGeom) {
        if (applyOverlayGeom(state.overlayGeom)) {
            lsSet(LS_KEYS.overlayGeom, JSON.stringify(state.overlayGeom));
        }
    }

    if (state.activeVideo === 1 || state.activeVideo === 2) {
        activeVideo = state.activeVideo;
    }

    return true;
}

function saveProfile(slot) {
    const profiles = readProfiles();
    const existing = normalizeProfileEntry(profiles[String(slot)], slot);
    const name = existing?.name || '';
    profiles[String(slot)] = {
        name,
        state: buildCurrentProfileState()
    };
    writeProfiles(profiles);
    showControlNotification(`Saved Profile ${name}`);
}

function loadProfile(slot) {
    const profiles = readProfiles();
    const entry = normalizeProfileEntry(profiles[String(slot)], slot);
    const state = entry?.state;
    if (!state) {
        showControlNotification(`Profile ${slot} is empty`);
        return;
    }
    if (!applyProfileState(state)) {
        showControlNotification(`Profile ${slot} is invalid`);
        return;
    }
    showControlNotification(`Loaded ${entry.name ? entry.name : `Profile ${slot}`}`);
}

function renameProfile(slot, name, options) {
    const opts = options || {};
    const profiles = readProfiles();
    const existing = normalizeProfileEntry(profiles[String(slot)], slot) || {
        name: '',
        state: null
    };
    const trimmed = String(name || '').trim();
    existing.name = trimmed;
    profiles[String(slot)] = existing;
    writeProfiles(profiles);
    if (opts.notify) showControlNotification(`Renamed profile ${slot}`);
}

function isProfileMenuOpen() {
    return !!document.getElementById('profileMenuOverlay');
}

function closeProfileMenu() {
    const overlay = document.getElementById('profileMenuOverlay');
    if (overlay) overlay.remove();
}

function openProfileMenu() {
    closeProfileMenu();

    const overlay = document.createElement('div');
    overlay.id = 'profileMenuOverlay';
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        z-index: 12000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
        width: min(840px, 100%);
        max-height: 85vh;
        overflow: auto;
        background: #151515;
        color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.15);
    `;
    header.innerHTML = `
        <div style="font-size: 18px; font-weight: 700;">Profiles</div>
        <div style="font-size: 12px; opacity: 0.75;">Ctrl+Shift+\` to close</div>
    `;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = `
        border: 1px solid rgba(255, 255, 255, 0.35);
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        border-radius: 8px;
        padding: 6px 10px;
        cursor: pointer;
    `;
    closeBtn.addEventListener('click', closeProfileMenu);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.style.cssText = `padding: 10px 12px 14px;`;
    const renameTimers = new Map();

    const profiles = readProfiles();
    const slotOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
    for (const slot of slotOrder) {
        const entry = normalizeProfileEntry(profiles[String(slot)], slot);
        const hasState = !!entry?.state;
        const row = document.createElement('div');
        row.style.cssText = `
            display: grid;
            grid-template-columns: 72px 1fr auto;
            gap: 8px;
            align-items: center;
            padding: 8px 6px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        `;

        const slotLabel = document.createElement('div');
        slotLabel.textContent = `${slot}`;
        slotLabel.style.cssText = `
            font-weight: 700;
            font-size: 16px;
            text-align: center;
            border: 1px solid rgba(255, 255, 255, 0.25);
            border-radius: 8px;
            padding: 8px 0;
            background: rgba(255, 255, 255, 0.05);
        `;

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = entry?.name || '';
        nameInput.placeholder = '';
        nameInput.style.cssText = `
            width: 100%;
            min-width: 0;
            background: rgba(255, 255, 255, 0.06);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.22);
            border-radius: 8px;
            padding: 8px 10px;
            outline: none;
        `;
        const saveNameNow = () => {
            if (renameTimers.has(slot)) {
                clearTimeout(renameTimers.get(slot));
                renameTimers.delete(slot);
            }
            renameProfile(slot, nameInput.value, { notify: false });
        };
        nameInput.addEventListener('input', () => {
            if (renameTimers.has(slot)) clearTimeout(renameTimers.get(slot));
            const t = setTimeout(() => {
                renameProfile(slot, nameInput.value, { notify: false });
                renameTimers.delete(slot);
            }, 250);
            renameTimers.set(slot, t);
        });
        nameInput.addEventListener('blur', saveNameNow);
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveNameNow();
                nameInput.blur();
            }
        });

        const actions = document.createElement('div');
        actions.style.cssText = `
            display: flex;
            align-items: center;
            gap: 6px;
        `;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.style.cssText = `
            border: 1px solid rgba(120, 170, 255, 0.75);
            background: rgba(84, 125, 255, 0.25);
            color: #dbe7ff;
            border-radius: 8px;
            width: 72px;
            padding: 8px 10px;
            cursor: pointer;
            white-space: nowrap;
            text-align: center;
            box-sizing: border-box;
        `;

        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.style.cssText = `
            border-radius: 8px;
            width: 72px;
            padding: 8px 10px;
            white-space: nowrap;
            text-align: center;
            box-sizing: border-box;
        `;
        const setLoadState = (enabled) => {
            loadBtn.textContent = enabled ? 'Load' : 'Empty';
            loadBtn.disabled = !enabled;
            loadBtn.style.border = `1px solid ${enabled ? 'rgba(120, 255, 180, 0.75)' : 'rgba(255, 255, 255, 0.2)'}`;
            loadBtn.style.background = enabled ? 'rgba(46, 204, 113, 0.25)' : 'rgba(255, 255, 255, 0.05)';
            loadBtn.style.color = enabled ? '#d8ffe8' : 'rgba(255, 255, 255, 0.5)';
            loadBtn.style.cursor = enabled ? 'pointer' : 'default';
        };
        setLoadState(hasState);

        saveBtn.addEventListener('click', () => {
            saveNameNow();
            saveProfile(slot);
            setLoadState(true);
        });
        loadBtn.addEventListener('click', () => {
            loadProfile(slot);
            closeProfileMenu();
        });

        row.appendChild(slotLabel);
        row.appendChild(nameInput);
        actions.appendChild(saveBtn);
        actions.appendChild(loadBtn);
        row.appendChild(actions);
        body.appendChild(row);
    }

    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeProfileMenu();
    });
}

// ===== Transform state (BOTH PLAYERS) =====
const ZOOM_STEP = 0.05;
const STRETCH_STEP = 0.05;
const ROTATE_STEP = 1;      // degrees per tap (Alt+Numpad1/3)
const MOVE_STEP = 20;       // px per tap (Ctrl+Numpad directions)
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 10;
const MIN_STRETCH = 0.1;
const MAX_STRETCH = 10;

// Separate transform states for each video
let tf1 = {
    zoom: 1,
    stretchX: 1,
    stretchY: 1,
    flipX: 1,
    flipY: 1,
    rot: 0,        // degrees
    tx: 0,         // translate X (px)
    ty: 0          // translate Y (px)
};

let tf2 = {
    zoom: 1,
    stretchX: 1,
    stretchY: 1,
    flipX: 1,
    flipY: 1,
    rot: 0,        // degrees
    tx: 0,         // translate X (px)
    ty: 0          // translate Y (px)
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Debounced save for transform updates
let saveTfTimer = null;
function scheduleSaveTf() {
    if (saveTfTimer) clearTimeout(saveTfTimer);
    saveTfTimer = setTimeout(() => {
        lsSet(LS_KEYS.video1Tf, JSON.stringify(tf1));
        lsSet(LS_KEYS.video2Tf, JSON.stringify(tf2));
    }, 200);
}

function applyTransform(videoNum) {
    // Default to active video if not specified
    const targetVideo = videoNum !== undefined ? videoNum : activeVideo;
    const tf = targetVideo === 1 ? tf1 : tf2;
    const video = targetVideo === 1 ? video1 : video2;
    const mediaLayer = document.getElementById(`videoMediaLayer${targetVideo}`) || video;

    const sx = tf.zoom * tf.stretchX * tf.flipX;
    const sy = tf.zoom * tf.stretchY * tf.flipY;
    mediaLayer.style.transform = `translate(${tf.tx}px, ${tf.ty}px) rotate(${tf.rot}deg) scale(${sx}, ${sy})`;
    syncVobSubRendererTransform(targetVideo);
    if (targetVideo === 2 && isElectronWindowMode()) {
        remotePlayer2State.tf = cloneTf(tf2);
        sendHydrateToPlayer2Window();
    }
    if (targetVideo === 2 && isPlayer2Window()) {
        maybeBroadcastPlayer2State('transform');
    }
    scheduleSaveTf();
}

function resetTransforms() {
    if (activeVideo === 1) {
        tf1 = { zoom: 1, stretchX: 1, stretchY: 1, flipX: 1, flipY: 1, rot: 0, tx: 0, ty: 0 };
    } else {
        tf2 = { zoom: 1, stretchX: 1, stretchY: 1, flipX: 1, flipY: 1, rot: 0, tx: 0, ty: 0 };
    }
    applyTransform();
}

function recenter() {
    const tf = activeVideo === 1 ? tf1 : tf2;
    tf.tx = 0; tf.ty = 0;
    applyTransform();
}

function setOverlayVisibilityForCurrentMode() {
    const overlay = document.getElementById('overlayPlayer');
    if (!overlay || isPlayer2Window()) return;
    overlay.style.display = player2Mode === PLAYER2_MODES.window ? 'none' : '';
}

function updatePlayer2ModeMenu(state) {
    const info = state || { mode: player2Mode, player2WindowOpen };
    player2Mode = info.mode === PLAYER2_MODES.window ? PLAYER2_MODES.window : PLAYER2_MODES.overlay;
    player2WindowOpen = !!info.player2WindowOpen;
    if (!player2WindowOpen) player2Ready = false;

    [
        ['player2ModeToggle', 'player2ModeDivider'],
        ['player2ModeToggle2', 'player2ModeDivider2']
    ].forEach(([buttonId, dividerId]) => {
        const toggleBtn = document.getElementById(buttonId);
        const toggleDivider = document.getElementById(dividerId);
        if (!toggleBtn) return;

        if (!isElectronShell()) {
            toggleBtn.style.display = 'none';
            if (toggleDivider) toggleDivider.style.display = 'none';
            return;
        }

        toggleBtn.style.display = 'block';
        if (toggleDivider) toggleDivider.style.display = 'block';

        if (player2Mode === PLAYER2_MODES.overlay) {
            toggleBtn.textContent = 'Pop Out Player 2';
        } else if (player2WindowOpen) {
            toggleBtn.textContent = 'Dock Player 2';
        } else {
            toggleBtn.textContent = 'Reopen Player 2';
        }
    });

    setOverlayVisibilityForCurrentMode();
}

function dispatchToPeer(message) {
    if (!electronAPI || !message || typeof message !== 'object') return;
    electronAPI.sendPlayerEvent(message);
}

function maybeBroadcastPlayer2State(reason) {
    if (!electronAPI || !isPlayer2Window() || suppressPlayer2StateBroadcast) return;
    dispatchToPeer({
        type: 'player2-state',
        reason: reason || 'state',
        state: buildPlayer2Snapshot()
    });
}

function broadcastPlayer2Metadata(reason) {
    if (!electronAPI || !isPlayer2Window()) return;
    dispatchToPeer({
        type: 'player2-metadata',
        reason: reason || 'metadata',
        state: {
            src: video2.currentSrc || video2.src || '',
            filePath: lastVideoPath2 || null,
            currentTime: video2.currentTime || 0,
            duration: video2.duration || 0,
            paused: !!video2.paused,
            playbackRate: Number.isFinite(video2.playbackRate) ? video2.playbackRate : globalPlaybackRate,
            frameRate: getFrameRateForPlayer(2),
            vobSubTrack: vobSubTrack2,
            vobSubTracks: [...vobSubTracks2],
            audioTrack: audioTrack2,
            audioTracks: [...audioTracks2],
            updatedAt: Date.now()
        }
    });
}

function handlePlayer2VolumeChange(reason) {
    const slider = document.getElementById('volumeSlider2');
    if (slider) {
        slider.value = Number.isFinite(video2.volume) ? video2.volume.toFixed(3) : slider.value;
        const pct = Math.max(0, Math.min(1, parseFloat(slider.value))) * 100;
        slider.style.setProperty('--vol', pct + '%');
    }
    changeVolume(video2, video2.volume, 'muteBtn2');
    maybeBroadcastPlayer2State(reason || 'volume');
}

function sendHydrateToPlayer2Window() {
    if (!electronAPI || !isMainWindow() || player2Mode !== PLAYER2_MODES.window || !player2WindowOpen) return;
    dispatchToPeer({
        type: 'hydrate-player2',
        state: buildPlayer2Snapshot(),
        sync: buildPlayer2SyncMeta()
    });
}

async function hydrateLocalPlayer2FromSnapshot(snapshot, options) {
    const state = snapshot || createEmptyPlayer2State();
    const opts = options || {};
    const nextTf = isValidTf(state.tf) ? cloneTf(state.tf) : cloneTf(tf2);
    const currentSrc = video2.currentSrc || video2.src || '';
    const nextSrc = state.src || '';
    const shouldLoad = currentSrc !== nextSrc;

    suppressPlayer2StateBroadcast = true;
    try {
        subtitles2 = Array.isArray(state.subtitles) ? [...state.subtitles] : [];
        externalAssSubtitle2 = state.externalAssSubtitle && typeof state.externalAssSubtitle.content === 'string'
            ? state.externalAssSubtitle
            : null;
        subtitlesEnabled2 = state.subtitlesEnabled !== false;
        lastSubtitlePath2 = typeof state.subtitlePath === 'string' ? state.subtitlePath : null;
        setAvailableVobSubTracks(2, state.vobSubTracks, state.vobSubTrack);
        setAvailableAudioTracks(2, state.audioTracks, state.audioTrack);
        setFrameRateForPlayer(2, state.frameRate);
        setSubtitleFontScale(2, state.subtitleFontScale, { notify: false, broadcast: false });
        tf2 = nextTf;
        if (lastVideoPath2 !== state.filePath && typeof state.filePath === 'string') {
            lastVideoPath2 = state.filePath;
        }

        if (shouldLoad) {
            if (nextSrc) {
                await loadVideoFromSource(video2, nextSrc, VIDEO_PLAYER_IDS.video2, state.filePath || null, {
                    persist: opts.persist !== false,
                    skipModeRouting: true,
                    clearSubtitles: false
                });
            } else {
                try { video2.pause(); } catch { }
                video2.removeAttribute('src');
                video2.load();
            }
        }

        const applyState = () => {
            if (Number.isFinite(state.playbackRate)) {
                globalPlaybackRate = state.playbackRate;
                try { video2.playbackRate = state.playbackRate; } catch { }
            }
            if (Number.isFinite(state.volume)) video2.volume = state.volume;
            setPlayerMuted(2, !!state.muted);
            if (Number.isFinite(state.currentTime) && (video2.duration || nextSrc)) {
                try { video2.currentTime = state.currentTime; } catch { }
            }
            if (state.paused === false) {
                video2.play().catch(() => { });
            } else {
                try { video2.pause(); } catch { }
            }
            syncSpeedSelects(globalPlaybackRate);
            applyTransform(2);
            updateProgress(video2, 'progressBar2', 'timeDisplay2');
            updateSubtitles(2, state.currentTime || video2.currentTime || 0);
            handlePlayer2VolumeChange('hydrate');
            broadcastPlayer2Metadata('hydrate');
        };

        if (shouldLoad && nextSrc) {
            await new Promise((resolve) => {
                let finished = false;
                const done = () => {
                    if (finished) return;
                    finished = true;
                    applyState();
                    resolve();
                };
                video2.addEventListener('loadedmetadata', done, { once: true });
                setTimeout(done, 500);
            });
        } else {
            applyState();
        }
        if (externalAssSubtitle2) {
            await applyAssSubtitleContent(2, externalAssSubtitle2.content, externalAssSubtitle2.path, { persist: false });
        } else {
            configureVobSubTrack(VIDEO_PLAYER_IDS.video2, state.vobSubTrack, state.filePath || null);
        }
        configureAudioTrack(VIDEO_PLAYER_IDS.video2, state.audioTrack, state.filePath || null);
    } finally {
        suppressPlayer2StateBroadcast = false;
    }
}

function applySyncMeta(sync) {
    if (!sync || typeof sync !== 'object') return;
    syncPoint1 = sync.syncPoint1 ?? null;
    syncPoint2 = sync.syncPoint2 ?? null;
    isSynced = !!sync.isSynced;
    delay = Number.isFinite(sync.delay) ? sync.delay : 0;
    if (Number.isFinite(sync.globalPlaybackRate)) {
        globalPlaybackRate = sync.globalPlaybackRate;
        syncSpeedSelects(globalPlaybackRate);
    }
    if (sync.activeVideo === 1 || sync.activeVideo === 2) {
        activeVideo = sync.activeVideo;
    }

    const syncControls = document.getElementById('syncControls');
    if (syncControls) syncControls.style.display = isSynced ? 'none' : '';
}

async function enterPlayer2WindowMode() {
    remotePlayer2State = buildPlayer2Snapshot();
    pendingPlayer2Hydration = true;
    const nextState = await electronAPI.setPlayer2Mode(PLAYER2_MODES.window);
    updatePlayer2ModeMenu(nextState);
    try { video2.pause(); } catch { }
    disposeVobSubRenderer(2);
    getDynamicAudioPlayer(2)?.setTrack(null, null).catch(() => { });
    video2.removeAttribute('src');
    video2.load();
}

async function dockPlayer2ToOverlay() {
    const snapshot = buildPlayer2Snapshot();
    await hydrateLocalPlayer2FromSnapshot(snapshot, { persist: false });
    const nextState = await electronAPI.setPlayer2Mode(PLAYER2_MODES.overlay);
    updatePlayer2ModeMenu(nextState);
    configureAudioTrack(VIDEO_PLAYER_IDS.video2, snapshot.audioTrack, snapshot.filePath || null);
    if (!snapshot.externalAssSubtitle) {
        configureVobSubTrack(VIDEO_PLAYER_IDS.video2, snapshot.vobSubTrack, snapshot.filePath || null);
    }
}

async function handlePlayer2ModeToggle() {
    if (!electronAPI || !isMainWindow()) return;
    if (player2Mode === PLAYER2_MODES.overlay) {
        await enterPlayer2WindowMode();
        return;
    }
    if (player2WindowOpen) {
        await dockPlayer2ToOverlay();
        return;
    }
    pendingPlayer2Hydration = true;
    const nextState = await electronAPI.showPlayer2Window();
    updatePlayer2ModeMenu(nextState);
}

async function handlePlayer2ModeToggleClick(event, settingsId) {
    event.preventDefault();
    event.stopPropagation();

    if (isPlayer2Window()) {
        dispatchToPeer({ type: 'player2-request-dock' });
    } else {
        await handlePlayer2ModeToggle();
    }

    document.getElementById(settingsId)?.classList.remove('open');
}

async function initializeElectronContext() {
    if (!electronAPI) return;

    try {
        const ctx = await electronAPI.getWindowContext();
        if (ctx && ctx.role === WINDOW_ROLES.player2) {
            windowRole = WINDOW_ROLES.player2;
            document.body.classList.add('player2-window');
            activeVideo = 2;
        } else {
            windowRole = WINDOW_ROLES.main;
            document.body.classList.remove('player2-window');
        }
        updatePlayer2ModeMenu(ctx);
    } catch {
        windowRole = WINDOW_ROLES.main;
        updatePlayer2ModeMenu({ mode: PLAYER2_MODES.overlay, player2WindowOpen: false });
    }

    electronAPI.onPlayer2ModeState((state) => {
        const wasOpen = player2WindowOpen;
        updatePlayer2ModeMenu(state);
        if (isMainWindow() && player2Mode === PLAYER2_MODES.window && player2WindowOpen && (!wasOpen || pendingPlayer2Hydration)) {
            sendHydrateToPlayer2Window();
            pendingPlayer2Hydration = false;
        }
    });

    electronAPI.onPlayerEvent(async (message) => {
        if (!message || typeof message !== 'object') return;

        if (isPlayer2Window()) {
            if (message.type === 'hydrate-player2') {
                applySyncMeta(message.sync);
                await hydrateLocalPlayer2FromSnapshot(message.state, { persist: false });
                maybeBroadcastPlayer2State('hydrate-applied');
            } else if (message.type === 'player2-seek') {
                revealPlayerControls();
                if (Number.isFinite(message.currentTime)) {
                    const targetTime = message.currentTime;
                    try { video2.currentTime = targetTime; } catch { }
                    updateProgress(video2, 'progressBar2', 'timeDisplay2');
                    updateSubtitles(2, targetTime);
                    await waitForVideoSeekEvent(video2);
                    updateProgress(video2, 'progressBar2', 'timeDisplay2');
                    updateSubtitles(2, video2.currentTime || targetTime);
                    maybeBroadcastPlayer2State('seek-command');
                    if (message.commandId) {
                        dispatchToPeer({
                            type: 'player2-seek-complete',
                            commandId: message.commandId,
                            currentTime: video2.currentTime || targetTime
                        });
                    }
                }
            } else if (message.type === 'player2-play') {
                revealPlayerControls();
                video2.play().catch(() => { });
            } else if (message.type === 'player2-pause') {
                revealPlayerControls();
                try { video2.pause(); } catch { }
            } else if (message.type === 'player2-speed') {
                revealPlayerControls();
                const rate = Number(message.rate);
                if (Number.isFinite(rate)) {
                    globalPlaybackRate = rate;
                    try { video2.playbackRate = rate; } catch { }
                    syncSpeedSelects(rate);
                    maybeBroadcastPlayer2State('speed-command');
                }
            } else if (message.type === 'player2-subtitle-font-scale') {
                setSubtitleFontScale(2, message.scale, { notify: false, broadcast: false });
                maybeBroadcastPlayer2State('subtitle-font-scale-command');
            } else if (message.type === 'player2-subtitles-enabled') {
                setSubtitlesEnabled(2, message.enabled !== false, { notify: false, broadcast: false });
                maybeBroadcastPlayer2State('subtitle-toggle-command');
            } else if (message.type === 'player2-sync-meta') {
                applySyncMeta(message.sync);
            } else if (message.type === 'player2-request-state') {
                dispatchToPeer({
                    type: 'player2-state-response',
                    commandId: message.commandId,
                    state: buildPlayer2Snapshot()
                });
            }
            return;
        }

        if (message.type === 'player2-ready') {
            player2Ready = true;
            player2WindowOpen = true;
            if (player2Mode === PLAYER2_MODES.window) {
                sendHydrateToPlayer2Window();
                pendingPlayer2Hydration = false;
            }
            return;
        }

        if (message.type === 'player2-state') {
            const merged = mergeRemotePlayer2State(message.state);
            if (isValidTf(merged.tf)) tf2 = cloneTf(merged.tf);
            if (Array.isArray(merged.subtitles)) subtitles2 = [...merged.subtitles];
            externalAssSubtitle2 = merged.externalAssSubtitle && typeof merged.externalAssSubtitle.content === 'string'
                ? merged.externalAssSubtitle
                : null;
            subtitlesEnabled2 = merged.subtitlesEnabled !== false;
            lastSubtitlePath2 = typeof merged.subtitlePath === 'string' ? merged.subtitlePath : null;
            vobSubTrack2 = merged.vobSubTrack || null;
            setAvailableVobSubTracks(2, merged.vobSubTracks, merged.vobSubTrack);
            audioTrack2 = merged.audioTrack || null;
            setAvailableAudioTracks(2, merged.audioTracks, merged.audioTrack);
            setFrameRateForPlayer(2, merged.frameRate);
            setSubtitleFontScale(2, merged.subtitleFontScale, { notify: false, broadcast: false });
            if (typeof merged.filePath === 'string') lastVideoPath2 = merged.filePath;
            schedulePersistElectronPlaybackSession();
            return;
        }

        if (message.type === 'player2-state-response') {
            const merged = mergeRemotePlayer2State(message.state);
            const waiter = remotePlayer2StateWaiters.get(message.commandId);
            if (waiter) {
                remotePlayer2StateWaiters.delete(message.commandId);
                waiter.resolve(merged);
            }
            schedulePersistElectronPlaybackSession();
            return;
        }

        if (message.type === 'player2-metadata') {
            const merged = mergeRemotePlayer2State(message.state);
            vobSubTrack2 = merged.vobSubTrack || null;
            setAvailableVobSubTracks(2, merged.vobSubTracks, merged.vobSubTrack);
            audioTrack2 = merged.audioTrack || null;
            setAvailableAudioTracks(2, merged.audioTracks, merged.audioTrack);
            setFrameRateForPlayer(2, merged.frameRate);
            if (typeof merged.filePath === 'string') lastVideoPath2 = merged.filePath;
            schedulePersistElectronPlaybackSession();
            return;
        }

        if (message.type === 'player2-seek-complete') {
            const waiter = remotePlayer2SeekWaiters.get(message.commandId);
            if (waiter) {
                remotePlayer2SeekWaiters.delete(message.commandId);
                waiter.resolve(message.currentTime);
            }
            return;
        }

        if (message.type === 'player2-request-toggle-play') {
            const requestedTime = Number.isFinite(message.currentTime) ? message.currentTime : getPlayer2Time();
            mergeRemotePlayer2State({ currentTime: requestedTime });

            if (isSynced) {
                const v1Target = requestedTime - (syncPoint2 || 0) - (delay || 0) + (syncPoint1 || 0);
                if (Number.isFinite(v1Target)) {
                    const v1Dur = video1.duration || 0;
                    const clamped = Math.max(0, Math.min(v1Dur || Number.MAX_SAFE_INTEGER, v1Target));
                    if (v1Dur > 0) video1.currentTime = clamped;
                }

                if (video1.paused) {
                    video1.play().catch(() => { });
                    document.getElementById('playBtn1').textContent = '⏸';
                    mergeRemotePlayer2State({ paused: false, currentTime: requestedTime });
                    dispatchToPeer({ type: 'player2-seek', currentTime: requestedTime });
                    dispatchToPeer({ type: 'player2-play' });
                } else {
                    video1.pause();
                    document.getElementById('playBtn1').textContent = '▶';
                    mergeRemotePlayer2State({ paused: true, currentTime: requestedTime });
                    dispatchToPeer({ type: 'player2-pause' });
                }
                dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
            }
            return;
        }

        if (message.type === 'player2-request-seek') {
            if (Number.isFinite(message.currentTime)) {
                const previous = remotePlayer2State.currentTime || 0;
                remotePlayer2State.currentTime = message.currentTime;
                const syncedTime = message.currentTime;
                if (isSynced) {
                    const v1Target = syncedTime - (syncPoint2 || 0) - (delay || 0) + (syncPoint1 || 0);
                    const v1Dur = video1.duration || 0;
                    const clamped = Math.max(0, Math.min(v1Dur || Number.MAX_SAFE_INTEGER, v1Target));
                    if (Number.isFinite(clamped)) video1.currentTime = clamped;
                    const v1Now = video1.currentTime || 0;
                    syncPoint2 = syncedTime - (v1Now - (syncPoint1 || 0)) - (delay || 0);
                    lastSyncTime = Date.now();
                    dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
                } else if (Math.abs(previous - syncedTime) > 0.001) {
                    dispatchToPeer({ type: 'player2-seek', currentTime: syncedTime });
                }
            }
            return;
        }

        if (message.type === 'player2-request-speed') {
            changeSpeed(video2, message.rate);
            return;
        }

        if (message.type === 'player2-request-active-video') {
            setActiveVideo(message.activeVideo, { broadcast: true });
            return;
        }

        if (message.type === 'player2-request-keyboard-control') {
            if (message.activeVideo === 1 || message.activeVideo === 2) {
                activeVideo = message.activeVideo;
            }

            if (message.action === 'toggle-play') {
                const activeVid = activeVideo === 1 ? video1 : video2;
                const activeBtnId = activeVideo === 1 ? 'playBtn1' : 'playBtn2';
                togglePlay(activeVid, activeBtnId);
            } else if (message.action === 'skip-time') {
                const seconds = Number(message.seconds);
                if (Number.isFinite(seconds)) skipTime(seconds);
            } else if (message.action === 'step-frame') {
                const direction = Number(message.direction);
                if (Number.isFinite(direction) && activeVideo === 2 && isElectronWindowMode()) {
                    startRemotePlayer2FrameStepHold(direction);
                } else if (Number.isFinite(direction)) {
                    startFrameStepHold(direction);
                }
            } else if (message.action === 'stop-frame-step') {
                const direction = Number(message.direction);
                if (!Number.isFinite(direction)
                    || frameStepHoldDirection === direction
                    || remoteFrameStepHoldDirection === direction) {
                    stopFrameStepHold();
                }
            } else if (message.action === 'speed') {
                const direction = Number(message.direction);
                if (Number.isFinite(direction)) bumpSpeed(direction);
            } else if (message.action === 'subtitle-font-size') {
                const direction = Number(message.direction);
                if (Number.isFinite(direction)) adjustSubtitleFontScale(activeVideo, direction);
            } else if (message.action === 'toggle-subtitles') {
                toggleSubtitles(activeVideo);
            } else if (message.action === 'set-sync') {
                if (message.player2State) mergeRemotePlayer2State(message.player2State);
                if (!isSynced) recordSetSyncPoint();
            } else if (message.action === 'clear-sync') {
                recordUndoableAction('Clear Sync', clearSyncPoint);
            } else if (message.action === 'reset-timestamps') {
                recordUndoableAction('Reset Timestamps', resetTimestampsAndClearSync);
            } else if (message.action === 'undo') {
                undoLastAction();
            } else if (message.action === 'redo') {
                redoLastAction();
            } else if (message.action === 'transform-key') {
                applyTransformHotkey(String(message.code || ''), !!message.alt, !!message.ctrl);
            }

            if (isElectronWindowMode()) {
                dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
            }
            return;
        }

        if (message.type === 'player2-request-set-sync') {
            if (message.state) mergeRemotePlayer2State(message.state);
            recordSetSyncPoint();
            return;
        }

        if (message.type === 'player2-request-clear-sync') {
            recordUndoableAction('Clear Sync', clearSyncPoint);
            dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
            return;
        }

        if (message.type === 'player2-request-reset-timestamps') {
            recordUndoableAction('Reset Timestamps', resetTimestampsAndClearSync);
            return;
        }

        if (message.type === 'player2-request-swap') {
            swapVideos();
            return;
        }

        if (message.type === 'player2-request-dock') {
            await dockPlayer2ToOverlay();
        }
    });

    if (isPlayer2Window()) {
        dispatchToPeer({ type: 'player2-ready' });
    }
}

// Initialize players
async function initializePlayers() {
    await initializeElectronContext();
    ensureDynamicAudioPlayers();

    // File inputs
    document.getElementById('file1').addEventListener('change', (e) => loadVideo(e, video1, VIDEO_PLAYER_IDS.video1));
    document.getElementById('file2').addEventListener('change', (e) => loadVideo(e, video2, VIDEO_PLAYER_IDS.video2));
    setupElectronFilePickers();

    // Subtitle inputs
    document.getElementById('subtitle1').addEventListener('change', (e) => loadSubtitle(e, 1));
    document.getElementById('subtitle2').addEventListener('change', (e) => loadSubtitle(e, 2));

    // Subtitle toggle buttons removed (default remains enabled)

    // Settings dropdowns: open/close + actions
    setupDropdown('1');
    setupDropdown('2');
    setupAudioTrackSelector(1);
    setupAudioTrackSelector(2);
    setupVobSubTrackSelector(1);
    setupVobSubTrackSelector(2);
    setupSubtitleFontSizeControls(1);
    setupSubtitleFontSizeControls(2);
    restoreSubtitleFontScales();
    setSubtitleFontScale(1, subtitleFontScale1, { notify: false, broadcast: false });
    setSubtitleFontScale(2, subtitleFontScale2, { notify: false, broadcast: false });
    const player2ModeToggle = document.getElementById('player2ModeToggle');
    if (player2ModeToggle) {
        player2ModeToggle.addEventListener('click', (event) => handlePlayer2ModeToggleClick(event, 'settings1'));
    }
    const player2ModeToggle2 = document.getElementById('player2ModeToggle2');
    if (player2ModeToggle2) {
        player2ModeToggle2.addEventListener('click', (event) => handlePlayer2ModeToggleClick(event, 'settings2'));
    }

    // No CC buttons; subtitles default enabled

    // Play/pause buttons
    document.getElementById('playBtn1').addEventListener('click', () => togglePlay(video1, 'playBtn1'));
    document.getElementById('playBtn2').addEventListener('click', () => togglePlay(video2, 'playBtn2'));

    // Progress bars
    document.getElementById('progress1').addEventListener('click', (e) => seekVideo(e, video1, 'progress1'));
    document.getElementById('progress2').addEventListener('click', (e) => seekVideo(e, video2, 'progress2'));

    // Speed controls
    document.getElementById('speedSelect1').addEventListener('change', (e) => changeSpeed(video1, e.target.value));
    document.getElementById('speedSelect2').addEventListener('change', (e) => changeSpeed(video2, e.target.value));
    document.getElementById('speedDownBtn1').addEventListener('click', () => bumpSpeed(-1));
    document.getElementById('speedUpBtn1').addEventListener('click', () => bumpSpeed(+1));
    document.getElementById('speedDownBtn2').addEventListener('click', () => bumpSpeed(-1));
    document.getElementById('speedUpBtn2').addEventListener('click', () => bumpSpeed(+1));
    // Ensure both selects and playbackRates start in sync, using saved rate if available
    const s1 = document.getElementById('speedSelect1');
    const savedRateStr = lsGet(LS_KEYS.rate);
    const savedRate = savedRateStr ? parseFloat(savedRateStr) : NaN;
    const initialRate = Number.isFinite(savedRate)
        ? String(savedRate)
        : (s1 && s1.value) ? s1.value : '1';
    if (isPlayer2Window()) {
        try { video2.playbackRate = parseFloat(initialRate); } catch { }
        syncSpeedSelects(parseFloat(initialRate));
    } else {
        changeSpeed(video1, initialRate);
    }

    // Ensure any future metadata load applies the global rate
    ['loadedmetadata', 'emptied'].forEach(evt => {
        video1.addEventListener(evt, () => { try { video1.playbackRate = globalPlaybackRate; } catch { } }, { passive: true });
        video2.addEventListener(evt, () => { try { video2.playbackRate = globalPlaybackRate; } catch { } }, { passive: true });
    });

    // Volume controls
    document.getElementById('volumeSlider1').addEventListener('input', (e) => {
        changeVolume(video1, e.target.value, 'muteBtn1');
        const pct = Math.max(0, Math.min(1, parseFloat(e.target.value))) * 100;
        e.target.style.setProperty('--vol', pct + '%');
    });
    document.getElementById('volumeSlider2').addEventListener('input', (e) => {
        changeVolume(video2, e.target.value, 'muteBtn2');
        const pct = Math.max(0, Math.min(1, parseFloat(e.target.value))) * 100;
        e.target.style.setProperty('--vol', pct + '%');
        if (isPlayer2Window()) maybeBroadcastPlayer2State('volume-input');
    });
    document.getElementById('muteBtn1').addEventListener('click', () => toggleMute(video1, 'muteBtn1', 'volumeSlider1'));
    document.getElementById('muteBtn2').addEventListener('click', () => toggleMute(video2, 'muteBtn2', 'volumeSlider2'));
    // Fullscreen button (main controls, toggles app-wide fullscreen including overlay)
    const fsBtn = document.getElementById('fsBtnMain') || document.getElementById('fsBtn1');
    if (fsBtn) fsBtn.addEventListener('click', () => toggleFullscreen());
    // Hide any legacy fullscreen button in the left group if present
    const legacyFs = document.getElementById('fsBtn1');
    if (legacyFs && legacyFs !== fsBtn) legacyFs.style.display = 'none';
    const fsBtn2 = document.getElementById('fsBtn2');
    if (fsBtn2) fsBtn2.addEventListener('click', () => toggleFullscreen());

    // Double-click on main player toggles fullscreen (ignore clicks on controls)
    const mainContainer = document.getElementById('mainPlayer');
    if (mainContainer) {
        mainContainer.addEventListener('dblclick', (e) => {
            if (e.target.closest('.controls')) return;
            toggleFullscreen();
        });
        // Scroll wheel over main player adjusts volume of video1
        mainContainer.addEventListener('wheel', (e) => handleWheelVolume(e, video1, 'volumeSlider1', 'muteBtn1'), { passive: false });
    }

    // Initialize volume slider fills
    ['volumeSlider1', 'volumeSlider2'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const pct = Math.max(0, Math.min(1, parseFloat(el.value))) * 100;
            el.style.setProperty('--vol', pct + '%');
        }
    });

    // Swap buttons
    document.getElementById('swapBtn').addEventListener('click', swapVideos);
    const swapBtn2 = document.getElementById('swapBtn2');
    if (swapBtn2) swapBtn2.addEventListener('click', swapVideos);

    // Make overlay swap button use main button styling for visual parity
    if (swapBtn2) {
        swapBtn2.classList.remove('overlay-btn');
        swapBtn2.classList.add('control-btn');
    }

    // Scroll wheel over overlay player adjusts volume of video2
    const overlayContainer = document.getElementById('overlayPlayer');
    if (overlayContainer) {
        overlayContainer.addEventListener('wheel', (e) => handleWheelVolume(e, video2, 'volumeSlider2', 'muteBtn2'), { passive: false });
        overlayContainer.addEventListener('dblclick', (e) => {
            if (e.target.closest('.overlay-controls') || e.target.closest('.resize-handle')) return;
            toggleFullscreen();
        });
    }

    // Sync control (Set only)
    document.getElementById('setSyncBtn').addEventListener('click', async () => {
        if (isPlayer2Window()) {
            requestPlayer2SetSync();
            return;
        }
        await recordSetSyncPoint();
    });

    // Video events
    video1.addEventListener('timeupdate', () => {
        updateProgress(video1, 'progressBar1', 'timeDisplay1');
        updateSubtitles(1, video1.currentTime);
        schedulePersistElectronPlaybackSession();
    });
    video2.addEventListener('timeupdate', () => {
        updateProgress(video2, 'progressBar2', 'timeDisplay2');
        updateSubtitles(2, video2.currentTime);
        schedulePersistElectronPlaybackSession();
        if (isPlayer2Window()) maybeBroadcastPlayer2State('timeupdate');
    });
    // Keep play/pause icons in sync with state, even on programmatic play/pause
    video1.addEventListener('play', () => {
        const b = document.getElementById('playBtn1');
        if (b) b.textContent = '⏸';
        schedulePersistElectronPlaybackSession();
    });
    video1.addEventListener('pause', () => {
        const b = document.getElementById('playBtn1');
        if (b) b.textContent = '▶';
        schedulePersistElectronPlaybackSession(0);
    });
    video2.addEventListener('play', () => {
        const b = document.getElementById('playBtn2');
        if (b) b.textContent = '⏸';
        schedulePersistElectronPlaybackSession();
        if (isPlayer2Window()) maybeBroadcastPlayer2State('play');
    });
    video2.addEventListener('pause', () => {
        const b = document.getElementById('playBtn2');
        if (b) b.textContent = '▶';
        schedulePersistElectronPlaybackSession(0);
        if (isPlayer2Window()) maybeBroadcastPlayer2State('pause');
    });
    video2.addEventListener('loadedmetadata', () => {
        schedulePersistElectronPlaybackSession();
        if (isPlayer2Window()) {
            broadcastPlayer2Metadata('loadedmetadata');
            maybeBroadcastPlayer2State('loadedmetadata');
        }
    });
    video2.addEventListener('seeking', () => {
        if (isPlayer2Window()) maybeBroadcastPlayer2State('seeking');
    });
    video2.addEventListener('seeked', () => {
        schedulePersistElectronPlaybackSession(0);
        if (isPlayer2Window()) maybeBroadcastPlayer2State('seeked');
    });
    video2.addEventListener('volumechange', () => {
        if (isPlayer2Window()) handlePlayer2VolumeChange('volumechange');
    });
    video1.addEventListener('timeupdate', handleSync);

    // Keyboard controls (includes transform hotkeys for MAIN player)
    document.addEventListener('keydown', handleKeyboard);
    document.addEventListener('keyup', handleKeyboardKeyup);
    window.addEventListener('blur', stopFrameStepHold);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopFrameStepHold();
    });

    // Dragging functionality (restores saved overlay geometry)
    if (isMainWindow()) initializeDragging();

    // Inactivity handling (hide controls and cursor)
    setupInactivityHide();
    setupCtrlWheelZoom();

    // Restore saved transforms (if any), then ensure they are applied
    (function restoreTf() {
        const keys = ['zoom', 'stretchX', 'stretchY', 'flipX', 'flipY', 'rot', 'tx', 'ty'];

        // Restore video1 transform
        const data1 = lsGet(LS_KEYS.video1Tf);
        if (data1) {
            try {
                const obj = JSON.parse(data1);
                let ok = true;
                keys.forEach(k => { if (typeof obj[k] !== 'number') ok = false; });
                if (ok) tf1 = obj;
            } catch { }
        }

        // Restore video2 transform
        const data2 = lsGet(LS_KEYS.video2Tf);
        if (data2) {
            try {
                const obj = JSON.parse(data2);
                let ok = true;
                keys.forEach(k => { if (typeof obj[k] !== 'number') ok = false; });
                if (ok) tf2 = obj;
            } catch { }
        }
    })();
    applyTransform(1);  // Apply video1 transform
    applyTransform(2);  // Apply video2 transform

    // Initial subtitle update to honor default enabled state
    updateSubtitles(1, video1.currentTime || 0);
    updateSubtitles(2, video2.currentTime || 0);

    // Initialize fullscreen button state
    updateFullscreenButtons();

    // Restore last selected local files (Electron only)
    if (isPlayer2Window()) {
        maybeBroadcastPlayer2State('ready-init');
    } else {
        await restoreLastPlayedVideos();
        await restoreLastPlayedSubtitles();
        await restoreElectronPlaybackSession();
    }

    if (isMainWindow()) {
        window.addEventListener('beforeunload', () => {
            persistElectronPlaybackSessionNow();
        });
    }
}

function setupCtrlWheelZoom() {
    if (!electronAPI) return;

    electronAPI.getZoomFactor()
        .then((v) => {
            const n = Number(v);
            if (Number.isFinite(n)) electronZoomFactor = n;
        })
        .catch(() => { });

    document.addEventListener('wheel', (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();

        const step = event.deltaY < 0 ? 1.1 : (1 / 1.1);
        electronZoomFactor = Math.max(0.25, Math.min(3, electronZoomFactor * step));
        electronAPI.setZoomFactor(electronZoomFactor).catch(() => { });
    }, { passive: false });
}

function adjustElectronZoom(multiplier) {
    if (!electronAPI) return;
    electronZoomFactor = Math.max(0.25, Math.min(3, electronZoomFactor * multiplier));
    electronAPI.setZoomFactor(electronZoomFactor).catch(() => { });
}

function resetElectronZoom() {
    if (!electronAPI) return;
    electronZoomFactor = 1;
    electronAPI.setZoomFactor(1).catch(() => { });
}

// Wheel-based volume control for a specific player
// Finer wheel increments; sliders now step 0.001
function handleWheelVolume(event, video, sliderId, muteBtnId) {
    // Avoid interfering with pinch-zoom or modified scrolls
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    const slider = document.getElementById(sliderId);
    if (!slider) return;
    const dir = event.deltaY < 0 ? 1 : -1; // up increases, down decreases
    const current = Math.max(0, Math.min(1, parseFloat(slider.value)));

    // Dynamic step size: finer control at low volume
    // If current volume is < 0.1, use very fine steps (0.002)
    // Otherwise use fine steps (0.01)
    const step = current < 0.1 ? 0.002 : 0.01;
    
    let next = current + dir * step;
    
    // Snap to 3 decimal places to align with slider step of 0.001
    next = Math.max(0, Math.min(1, Math.round(next * 1000) / 1000));
    
    if (next === current) return;
    // Changing volume should unmute
    if (video.muted && next > 0) video.muted = false;
    slider.value = next.toFixed(3);
    // Keep slider fill in sync
    slider.style.setProperty('--vol', (next * 100) + '%');
    // Update video volume and icon
    changeVolume(video, next, muteBtnId);
}

function toggleFullscreen() {
    try {
        const root = document.documentElement;
        const isFs = !!document.fullscreenElement;
        if (isFs) {
            if (document.exitFullscreen) document.exitFullscreen();
        } else {
            if (root.requestFullscreen) root.requestFullscreen();
        }
    } catch (e) {
        console.error('Fullscreen error:', e);
    }
}

function updateFullscreenButtons() {
    const fs1 = document.getElementById('fsBtnMain') || document.getElementById('fsBtn1');
    if (fs1) fs1.textContent = String.fromCharCode(0x26F6); // keep icon constant
    const fs2 = document.getElementById('fsBtn2');
    if (fs2) fs2.textContent = String.fromCharCode(0x26F6);
}

document.addEventListener('fullscreenchange', updateFullscreenButtons);

function normalizeSubtitleFontScale(scale) {
    if (scale === null || scale === undefined || scale === '') return 1;
    const n = Number(scale);
    if (!Number.isFinite(n)) return 1;
    return Math.round(Math.max(SUBTITLE_FONT_SCALE_MIN, n) * 10) / 10;
}

function updateSubtitleFontScaleUI(playerNum) {
    const scale = playerNum === 1 ? subtitleFontScale1 : subtitleFontScale2;
    const value = document.getElementById(`subtitleSizeValue${playerNum}`);
    const downBtn = document.getElementById(`subtitleSizeDown${playerNum}`);
    if (value) value.textContent = `${Math.round(scale * 100)}%`;
    if (downBtn) downBtn.disabled = scale <= SUBTITLE_FONT_SCALE_MIN;
}

function setSubtitleFontScale(playerNum, scale, options = {}) {
    const nextScale = normalizeSubtitleFontScale(scale);
    const display = document.getElementById(playerNum === 1 ? 'subtitle1Display' : 'subtitle2Display');

    if (playerNum === 1) {
        subtitleFontScale1 = nextScale;
    } else {
        subtitleFontScale2 = nextScale;
    }

    if (display) display.style.setProperty('--subtitle-font-scale', String(nextScale));
    applyVobSubDisplaySettings(playerNum);
    updateSubtitleFontScaleUI(playerNum);
    lsSet(playerNum === 1 ? LS_KEYS.subtitleFontScale1 : LS_KEYS.subtitleFontScale2, String(nextScale));

    if (options.notify) {
        showControlNotification(`Subtitle ${playerNum} size ${Math.round(nextScale * 100)}%`);
    }

    if (playerNum === 2 && options.broadcast !== false) {
        if (isMainWindow() && isElectronWindowMode()) {
            mergeRemotePlayer2State({ subtitleFontScale: nextScale });
            dispatchToPeer({ type: 'player2-subtitle-font-scale', scale: nextScale });
        } else {
            maybeBroadcastPlayer2State('subtitle-font-scale');
        }
    }
}

function adjustSubtitleFontScale(playerNum, direction) {
    const current = playerNum === 1 ? subtitleFontScale1 : subtitleFontScale2;
    setSubtitleFontScale(playerNum, current + (direction * SUBTITLE_FONT_SCALE_STEP), { notify: true });
}

function setupSubtitleFontSizeControls(playerNum) {
    const downBtn = document.getElementById(`subtitleSizeDown${playerNum}`);
    const upBtn = document.getElementById(`subtitleSizeUp${playerNum}`);
    const bind = (button, direction) => {
        if (!button) return;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            adjustSubtitleFontScale(playerNum, direction);
        });
    };
    bind(downBtn, -1);
    bind(upBtn, 1);
    updateSubtitleFontScaleUI(playerNum);
}

function restoreSubtitleFontScales() {
    const saved1 = normalizeSubtitleFontScale(lsGet(LS_KEYS.subtitleFontScale1));
    const saved2 = normalizeSubtitleFontScale(lsGet(LS_KEYS.subtitleFontScale2));
    subtitleFontScale1 = saved1;
    subtitleFontScale2 = saved2;
}

function setupDropdown(id) {
    const dropdown = document.getElementById(`settings${id}`);
    if (!dropdown) return;
    const toggle = document.getElementById(`settingsToggle${id}`);
    const ccItem = document.getElementById(`ccToggle${id}`);

    // Interactive controls inside the menu must not reach the document-level
    // click handler, or native selects immediately lose their open menu.
    dropdown.querySelector('.dropdown-menu')?.addEventListener('click', (event) => {
        event.stopPropagation();
    });

    const closeAll = () => {
        document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
    };

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        closeAll();
        if (!isOpen) dropdown.classList.add('open');
    });

    if (ccItem) {
        ccItem.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSubtitles(id === '1' ? 1 : 2);
            dropdown.classList.remove('open');
        });
    }

    document.addEventListener('click', closeAll);
}

// Hide controls and cursor when the mouse leaves the page,
// and after 1s of no mouse movement while on the page
function setupInactivityHide() {
    const IDLE_MS = 1000;
    let inactivityTimer = null;

    const root = document.body;

    const showControls = () => {
        root.classList.remove('idle');
    };

    const hideControls = () => {
        root.classList.add('idle');
    };

    const resetTimer = () => {
        showControls();
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(hideControls, IDLE_MS);
    };

    revealPlayerControls = resetTimer;

    // Mouse/pointer movement resets the timer
    document.addEventListener('mousemove', resetTimer, { passive: true });
    document.addEventListener('pointermove', resetTimer, { passive: true });
    document.addEventListener('mousedown', resetTimer, { passive: true });
    document.addEventListener('touchstart', resetTimer, { passive: true });
    document.addEventListener('touchmove', resetTimer, { passive: true });

    // Immediately hide when the cursor leaves the page/window,
    // and show/reset when it enters or window regains focus
    document.addEventListener('mouseleave', hideControls, { passive: true });
    document.addEventListener('mouseenter', resetTimer, { passive: true });
    window.addEventListener('blur', hideControls, { passive: true });
    window.addEventListener('focus', resetTimer, { passive: true });

    // Start in non-idle state, then schedule initial hide
    resetTimer();
}

function setupElectronFilePickers() {
    if (!electronAPI) return;

    const video1Label = document.getElementById('chooseVideo1Label');
    const video2Label = document.getElementById('chooseVideo2Label');
    const subtitle1Label = document.querySelector('label[for="subtitle1"]');
    const subtitle2Label = document.querySelector('label[for="subtitle2"]');

    if (video1Label) {
        video1Label.addEventListener('click', async (event) => {
            event.preventDefault();
            await openVideoFromDialog(video1, VIDEO_PLAYER_IDS.video1);
        });
    }

    if (video2Label) {
        video2Label.addEventListener('click', async (event) => {
            event.preventDefault();
            await openVideoFromDialog(video2, VIDEO_PLAYER_IDS.video2);
        });
    }

    if (subtitle1Label) {
        subtitle1Label.addEventListener('click', async (event) => {
            event.preventDefault();
            await openSubtitleFromDialog(1);
            document.getElementById('settings1')?.classList.remove('open');
        });
    }

    if (subtitle2Label) {
        subtitle2Label.addEventListener('click', async (event) => {
            event.preventDefault();
            await openSubtitleFromDialog(2);
            document.getElementById('settings2')?.classList.remove('open');
        });
    }
}

async function openVideoFromDialog(video, playerId) {
    if (!electronAPI) return;
    try {
        const selected = await electronAPI.openVideoFile(playerId);
        if (!selected || !selected.path || !selected.fileUrl) return;
        applyVideoMetadata(playerId, selected, { notifyOnFailure: true });
        await loadVideoFromSource(video, selected.fileUrl, playerId, selected.path, { skipMetadataProbe: true });
        const selectedAudioTrack = prepareAudioTracks(playerId, selected, selected.path);
        configureAudioTrack(playerId, selectedAudioTrack, selected.path);
        const selectedVobSubTrack = prepareVobSubTracks(playerId, selected, selected.path);
        if (selectedVobSubTrack) {
            await clearSubtitlesForPlayer(getPlayerNumFromPlayerId(playerId));
            configureVobSubTrack(playerId, selectedVobSubTrack, selected.path);
        } else {
            configureVobSubTrack(playerId, null, selected.path);
            await autoLoadSubtitleForVideo(playerId, selected.path);
        }
    } catch (error) {
        console.error('Could not open video:', error);
    }
}

function getAvailableVobSubTracks(playerNum) {
    return playerNum === 1 ? vobSubTracks1 : vobSubTracks2;
}

function formatVobSubLanguage(language) {
    const code = String(language || '').trim().toLowerCase();
    const names = {
        eng: 'English', en: 'English', jpn: 'Japanese', ja: 'Japanese',
        spa: 'Spanish', es: 'Spanish', fra: 'French', fre: 'French', fr: 'French',
        deu: 'German', ger: 'German', de: 'German', ita: 'Italian', it: 'Italian',
        por: 'Portuguese', pt: 'Portuguese', und: 'Unknown language'
    };
    return names[code] || (code ? code.toUpperCase() : 'Unknown language');
}

function getAvailableAudioTracks(playerNum) {
    return playerNum === 1 ? audioTracks1 : audioTracks2;
}

function getDynamicAudioPlayer(playerNum) {
    return playerNum === 1 ? dynamicAudioPlayer1 : dynamicAudioPlayer2;
}

function formatAudioCodec(track) {
    const codec = String(track?.codec || '').trim().toLowerCase();
    const profile = String(track?.profile || '').trim();
    if (profile && profile.toLowerCase() !== 'unknown') return profile;
    const names = {
        ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', dca: 'DTS',
        truehd: 'TrueHD', aac: 'AAC', opus: 'Opus', flac: 'FLAC',
        mp3: 'MP3', vorbis: 'Vorbis'
    };
    return names[codec] || codec.toUpperCase() || 'Audio';
}

function formatAudioTrackLabel(track, index) {
    const language = formatVobSubLanguage(track.language);
    const title = String(track.title || '').trim();
    const codec = formatAudioCodec(track);
    const channels = Number.isInteger(Number(track.channels)) ? `${Number(track.channels)} ch` : '';
    const flags = track.default ? ['default'] : [];
    const name = title && title.toLowerCase() !== language.toLowerCase()
        ? `${language} — ${title}`
        : (title || language);
    const technical = [codec, channels].filter(Boolean).join(', ');
    return `${index + 1}. ${name}${technical ? ` · ${technical}` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

function setAudioLoadStatus(playerNum, state, message) {
    const status = document.getElementById(`audioTrackStatus${playerNum}`);
    const indicator = document.getElementById(`audioIndicator${playerNum}`);
    const indicatorText = document.getElementById(`audioIndicatorText${playerNum}`);
    if (status) {
        status.dataset.state = state || '';
        status.textContent = message || '';
    }
    if (!indicator) return;
    indicator.dataset.state = state || '';
    if (indicatorText) indicatorText.textContent = message || '';
    indicator.hidden = state !== 'loading' && state !== 'error';
}

function setAvailableAudioTracks(playerNum, tracks, selectedTrack) {
    const seen = new Set();
    const normalized = (Array.isArray(tracks) ? tracks : [])
        .filter((track) => track && Number.isInteger(Number(track.streamIndex)))
        .map((track) => ({ ...track, streamIndex: Number(track.streamIndex) }))
        .filter((track) => {
            if (seen.has(track.streamIndex)) return false;
            seen.add(track.streamIndex);
            return true;
        });
    if (playerNum === 1) {
        audioTracks1 = normalized;
    } else {
        audioTracks2 = normalized;
    }

    const row = document.getElementById(`audioTrackRow${playerNum}`);
    const select = document.getElementById(`audioTrackSelect${playerNum}`);
    if (row) row.hidden = normalized.length === 0;
    if (!select) return;
    select.replaceChildren();
    const original = document.createElement('option');
    original.value = '';
    original.textContent = 'Original/default audio';
    select.appendChild(original);
    normalized.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = String(track.streamIndex);
        option.textContent = formatAudioTrackLabel(track, index);
        select.appendChild(option);
    });
    select.value = selectedTrack ? String(selectedTrack.streamIndex) : '';
    if (normalized.length === 0) setAudioLoadStatus(playerNum, '', '');
}

function getStoredAudioChoice(playerNum, filePath, tracks) {
    const key = playerNum === 1 ? LS_KEYS.audioChoice1 : LS_KEYS.audioChoice2;
    try {
        const stored = JSON.parse(lsGet(key) || 'null');
        const choices = Array.isArray(stored) ? stored : (stored?.filePath ? [stored] : []);
        const choice = choices.find((candidate) => candidate?.filePath === filePath && Object.prototype.hasOwnProperty.call(candidate, 'streamIndex'));
        if (!choice) return { found: false, track: null };
        if (choice.streamIndex === null) return { found: true, track: null };
        const match = tracks.find((track) => Number(track.streamIndex) === Number(choice.streamIndex));
        return match ? { found: true, track: match } : { found: false, track: null };
    } catch {
        return { found: false, track: null };
    }
}

function persistAudioChoice(playerNum, filePath, track) {
    if (!filePath) return;
    const key = playerNum === 1 ? LS_KEYS.audioChoice1 : LS_KEYS.audioChoice2;
    let choices = [];
    try {
        const stored = JSON.parse(lsGet(key) || 'null');
        choices = Array.isArray(stored) ? stored : (stored?.filePath ? [stored] : []);
    } catch { }
    choices = [
        { filePath, streamIndex: track ? Number(track.streamIndex) : null },
        ...choices.filter((candidate) => candidate?.filePath !== filePath)
    ].slice(0, 50);
    lsSet(key, JSON.stringify(choices));
}

function prepareAudioTracks(playerId, metadata, filePath) {
    const playerNum = getPlayerNumFromPlayerId(playerId);
    const tracks = Array.isArray(metadata?.audioTracks) ? metadata.audioTracks : [];
    const stored = getStoredAudioChoice(playerNum, filePath, tracks);
    const selected = stored.found ? stored.track : (metadata?.selectedAudioTrack || null);
    setAvailableAudioTracks(playerNum, tracks, selected);
    return selected;
}

function setAudioTrack(playerNum, track) {
    const next = track && Number.isInteger(Number(track.streamIndex))
        ? { ...track, streamIndex: Number(track.streamIndex) }
        : null;
    if (playerNum === 1) {
        audioTrack1 = next;
    } else {
        audioTrack2 = next;
    }
    const select = document.getElementById(`audioTrackSelect${playerNum}`);
    if (select) select.value = next ? String(next.streamIndex) : '';
    return next;
}

function configureAudioTrack(playerId, track, filePath) {
    const playerNum = getPlayerNumFromPlayerId(playerId);
    const next = setAudioTrack(playerNum, track);
    if (playerNum === 2 && isMainWindow() && isElectronWindowMode()) {
        getDynamicAudioPlayer(2)?.setTrack(null, null).catch(() => { });
        mergeRemotePlayer2State({ audioTrack: next, audioTracks: [...audioTracks2] });
        sendHydrateToPlayer2Window();
        return;
    }
    const player = getDynamicAudioPlayer(playerNum);
    if (!player) {
        if (next) setAudioLoadStatus(playerNum, 'error', 'Audio converter unavailable');
        return;
    }
    player.setTrack(next, filePath).catch((error) => {
        console.error('Could not configure converted audio:', error);
        setAudioLoadStatus(playerNum, 'error', 'Could not load the selected audio track');
    });
}

async function selectAudioTrackForPlayer(playerNum, streamIndex) {
    const tracks = getAvailableAudioTracks(playerNum);
    const track = streamIndex === null || streamIndex === ''
        ? null
        : tracks.find((candidate) => Number(candidate.streamIndex) === Number(streamIndex)) || null;
    const filePath = playerNum === 1 ? lastVideoPath1 : lastVideoPath2;
    persistAudioChoice(playerNum, filePath, track);
    configureAudioTrack(playerNum === 1 ? VIDEO_PLAYER_IDS.video1 : VIDEO_PLAYER_IDS.video2, track, filePath);
    maybeBroadcastPlayer2State('audio-track');
    return track;
}

function setupAudioTrackSelector(playerNum) {
    const select = document.getElementById(`audioTrackSelect${playerNum}`);
    if (!select) return;
    select.addEventListener('change', () => {
        selectAudioTrackForPlayer(playerNum, select.value).catch((error) => {
            console.error('Could not switch audio track:', error);
            setAudioLoadStatus(playerNum, 'error', 'Could not switch embedded audio track');
        });
    });
}

function ensureDynamicAudioPlayers() {
    if (!electronAPI || typeof window.DynamicAudioPlayer !== 'function') return;
    if (!dynamicAudioPlayer1) {
        dynamicAudioPlayer1 = new window.DynamicAudioPlayer({
            video: video1,
            electronAPI,
            onStatus: (state, message) => setAudioLoadStatus(1, state, message)
        });
    }
    if (!dynamicAudioPlayer2) {
        dynamicAudioPlayer2 = new window.DynamicAudioPlayer({
            video: video2,
            electronAPI,
            onStatus: (state, message) => setAudioLoadStatus(2, state, message)
        });
    }
}

function setPlayerVolume(playerNum, value) {
    const video = playerNum === 1 ? video1 : video2;
    const player = getDynamicAudioPlayer(playerNum);
    if (player) {
        player.setVolume(value);
    } else {
        video.volume = value;
    }
}

function getPlayerMuted(playerNum) {
    const player = getDynamicAudioPlayer(playerNum);
    const video = playerNum === 1 ? video1 : video2;
    return player ? player.getMuted() : !!video.muted;
}

function setPlayerMuted(playerNum, muted) {
    const player = getDynamicAudioPlayer(playerNum);
    const video = playerNum === 1 ? video1 : video2;
    if (player) {
        player.setMuted(muted);
    } else {
        video.muted = !!muted;
    }
}

function formatVobSubTrackLabel(track, index) {
    const language = formatVobSubLanguage(track.language);
    const title = String(track.title || '').trim();
    const flags = [track.forced ? 'forced' : '', track.default ? 'default' : ''].filter(Boolean);
    const details = title && title.toLowerCase() !== language.toLowerCase() ? `${language} — ${title}` : (title || language);
    const format = track.renderer === 'ass'
        ? (String(track.codec).toLowerCase() === 'ssa' ? 'SSA' : 'ASS')
        : 'VobSub';
    return `${index + 1}. ${details} · ${format}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

function setVobSubLoadStatus(playerNum, state, message) {
    const status = document.getElementById(`vobSubTrackStatus${playerNum}`);
    const indicator = document.getElementById(`vobSubIndicator${playerNum}`);
    const indicatorText = document.getElementById(`vobSubIndicatorText${playerNum}`);
    if (status) {
        status.dataset.state = state || '';
        status.textContent = message || '';
    }
    if (!indicator) return;
    indicator.dataset.state = state || '';
    if (indicatorText) indicatorText.textContent = message || '';
    indicator.hidden = state !== 'loading' && state !== 'error';
}

function setAvailableVobSubTracks(playerNum, tracks, selectedTrack) {
    const normalized = (Array.isArray(tracks) ? tracks : [])
        .filter((track) => track && Number.isInteger(Number(track.streamIndex)))
        .map((track) => ({ ...track, streamIndex: Number(track.streamIndex) }));
    if (playerNum === 1) {
        vobSubTracks1 = normalized;
    } else {
        vobSubTracks2 = normalized;
    }

    const row = document.getElementById(`vobSubTrackRow${playerNum}`);
    const select = document.getElementById(`vobSubTrackSelect${playerNum}`);
    if (row) row.hidden = normalized.length === 0;
    if (!select) return;
    select.replaceChildren();
    const off = document.createElement('option');
    off.value = '';
    off.textContent = 'Off';
    select.appendChild(off);
    normalized.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = String(track.streamIndex);
        option.textContent = formatVobSubTrackLabel(track, index);
        select.appendChild(option);
    });
    select.value = selectedTrack ? String(selectedTrack.streamIndex) : '';
    if (normalized.length === 0) setVobSubLoadStatus(playerNum, '', '');
}

function getStoredVobSubChoice(playerNum, filePath, tracks) {
    const key = playerNum === 1 ? LS_KEYS.vobSubChoice1 : LS_KEYS.vobSubChoice2;
    try {
        const stored = JSON.parse(lsGet(key) || 'null');
        const choices = Array.isArray(stored) ? stored : (stored?.filePath ? [stored] : []);
        const choice = choices.find((candidate) => candidate?.filePath === filePath && Object.prototype.hasOwnProperty.call(candidate, 'streamIndex'));
        if (!choice) return { found: false, track: null };
        if (choice.streamIndex === null) return { found: true, track: null };
        const match = tracks.find((track) => Number(track.streamIndex) === Number(choice.streamIndex));
        return match ? { found: true, track: match } : { found: false, track: null };
    } catch {
        return { found: false, track: null };
    }
}

function persistVobSubChoice(playerNum, filePath, track) {
    if (!filePath) return;
    const key = playerNum === 1 ? LS_KEYS.vobSubChoice1 : LS_KEYS.vobSubChoice2;
    let choices = [];
    try {
        const stored = JSON.parse(lsGet(key) || 'null');
        choices = Array.isArray(stored) ? stored : (stored?.filePath ? [stored] : []);
    } catch { }
    choices = [
        { filePath, streamIndex: track ? Number(track.streamIndex) : null },
        ...choices.filter((candidate) => candidate?.filePath !== filePath)
    ].slice(0, 50);
    lsSet(key, JSON.stringify(choices));
}

function prepareVobSubTracks(playerId, metadata, filePath) {
    const playerNum = getPlayerNumFromPlayerId(playerId);
    const tracks = Array.isArray(metadata?.vobSubTracks) ? metadata.vobSubTracks : [];
    const stored = getStoredVobSubChoice(playerNum, filePath, tracks);
    const selected = stored.found ? stored.track : (metadata?.selectedVobSubTrack || null);
    setAvailableVobSubTracks(playerNum, tracks, selected);
    return selected;
}

async function selectVobSubTrackForPlayer(playerNum, streamIndex) {
    const tracks = getAvailableVobSubTracks(playerNum);
    const track = streamIndex === null || streamIndex === ''
        ? null
        : tracks.find((candidate) => Number(candidate.streamIndex) === Number(streamIndex)) || null;
    const filePath = playerNum === 1 ? lastVideoPath1 : lastVideoPath2;
    persistVobSubChoice(playerNum, filePath, track);
    const externalAss = playerNum === 1 ? externalAssSubtitle1 : externalAssSubtitle2;
    if (!track && externalAss) return null;
    if (track) await clearSubtitlesForPlayer(playerNum);
    configureVobSubTrack(playerNum === 1 ? VIDEO_PLAYER_IDS.video1 : VIDEO_PLAYER_IDS.video2, track, filePath);
    maybeBroadcastPlayer2State('vobsub-track');
    return track;
}

function setupVobSubTrackSelector(playerNum) {
    const select = document.getElementById(`vobSubTrackSelect${playerNum}`);
    if (!select) return;
    select.addEventListener('change', () => {
        selectVobSubTrackForPlayer(playerNum, select.value).catch((error) => {
            console.error('Could not switch VobSub track:', error);
            setVobSubLoadStatus(playerNum, 'error', 'Could not switch embedded subtitle track');
        });
    });
}

function getVobSubRenderer(playerNum) {
    return playerNum === 1 ? vobSubRenderer1 : vobSubRenderer2;
}

function setVobSubRenderer(playerNum, renderer) {
    if (playerNum === 1) {
        vobSubRenderer1 = renderer;
    } else {
        vobSubRenderer2 = renderer;
    }
}

function disposeVobSubRenderer(playerNum) {
    if (playerNum === 1) {
        vobSubLoadGeneration1 += 1;
    } else {
        vobSubLoadGeneration2 += 1;
    }
    const renderer = getVobSubRenderer(playerNum);
    if (renderer && typeof renderer.dispose === 'function') {
        try { renderer.dispose(); } catch { }
    }
    setVobSubRenderer(playerNum, null);
}

function getVobSubTrack(playerNum) {
    return playerNum === 1 ? vobSubTrack1 : vobSubTrack2;
}

function setVobSubTrack(playerNum, track) {
    const next = track && Number.isInteger(Number(track.streamIndex)) ? { ...track, streamIndex: Number(track.streamIndex) } : null;
    if (playerNum === 1) {
        vobSubTrack1 = next;
    } else {
        vobSubTrack2 = next;
    }
    const select = document.getElementById(`vobSubTrackSelect${playerNum}`);
    if (select) select.value = next ? String(next.streamIndex) : '';
    return next;
}

function getVobSubModule() {
    if (window.bitmapSubtitleAPI) return Promise.resolve(window.bitmapSubtitleAPI);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The bitmap subtitle renderer did not load.')), 10000);
        window.addEventListener('bitmap-subtitles-ready', () => {
            clearTimeout(timeout);
            resolve(window.bitmapSubtitleAPI);
        }, { once: true });
    });
}

function getAssSubtitleModule() {
    if (window.assSubtitleAPI) return Promise.resolve(window.assSubtitleAPI);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The ASS subtitle renderer did not load.')), 10000);
        window.addEventListener('ass-subtitles-ready', () => {
            clearTimeout(timeout);
            resolve(window.assSubtitleAPI);
        }, { once: true });
    });
}

function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return null;
}

function syncVobSubRendererTransform(playerNum) {
    const renderer = getVobSubRenderer(playerNum);
    const video = playerNum === 1 ? video1 : video2;
    const canvas = renderer?.canvas;
    if (!canvas || !video) return;
    canvas.classList.add('bitmap-subtitle-canvas');
}

function applyVobSubDisplaySettings(playerNum) {
    const renderer = getVobSubRenderer(playerNum);
    if (!renderer || typeof renderer.setDisplaySettings !== 'function') return;
    const enabled = playerNum === 1 ? subtitlesEnabled1 : subtitlesEnabled2;
    const scale = playerNum === 1 ? subtitleFontScale1 : subtitleFontScale2;
    renderer.setDisplaySettings({
        scale: Math.max(0.1, Math.min(3, scale)),
        opacity: enabled ? 1 : 0
    });
}

async function loadVobSubRenderer(playerNum, track, filePath) {
    disposeVobSubRenderer(playerNum);
    const generation = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
    const loadEmbeddedTrack = electronAPI?.loadEmbeddedSubtitleTrack || electronAPI?.loadVobSubTrack;
    if (!electronAPI || !track || !filePath || typeof loadEmbeddedTrack !== 'function') {
        setVobSubLoadStatus(playerNum, track ? 'error' : 'off', track ? 'Embedded subtitle loader unavailable' : 'Embedded subtitles off');
        return;
    }

    const expectedStreamIndex = Number(track.streamIndex);
    const expectedPath = filePath;
    const trackIndex = getAvailableVobSubTracks(playerNum).findIndex((candidate) => candidate.streamIndex === expectedStreamIndex);
    const trackLabel = formatVobSubTrackLabel(track, Math.max(0, trackIndex));
    setVobSubLoadStatus(playerNum, 'loading', `Loading ${trackLabel}…`);
    try {
        const isAss = track.renderer === 'ass';
        const [moduleApi, payload] = await Promise.all([
            isAss ? getAssSubtitleModule() : getVobSubModule(),
            loadEmbeddedTrack(filePath, expectedStreamIndex)
        ]);
        if (moduleApi.ready) await moduleApi.ready;
        const currentGeneration = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
        const currentPath = playerNum === 1 ? lastVideoPath1 : lastVideoPath2;
        const currentTrack = getVobSubTrack(playerNum);
        if (currentGeneration !== generation || currentPath !== expectedPath || Number(currentTrack?.streamIndex) !== expectedStreamIndex) return;

        const subContent = isAss ? String(payload?.content || '') : toArrayBuffer(payload?.content);
        if (!subContent || (typeof subContent === 'string' && !subContent.trim())) {
            throw new Error('The extracted embedded subtitle track was empty.');
        }
        const videoElement = playerNum === 1 ? video1 : video2;
        const renderer = moduleApi.createRenderer({
            video: videoElement,
            subContent,
            fileName: payload.fileName || (isAss ? 'track.ass' : 'track.mks'),
            fonts: Array.isArray(payload?.fonts) ? payload.fonts : [],
            cacheLimit: 48,
            prefetchWindow: { before: 1, after: 2 },
            displaySettings: {
                scale: Math.max(0.1, Math.min(3, playerNum === 1 ? subtitleFontScale1 : subtitleFontScale2)),
                opacity: (playerNum === 1 ? subtitlesEnabled1 : subtitlesEnabled2) ? 1 : 0
            },
            onEvent: (event) => {
                const activeGeneration = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
                if (activeGeneration !== generation) return;
                if (event.type === 'loaded') {
                    syncVobSubRendererTransform(playerNum);
                    const language = track.language && track.language !== 'und' ? ` (${track.language})` : '';
                    setVobSubLoadStatus(playerNum, 'ready', `Ready: ${trackLabel}`);
                    showControlNotification(`${isAss ? 'ASS' : 'VobSub'}${language} ready`);
                } else if (event.type === 'error') {
                    console.error('Embedded subtitle renderer error:', event.error);
                    setVobSubLoadStatus(playerNum, 'error', `Could not load ${trackLabel}`);
                }
            }
        });
        setVobSubRenderer(playerNum, renderer);
    } catch (error) {
        const activeGeneration = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
        if (activeGeneration !== generation) return;
        console.error('Could not load embedded subtitle:', error);
        setVobSubLoadStatus(playerNum, 'error', `Could not load ${trackLabel}`);
        showControlNotification(`Could not load subtitles ${playerNum}`);
    }
}

function configureVobSubTrack(playerId, track, filePath) {
    const playerNum = getPlayerNumFromPlayerId(playerId);
    const previous = getVobSubTrack(playerNum);
    const next = setVobSubTrack(playerNum, track);
    if (playerNum === 2 && isMainWindow() && isElectronWindowMode()) {
        disposeVobSubRenderer(2);
        mergeRemotePlayer2State({ vobSubTrack: next, vobSubTracks: [...vobSubTracks2] });
        sendHydrateToPlayer2Window();
        return;
    }
    if (getVobSubRenderer(playerNum)
        && Number(previous?.streamIndex) === Number(next?.streamIndex)
        && (playerNum === 1 ? lastVideoPath1 : lastVideoPath2) === filePath) {
        applyVobSubDisplaySettings(playerNum);
        return;
    }
    loadVobSubRenderer(playerNum, next, filePath);
}

async function restoreLastPlayedVideos() {
    if (!electronAPI) return;
    try {
        const [last1, last2] = await Promise.all([
            electronAPI.getLastVideo(VIDEO_PLAYER_IDS.video1),
            electronAPI.getLastVideo(VIDEO_PLAYER_IDS.video2)
        ]);

        if (last1 && last1.fileUrl && isMainWindow()) {
            applyVideoMetadata(VIDEO_PLAYER_IDS.video1, last1);
            await loadVideoFromSource(video1, last1.fileUrl, VIDEO_PLAYER_IDS.video1, last1.path, { persist: false, clearSubtitles: false, skipMetadataProbe: true });
            const selectedAudioTrack = prepareAudioTracks(VIDEO_PLAYER_IDS.video1, last1, last1.path);
            configureAudioTrack(VIDEO_PLAYER_IDS.video1, selectedAudioTrack, last1.path);
            const selectedVobSubTrack = prepareVobSubTracks(VIDEO_PLAYER_IDS.video1, last1, last1.path);
            configureVobSubTrack(VIDEO_PLAYER_IDS.video1, selectedVobSubTrack, last1.path);
            if (!selectedVobSubTrack) {
                await autoLoadSubtitleForVideo(VIDEO_PLAYER_IDS.video1, last1.path, { persist: false, skipIfExisting: true });
            }
        }
        if (last2 && last2.fileUrl) {
            applyVideoMetadata(VIDEO_PLAYER_IDS.video2, last2);
            const selectedAudioTrack = prepareAudioTracks(VIDEO_PLAYER_IDS.video2, last2, last2.path);
            setAudioTrack(2, selectedAudioTrack);
            const selectedVobSubTrack = prepareVobSubTracks(VIDEO_PLAYER_IDS.video2, last2, last2.path);
            setVobSubTrack(2, selectedVobSubTrack);
            if (isElectronWindowMode()) {
                remotePlayer2State = mergeRemotePlayer2State({
                    src: last2.fileUrl,
                    filePath: last2.path,
                    playbackRate: globalPlaybackRate,
                    paused: true,
                    audioTrack: selectedAudioTrack,
                    audioTracks: [...audioTracks2],
                    vobSubTrack: selectedVobSubTrack,
                    vobSubTracks: [...vobSubTracks2]
                });
                if (!selectedVobSubTrack) {
                    await autoLoadSubtitleForVideo(VIDEO_PLAYER_IDS.video2, last2.path, { persist: false, skipIfExisting: true });
                }
                pendingPlayer2Hydration = true;
                if (player2WindowOpen) sendHydrateToPlayer2Window();
                schedulePersistElectronPlaybackSession();
                return;
            }
            await loadVideoFromSource(video2, last2.fileUrl, VIDEO_PLAYER_IDS.video2, last2.path, { persist: false, clearSubtitles: false, skipMetadataProbe: true });
            configureAudioTrack(VIDEO_PLAYER_IDS.video2, selectedAudioTrack, last2.path);
            configureVobSubTrack(VIDEO_PLAYER_IDS.video2, selectedVobSubTrack, last2.path);
            if (!selectedVobSubTrack) {
                await autoLoadSubtitleForVideo(VIDEO_PLAYER_IDS.video2, last2.path, { persist: false, skipIfExisting: true });
            }
        }
    } catch {
        // no-op: app still works without restoring prior files
    }
}

function getPlayerNumFromPlayerId(playerId) {
    return playerId === VIDEO_PLAYER_IDS.video1 ? 1 : 2;
}

function hasSubtitleForPlayer(playerNum) {
    const subtitles = playerNum === 1 ? subtitles1 : subtitles2;
    const externalAss = playerNum === 1 ? externalAssSubtitle1 : externalAssSubtitle2;
    return (Array.isArray(subtitles) && subtitles.length > 0) || !!externalAss;
}

async function clearSubtitlesForPlayer(playerNum, options = {}) {
    const playerId = playerNum === 1 ? VIDEO_PLAYER_IDS.video1 : VIDEO_PLAYER_IDS.video2;
    const hadExternalAss = !!(playerNum === 1 ? externalAssSubtitle1 : externalAssSubtitle2);

    if (playerNum === 1) {
        subtitles1 = [];
        externalAssSubtitle1 = null;
        lastSubtitlePath1 = null;
        updateSubtitles(1, video1.currentTime || 0);
    } else {
        subtitles2 = [];
        externalAssSubtitle2 = null;
        lastSubtitlePath2 = null;
        updateSubtitles(2, getPlayer2Time());

        if (isMainWindow() && isElectronWindowMode()) {
            mergeRemotePlayer2State({ subtitles: [], subtitlePath: null, externalAssSubtitle: null });
            sendHydrateToPlayer2Window();
        } else {
            maybeBroadcastPlayer2State('subtitle-clear');
        }
    }

    if (hadExternalAss) disposeVobSubRenderer(playerNum);

    if (options.persist !== false && electronAPI && typeof electronAPI.setLastSubtitle === 'function') {
        try { await electronAPI.setLastSubtitle(playerId, null); } catch { }
    }
}

async function autoLoadSubtitleForVideo(playerId, videoPath, options = {}) {
    if (!electronAPI || !videoPath || typeof electronAPI.findSubtitleForVideo !== 'function') return;
    const playerNum = getPlayerNumFromPlayerId(playerId);
    if (options.skipIfExisting && hasSubtitleForPlayer(playerNum)) return;

    try {
        const subtitle = await electronAPI.findSubtitleForVideo(videoPath);
        if (!subtitle || !subtitle.path || typeof subtitle.content !== 'string') return;
        await applySubtitleContent(playerNum, subtitle.content, subtitle.path, {
            persist: options.persist !== false
        });
    } catch {
        // no-op: matching subtitles are optional
    }
}

async function openSubtitleFromDialog(playerNum) {
    if (!electronAPI) return;
    try {
        const selected = await electronAPI.openSubtitleFile();
        if (!selected || !selected.path || typeof selected.content !== 'string') return;
        await applySubtitleFile(playerNum, selected.content, selected.path, selected.format);
    } catch {
        // no-op
    }
}

function applyVideoMetadata(playerId, metadata, options = {}) {
    const playerNum = getPlayerNumFromPlayerId(playerId);
    window.hdrToneMapping?.setVideoMetadata(playerNum, metadata?.videoColor || null);
    if (metadata && Number.isFinite(Number(metadata.frameRate)) && Number(metadata.frameRate) > 0) {
        setFrameRateForPlayer(playerNum, metadata.frameRate);
        return true;
    }

    setFrameRateForPlayer(playerNum, DEFAULT_FRAME_RATE);
    if (options.notifyOnFailure) {
        showControlNotification(`Could not detect FPS; using ${DEFAULT_FRAME_RATE} fps`);
    }
    return false;
}

async function ensureFrameRateForVideo(playerId, localPath, options = {}) {
    if (!localPath || !electronAPI || typeof electronAPI.probeVideoMetadata !== 'function') {
        applyVideoMetadata(playerId, null, { notifyOnFailure: !!localPath && options.notifyOnProbeFailure });
        return null;
    }

    try {
        const metadata = await electronAPI.probeVideoMetadata(localPath);
        applyVideoMetadata(playerId, metadata, { notifyOnFailure: options.notifyOnProbeFailure });
        return metadata;
    } catch {
        applyVideoMetadata(playerId, null, { notifyOnFailure: options.notifyOnProbeFailure });
        return null;
    }
}

async function restoreLastPlayedSubtitles() {
    if (!electronAPI) return;
    try {
        const [last1, last2] = await Promise.all([
            electronAPI.getLastSubtitle(VIDEO_PLAYER_IDS.video1),
            electronAPI.getLastSubtitle(VIDEO_PLAYER_IDS.video2)
        ]);

        if (last1 && typeof last1.content === 'string' && isMainWindow() && !vobSubTrack1) {
            await applySubtitleFile(1, last1.content, last1.path, last1.format, { persist: false });
        }

        if (last2 && typeof last2.content === 'string' && !vobSubTrack2) {
            await applySubtitleFile(2, last2.content, last2.path, last2.format, { persist: false });
        }
    } catch {
        // no-op: app still works without restoring prior subtitles
    }
}

async function loadVideoFromSource(video, src, playerId, localPath, options) {
    if (!video || !src) return;
    const opts = options || {};
    const playerNum = getPlayerNumFromPlayerId(playerId);

    // An embedded subtitle renderer belongs to one specific media source. Tear it
    // down before changing the video so a matching stream index in the next file
    // cannot accidentally reuse the previous file's ASS/VobSub renderer.
    disposeVobSubRenderer(playerNum);
    if (!opts.skipMetadataProbe) {
        await ensureFrameRateForVideo(playerId, localPath, opts);
    }
    if (opts.clearSubtitles !== false) {
        await clearSubtitlesForPlayer(playerNum, {
            persist: opts.persist !== false
        });
    }
    if (playerId === VIDEO_PLAYER_IDS.video2 && isElectronWindowMode() && !opts.skipModeRouting) {
        remotePlayer2State = mergeRemotePlayer2State({
            ...remotePlayer2State,
            src,
            filePath: localPath || null,
            currentTime: 0,
            duration: 0,
            paused: true,
            playbackRate: globalPlaybackRate,
            frameRate: getFrameRateForPlayer(2),
            subtitles: [],
            subtitlePath: null
        });
        if (opts.persist !== false && electronAPI && localPath) {
            try { await electronAPI.setLastVideo(playerId, localPath); } catch { }
        }
        sendHydrateToPlayer2Window();
        return;
    }
    if (playerId === VIDEO_PLAYER_IDS.video1) lastVideoPath1 = localPath || null;
    if (playerId === VIDEO_PLAYER_IDS.video2) lastVideoPath2 = localPath || null;
    video.src = src;
    video.load();
    try { video.playbackRate = globalPlaybackRate; } catch { }
    video.addEventListener('loadedmetadata', () => { try { video.playbackRate = globalPlaybackRate; } catch { } }, { once: true });

    if (opts.persist !== false && electronAPI && playerId && localPath) {
        try { await electronAPI.setLastVideo(playerId, localPath); } catch { }
    }
    schedulePersistElectronPlaybackSession();
}

async function loadVideo(event, video, playerId) {
    const file = event.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        const filePath = file.path || null;
        const metadata = await ensureFrameRateForVideo(playerId, filePath, { notifyOnProbeFailure: true });
        await loadVideoFromSource(video, url, playerId, filePath, { skipMetadataProbe: true });
        if (filePath) {
            const selectedAudioTrack = prepareAudioTracks(playerId, metadata || {}, filePath);
            configureAudioTrack(playerId, selectedAudioTrack, filePath);
            const selectedVobSubTrack = prepareVobSubTracks(playerId, metadata || {}, filePath);
            configureVobSubTrack(playerId, selectedVobSubTrack, filePath);
        }
    }
}

function togglePlay(video, btnId) {
    if (isPlayer2Window() && video === video2) {
        if (isSynced) {
            dispatchToPeer({
                type: 'player2-request-toggle-play',
                currentTime: video2.currentTime || 0
            });
            return;
        }
        const btn = document.getElementById(btnId);
        if (video.paused) {
            video.play().catch(() => { });
            if (btn) btn.textContent = '⏸';
        } else {
            try { video.pause(); } catch { }
            if (btn) btn.textContent = '▶';
        }
        maybeBroadcastPlayer2State('play-toggle');
        return;
    }

    const btn = document.getElementById(btnId);
    const player2Paused = isPlayer2Paused();
    let player2PausedAfterToggle = player2Paused;
    if (video === video2 && isElectronWindowMode()) {
        const shouldPlay = player2Paused;
        const requestedTime = getPlayer2Time();
        player2PausedAfterToggle = !shouldPlay;
        mergeRemotePlayer2State({
            paused: player2PausedAfterToggle,
            currentTime: requestedTime,
            playbackRate: globalPlaybackRate
        });
        if (btn) btn.textContent = shouldPlay ? '⏸' : '▶';
        dispatchToPeer({ type: shouldPlay ? 'player2-play' : 'player2-pause' });
        if (isSynced) {
            const v1Target = requestedTime - (syncPoint2 || 0) - (delay || 0) + (syncPoint1 || 0);
            if (Number.isFinite(v1Target)) {
                const v1Dur = video1.duration || 0;
                const clamped = Math.max(0, Math.min(v1Dur || Number.MAX_SAFE_INTEGER, v1Target));
                if (v1Dur > 0) {
                    try { video1.currentTime = clamped; } catch { }
                }
            }
            if (shouldPlay) {
                video1.play().catch(() => { });
                document.getElementById('playBtn1').textContent = '⏸';
            } else {
                try { video1.pause(); } catch { }
                document.getElementById('playBtn1').textContent = '▶';
            }
            dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
        }
        schedulePersistElectronPlaybackSession(0);
        return;
    } else if (video.paused) {
        video.play();
        if (btn) btn.textContent = '⏸';
    } else {
        video.pause();
        if (btn) btn.textContent = '▶';
    }

    // Sync play/pause if synced (works for both players)
    if (isSynced) {
        if (video === video1) {
            if (video.paused) {
                if (isElectronWindowMode()) {
                    remotePlayer2State.paused = true;
                    dispatchToPeer({ type: 'player2-pause' });
                } else {
                    video2.pause();
                    document.getElementById('playBtn2').textContent = '▶';
                }
            } else {
                if (isElectronWindowMode()) {
                    remotePlayer2State.paused = false;
                    dispatchToPeer({ type: 'player2-play' });
                } else {
                    video2.play();
                    document.getElementById('playBtn2').textContent = '⏸';
                }
            }
        } else if (video === video2) {
            const paused = isElectronWindowMode() ? player2PausedAfterToggle : video.paused;
            if (paused) {
                video1.pause();
                document.getElementById('playBtn1').textContent = '▶';
            } else {
                video1.play();
                document.getElementById('playBtn1').textContent = '⏸';
            }
        }
    }
}

function seekVideo(event, video, progressId) {
    const progressContainer = document.getElementById(progressId);
    const rect = progressContainer.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * video.duration;

    if (isPlayer2Window() && video === video2) {
        video.currentTime = newTime;
        updateProgress(video2, 'progressBar2', 'timeDisplay2');
        dispatchToPeer({ type: 'player2-request-seek', currentTime: newTime });
        return;
    }

    if (video === video2 && isElectronWindowMode()) {
        remotePlayer2State.currentTime = newTime;
        dispatchToPeer({ type: 'player2-seek', currentTime: newTime });
        if (isSynced) {
            const v1Target = newTime - (syncPoint2 || 0) - (delay || 0) + (syncPoint1 || 0);
            if (!isNaN(v1Target)) {
                const v1Dur = video1.duration || 0;
                const clamped = Math.max(0, Math.min(v1Dur || Number.MAX_SAFE_INTEGER, v1Target));
                if (v1Dur > 0) video1.currentTime = clamped;
            }
            const v1Now = video1.currentTime || 0;
            syncPoint2 = newTime - (v1Now - (syncPoint1 || 0)) - (delay || 0);
            lastSyncTime = Date.now();
            dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
        }
        schedulePersistElectronPlaybackSession(0);
        return;
    }

    video.currentTime = newTime;

    // Sync-aware seeking
    if (isSynced) {
        if (video === video1) {
            // When seeking video1, move video2 according to current mapping
            const syncedTime = newTime - syncPoint1 + syncPoint2 + delay;
            const maxDuration = isElectronWindowMode() ? (getPlayer2Duration() || Infinity) : (video2.duration || Infinity);
            if (syncedTime >= 0 && syncedTime <= maxDuration) {
                if (isElectronWindowMode()) {
                    remotePlayer2State.currentTime = syncedTime;
                    dispatchToPeer({ type: 'player2-seek', currentTime: syncedTime });
                } else {
                    video2.currentTime = syncedTime;
                }
                lastSyncTime = Date.now(); // prevent immediate re-sync
            }
        } else if (video === video2) {
            // When seeking video2, immediately align video1 to the corresponding time
            // Mapping: t2 = (t1 - syncPoint1) + syncPoint2 + delay
            // Invert for t1: t1 = t2 - syncPoint2 - delay + syncPoint1
            const v1Target = newTime - (syncPoint2 || 0) - (delay || 0) + (syncPoint1 || 0);
            if (!isNaN(v1Target)) {
                const v1Dur = video1.duration || 0;
                const clamped = Math.max(0, Math.min(v1Dur || Number.MAX_SAFE_INTEGER, v1Target));
                if (v1Dur > 0) video1.currentTime = clamped;
            }
            // Also adjust mapping so subsequent playback keeps sync smoothly
            const v1Now = video1.currentTime || 0;
            syncPoint2 = newTime - (v1Now - (syncPoint1 || 0)) - (delay || 0);
            lastSyncTime = Date.now(); // small cooldown before next correction
        }
    }
    schedulePersistElectronPlaybackSession(0);
}

function changeSpeed(video, speed) {
    const rate = parseFloat(speed);
    globalPlaybackRate = rate; // persist for future loads
    if (isPlayer2Window() && video === video2) {
        try { video2.playbackRate = rate; } catch { }
        syncSpeedSelects(rate);
        lsSet(LS_KEYS.rate, String(rate));
        dispatchToPeer({ type: 'player2-request-speed', rate });
        return;
    }
    // Always keep both players and both selects in lockstep
    try { video1.playbackRate = rate; } catch { }
    if (isElectronWindowMode()) {
        remotePlayer2State.playbackRate = rate;
        dispatchToPeer({ type: 'player2-speed', rate });
    } else {
        try { video2.playbackRate = rate; } catch { }
    }
    syncSpeedSelects(rate);
    // Persist user choice
    lsSet(LS_KEYS.rate, String(rate));
}

function syncSpeedSelects(rate) {
    for (const id of ['speedSelect1', 'speedSelect2']) {
        const select = document.getElementById(id);
        if (!select) continue;

        const rates = Array.from(select.options)
            .map(o => parseFloat(o.value))
            .filter(v => Number.isFinite(v))
            .sort((a, b) => a - b);
        if (!rates.length) continue;

        const exactMatch = rates.find(v => Math.abs(v - rate) < 1e-6);
        if (exactMatch !== undefined) {
            select.value = String(exactMatch);
            continue;
        }

        const fallbackRates = rates.filter(v => v <= rate);
        const fallback = fallbackRates.length ? fallbackRates[fallbackRates.length - 1] : rates[0];
        select.value = String(fallback);
    }
}

function formatSpeedLabel(rate) {
    const precision = rate > 2 ? 1 : 2;
    return `${Number(rate.toFixed(precision)).toString()}x`;
}

// Helpers to bump playback speed. Keep select-based steps through 2x, then use 0.1 up to 4x.
function getAvailableRates() {
    const s1 = document.getElementById('speedSelect1');
    if (!s1) return [1, 1.25, 1.5, 1.75, 2];
    const vals = Array.from(s1.options)
        .map(o => parseFloat(o.value))
        .filter(v => Number.isFinite(v));
    // Ensure sorted unique
    const set = Array.from(new Set(vals)).sort((a, b) => a - b);
    return set.length ? set : [1, 1.25, 1.5, 1.75, 2];
}

function bumpSpeed(dir) {
    const current = Number.isFinite(globalPlaybackRate) ? globalPlaybackRate : 1;
    let nextRate = current;

    if (dir > 0 && current >= 2) {
        nextRate = Math.min(4, Math.round((current + 0.1) * 10) / 10);
    } else if (dir < 0 && current > 2) {
        nextRate = Math.max(2, Math.round((current - 0.1) * 10) / 10);
    } else {
        const rates = getAvailableRates();
        let idx = rates.findIndex(r => Math.abs(r - current) < 1e-6);
        if (idx === -1) {
            // find insertion point
            const firstGreater = rates.findIndex(r => r > current);
            if (firstGreater === -1) {
                idx = rates.length - 1;
            } else {
                idx = firstGreater;
            }
        }

        let nextIdx = idx + (dir > 0 ? 1 : -1);
        nextIdx = Math.max(0, Math.min(rates.length - 1, nextIdx));
        nextRate = rates[nextIdx];
    }
    changeSpeed(video1, nextRate);

    // Show visual notification of speed change
    showControlNotification(formatSpeedLabel(nextRate));
}

function updateProgress(video, progressBarId, timeDisplayId) {
    const progressBar = document.getElementById(progressBarId);
    const timeDisplay = document.getElementById(timeDisplayId);

    if (video.duration) {
        const percentage = (video.currentTime / video.duration) * 100;
        progressBar.style.width = percentage + '%';

        const timeDisplayOptions = getTimeDisplayOptions(video.duration);
        const frameRate = getFrameRateForPlayer(getPlayerNumFromVideo(video));
        const current = formatTime(video.currentTime, timeDisplayOptions, frameRate);
        const total = formatTime(video.duration, timeDisplayOptions, frameRate);
        renderTimeDisplay(timeDisplay, current, total);
    }
}

function getTimeDisplayOptions(duration) {
    const totalSeconds = Math.max(0, Number(duration) || 0);
    const includeHours = totalSeconds >= 3600;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minuteDigits = includeHours ? 2 : Math.max(1, String(totalMinutes).length);
    return { includeHours, minuteDigits };
}

function formatTime(seconds, options = {}, frameRate = DEFAULT_FRAME_RATE) {
    const fps = getDisplayFrameRate(frameRate);
    const totalFrames = Math.max(0, Math.round((Number(seconds) || 0) * fps));
    const frame = totalFrames % fps;
    const totalSeconds = Math.floor(totalFrames / fps);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    const frameText = frame.toString().padStart(2, '0');
    const secondsText = secs.toString().padStart(2, '0');

    if (options.includeHours) {
        return {
            time: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secondsText}`,
            frame: frameText
        };
    }

    const totalMinutes = Math.floor(totalSeconds / 60);
    const minuteDigits = Number.isFinite(options.minuteDigits) ? options.minuteDigits : 1;
    return {
        time: `${totalMinutes.toString().padStart(minuteDigits, '0')}:${secondsText}`,
        frame: frameText
    };
}

function getDisplayFrameRate(frameRate) {
    return Math.max(1, Math.round(normalizeFrameRate(frameRate)));
}

function createTimeSegment(parts, options = {}) {
    const segment = document.createElement('span');
    segment.className = 'time-segment';

    const main = document.createElement('span');
    main.className = 'time-main';
    main.textContent = parts.time;

    if (options.showFrame === false) {
        segment.append(main);
        return segment;
    }

    const frame = document.createElement('span');
    frame.className = 'time-frame';
    frame.textContent = `.${parts.frame}`;

    segment.append(main, frame);
    return segment;
}

function renderTimeDisplay(timeDisplay, current, total) {
    if (!timeDisplay) return;

    const separator = document.createElement('span');
    separator.className = 'time-separator';
    separator.textContent = ' / ';

    timeDisplay.replaceChildren(
        createTimeSegment(current),
        separator,
        createTimeSegment(total, { showFrame: false })
    );
}

function loadSubtitle(event, playerNum) {
    const file = event.target.files[0];
    if (file && /\.(?:srt|ass|ssa)$/i.test(file.name)) {
        const reader = new FileReader();
        reader.onload = function (e) {
            applySubtitleFile(playerNum, e.target.result, file.path || null, file.name.split('.').pop(), {
                persist: !!file.path
            });
        };
        reader.readAsText(file);
    }
}

function isAssSubtitle(format, localPath, content) {
    const normalizedFormat = String(format || '').trim().toLowerCase();
    if (normalizedFormat === 'ass' || normalizedFormat === 'ssa') return true;
    if (/\.(?:ass|ssa)$/i.test(String(localPath || ''))) return true;
    return /^\s*\[Script Info\]/im.test(String(content || ''));
}

async function applySubtitleFile(playerNum, content, localPath, format, options = {}) {
    if (isAssSubtitle(format, localPath, content)) {
        return applyAssSubtitleContent(playerNum, content, localPath, options);
    }
    return applySubtitleContent(playerNum, content, localPath, options);
}

async function applyAssSubtitleContent(playerNum, assContent, localPath, options = {}) {
    const content = String(assContent || '').replace(/^\uFEFF/, '');
    if (!content.trim()) return;
    const subtitlePath = typeof localPath === 'string' && localPath ? localPath : null;
    const externalAss = { content, path: subtitlePath };
    const playerId = playerNum === 1 ? VIDEO_PLAYER_IDS.video1 : VIDEO_PLAYER_IDS.video2;

    disposeVobSubRenderer(playerNum);
    setVobSubTrack(playerNum, null);
    persistVobSubChoice(playerNum, playerNum === 1 ? lastVideoPath1 : lastVideoPath2, null);
    if (playerNum === 1) {
        subtitles1 = [];
        externalAssSubtitle1 = externalAss;
        lastSubtitlePath1 = subtitlePath;
        updateSubtitles(1, video1.currentTime || 0);
    } else {
        subtitles2 = [];
        externalAssSubtitle2 = externalAss;
        lastSubtitlePath2 = subtitlePath;
        updateSubtitles(2, getPlayer2Time());
    }

    if (options.persist !== false && electronAPI && subtitlePath) {
        try { await electronAPI.setLastSubtitle(playerId, subtitlePath); } catch { }
    }

    if (playerNum === 2 && isMainWindow() && isElectronWindowMode()) {
        mergeRemotePlayer2State({
            subtitles: [],
            subtitlePath,
            externalAssSubtitle: externalAss,
            vobSubTrack: null
        });
        sendHydrateToPlayer2Window();
        return;
    }

    const generation = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
    const label = subtitlePath ? `ASS — ${subtitlePath.split(/[\\/]/).pop()}` : 'ASS subtitles';
    setVobSubLoadStatus(playerNum, 'loading', `Loading ${label}…`);
    try {
        const moduleApi = await getAssSubtitleModule();
        const activeExternal = playerNum === 1 ? externalAssSubtitle1 : externalAssSubtitle2;
        const activeGeneration = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
        if (activeGeneration !== generation || activeExternal !== externalAss) return;
        const renderer = moduleApi.createRenderer({
            video: playerNum === 1 ? video1 : video2,
            subContent: content,
            fonts: [],
            displaySettings: {
                scale: Math.max(0.1, Math.min(3, playerNum === 1 ? subtitleFontScale1 : subtitleFontScale2)),
                opacity: (playerNum === 1 ? subtitlesEnabled1 : subtitlesEnabled2) ? 1 : 0
            },
            onEvent: (event) => {
                const currentGeneration = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
                if (currentGeneration !== generation) return;
                if (event.type === 'loaded') {
                    syncVobSubRendererTransform(playerNum);
                    setVobSubLoadStatus(playerNum, 'ready', `Ready: ${label}`);
                    showControlNotification(`ASS ${playerNum} ready`);
                } else if (event.type === 'error') {
                    console.error('External ASS renderer error:', event.error);
                    setVobSubLoadStatus(playerNum, 'error', `Could not load ${label}`);
                }
            }
        });
        setVobSubRenderer(playerNum, renderer);
        await renderer.ready;
        if (playerNum === 2) maybeBroadcastPlayer2State('subtitle-load');
    } catch (error) {
        const activeGeneration = playerNum === 1 ? vobSubLoadGeneration1 : vobSubLoadGeneration2;
        if (activeGeneration !== generation) return;
        console.error('Could not load external ASS subtitles:', error);
        setVobSubLoadStatus(playerNum, 'error', `Could not load ${label}`);
    }
}

async function applySubtitleContent(playerNum, srtContent, localPath, options = {}) {
    const parsedSubtitles = parseSRT(srtContent);
    const subtitlePath = typeof localPath === 'string' && localPath ? localPath : null;

    disposeVobSubRenderer(playerNum);
    setVobSubTrack(playerNum, null);
    persistVobSubChoice(playerNum, playerNum === 1 ? lastVideoPath1 : lastVideoPath2, null);

    if (playerNum === 1) {
        subtitles1 = parsedSubtitles;
        externalAssSubtitle1 = null;
        lastSubtitlePath1 = subtitlePath;
        updateSubtitles(1, video1.currentTime || 0);
        if (options.persist !== false && electronAPI && subtitlePath) {
            try { await electronAPI.setLastSubtitle(VIDEO_PLAYER_IDS.video1, subtitlePath); } catch { }
        }
        return;
    }

    subtitles2 = parsedSubtitles;
    externalAssSubtitle2 = null;
    lastSubtitlePath2 = subtitlePath;
    updateSubtitles(2, getPlayer2Time());

    if (options.persist !== false && electronAPI && subtitlePath) {
        try { await electronAPI.setLastSubtitle(VIDEO_PLAYER_IDS.video2, subtitlePath); } catch { }
    }

    if (isMainWindow() && isElectronWindowMode()) {
        mergeRemotePlayer2State({
            subtitles: Array.isArray(subtitles2) ? [...subtitles2] : [],
            subtitlePath: lastSubtitlePath2,
            externalAssSubtitle: null,
            vobSubTrack: null
        });
        sendHydrateToPlayer2Window();
    } else {
        maybeBroadcastPlayer2State('subtitle-load');
    }
}

function parseSRT(srtContent) {
    if (!srtContent || typeof srtContent !== 'string') return [];
    // Normalize newlines and strip BOM if present
    const norm = srtContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const blocks = norm.trim().split(/\n\s*\n+/);
    const subtitles = [];

    const TIME_RE = /^(\s*)(\d{1,2}):(\d{1,2}):(\d{1,2})[\.,](\d{1,3})\s*--\>\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[\.,](\d{1,3})(?:.*)$/;
    function toSecs(h, m, s, ms) {
        const H = parseInt(h, 10) || 0;
        const M = parseInt(m, 10) || 0;
        const S = parseInt(s, 10) || 0;
        let MS = String(ms || '0');
        if (MS.length === 1) MS = MS + '00';
        else if (MS.length === 2) MS = MS + '0';
        return H * 3600 + M * 60 + S + (parseInt(MS, 10) || 0) / 1000;
    }

    for (const rawBlock of blocks) {
        const lines = rawBlock.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.length || true);
        if (lines.length === 0) continue;

        // Find the time line (skip optional sequence number)
        let timeIdx = -1;
        for (let i = 0; i < Math.min(lines.length, 4); i++) {
            if (TIME_RE.test(lines[i])) { timeIdx = i; break; }
        }
        if (timeIdx === -1) continue; // Not a valid block

        const m = lines[timeIdx].match(TIME_RE);
        if (!m) continue;
        const start = toSecs(m[2], m[3], m[4], m[5]);
        const end = toSecs(m[6], m[7], m[8], m[9]);

        // Remaining lines form the text
        let text = lines.slice(timeIdx + 1).join('\n').trim();
        if (!text) continue;

        // Handle SRT-escaped line breaks sometimes appearing as \N
        text = text.replace(/\\N/g, '\n');

        subtitles.push({ start, end, text });
    }

    return subtitles;
}

function toggleSubtitles(playerNum) {
    const current = playerNum === 1 ? subtitlesEnabled1 : subtitlesEnabled2;
    setSubtitlesEnabled(playerNum, !current, { notify: true });
}

function setSubtitlesEnabled(playerNum, enabled, options = {}) {
    const nextEnabled = enabled !== false;
    const btn = document.getElementById(`subtitleBtn${playerNum}`);
    const display = document.getElementById(playerNum === 1 ? 'subtitle1Display' : 'subtitle2Display');

    if (playerNum === 1) {
        subtitlesEnabled1 = nextEnabled;
    } else {
        subtitlesEnabled2 = nextEnabled;
    }

    if (btn) btn.style.background = nextEnabled ? 'rgba(255,255,255,0.3)' : 'none';
    if (display) {
        if (nextEnabled) {
            updateSubtitles(playerNum, playerNum === 1 ? (video1.currentTime || 0) : getPlayer2Time());
        } else {
            display.style.display = 'none';
        }
    }
    applyVobSubDisplaySettings(playerNum);

    if (options.notify) {
        showControlNotification(`Subtitles ${playerNum} ${nextEnabled ? 'On' : 'Off'}`);
    }

    if (playerNum === 2 && options.broadcast !== false) {
        if (isMainWindow() && isElectronWindowMode()) {
            mergeRemotePlayer2State({ subtitlesEnabled: nextEnabled });
            dispatchToPeer({ type: 'player2-subtitles-enabled', enabled: nextEnabled });
        } else {
            maybeBroadcastPlayer2State('subtitle-toggle');
        }
    }
}

// Convert SRT text to safe HTML allowing common tags: <i>, <b>, <u>, <s>, <br>, <font color>
function srtTextToHtml(text) {
    if (!text) return '';
    // Escape all HTML first
    let escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    // Allow a tiny whitelist of tags: i, b, u, s, br (no attributes)
    escaped = escaped
        .replace(/&lt;(i|b|u|s)&gt;/gi, '<$1>')
        .replace(/&lt;\/(i|b|u|s)&gt;/gi, '</$1>')
        .replace(/&lt;br\s*\/?&gt;/gi, '<br>');

    // Support <font color="..."> by converting to <span style="color:...">
    const namedColors = new Set(['white', 'black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'lime', 'gray', 'grey', 'orange', 'pink', 'purple', 'aqua', 'fuchsia', 'teal', 'navy', 'maroon', 'olive', 'silver', 'gold']);
    function sanitizeColor(val) {
        if (!val) return null;
        const v = String(val).trim().toLowerCase();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
        if (namedColors.has(v)) return v;
        return null;
    }
    escaped = escaped.replace(/&lt;font\b[^&]*?color\s*=\s*(?:"([^"]+)"|'([^']+)'|([^'"\s>&]+))[^&]*?&gt;/gi, function (_m, c1, c2, c3) {
        const raw = c1 || c2 || c3;
        const col = sanitizeColor(raw);
        return col ? `<span style="color:${col}">` : '<span>';
    });
    escaped = escaped.replace(/&lt;\/font&gt;/gi, '</span>');

    // Preserve authored SRT line breaks.
    escaped = escaped.replace(/\\N/g, '<br>');
    return escaped.replace(/\r?\n/g, '<br>');
}

function updateSubtitles(playerNum, currentTime) {
    const subtitles = playerNum === 1 ? subtitles1 : subtitles2;
    const enabled = playerNum === 1 ? subtitlesEnabled1 : subtitlesEnabled2;
    const displayId = playerNum === 1 ? 'subtitle1Display' : 'subtitle2Display';
    const display = document.getElementById(displayId);

    if (!enabled || subtitles.length === 0) {
        display.style.display = 'none';
        return;
    }

    // Find current subtitle
    const currentSubtitle = subtitles.find(subtitle =>
        currentTime >= subtitle.start && currentTime <= subtitle.end
    );

    if (currentSubtitle) {
        // Safely render minimal SRT formatting (<i>, <b>, <u>, line breaks)
        display.innerHTML = srtTextToHtml(currentSubtitle.text);
        display.style.display = 'block';
    } else {
        display.style.display = 'none';
    }
}

function swapVideos() {
    if (isPlayer2Window()) {
        dispatchToPeer({ type: 'player2-request-swap' });
        return;
    }

    if (isElectronWindowMode()) {
        const player1State = {
            src: video1.currentSrc || video1.src || '',
            filePath: lastVideoPath1 || null,
            currentTime: video1.currentTime || 0,
            duration: video1.duration || 0,
            paused: !!video1.paused,
            volume: Number.isFinite(video1.volume) ? video1.volume : 1,
            muted: getPlayerMuted(1),
            playbackRate: Number.isFinite(video1.playbackRate) ? video1.playbackRate : globalPlaybackRate,
            subtitles: Array.isArray(subtitles1) ? [...subtitles1] : [],
            subtitlePath: lastSubtitlePath1 || null,
            externalAssSubtitle: externalAssSubtitle1,
            subtitlesEnabled: subtitlesEnabled1 !== false,
            subtitleFontScale: subtitleFontScale1,
            vobSubTrack: vobSubTrack1,
            vobSubTracks: [...vobSubTracks1],
            audioTrack: audioTrack1,
            audioTracks: [...audioTracks1],
            tf: cloneTf(tf1)
        };
        const player2State = buildPlayer2Snapshot();
        const tempSyncPoint1 = syncPoint1;
        const tempSyncPoint2 = syncPoint2;
        const wasSynced = isSynced;

        subtitles1 = Array.isArray(player2State.subtitles) ? [...player2State.subtitles] : [];
        subtitles2 = Array.isArray(player1State.subtitles) ? [...player1State.subtitles] : [];
        externalAssSubtitle1 = player2State.externalAssSubtitle || null;
        externalAssSubtitle2 = player1State.externalAssSubtitle || null;
        lastSubtitlePath1 = player2State.subtitlePath || null;
        lastSubtitlePath2 = player1State.subtitlePath || null;
        subtitlesEnabled1 = player2State.subtitlesEnabled !== false;
        subtitlesEnabled2 = player1State.subtitlesEnabled !== false;
        vobSubTrack1 = player2State.vobSubTrack || null;
        vobSubTrack2 = player1State.vobSubTrack || null;
        vobSubTracks1 = Array.isArray(player2State.vobSubTracks) ? [...player2State.vobSubTracks] : [];
        vobSubTracks2 = [...player1State.vobSubTracks];
        audioTrack1 = player2State.audioTrack || null;
        audioTrack2 = player1State.audioTrack || null;
        audioTracks1 = Array.isArray(player2State.audioTracks) ? [...player2State.audioTracks] : [];
        audioTracks2 = [...player1State.audioTracks];
        setAvailableVobSubTracks(1, vobSubTracks1, vobSubTrack1);
        setAvailableVobSubTracks(2, vobSubTracks2, vobSubTrack2);
        setAvailableAudioTracks(1, audioTracks1, audioTrack1);
        setAvailableAudioTracks(2, audioTracks2, audioTrack2);
        disposeVobSubRenderer(1);
        disposeVobSubRenderer(2);
        setSubtitleFontScale(1, player2State.subtitleFontScale, { notify: false, broadcast: false });
        setSubtitleFontScale(2, player1State.subtitleFontScale, { notify: false, broadcast: false });
        tf1 = isValidTf(player2State.tf) ? cloneTf(player2State.tf) : cloneTf(tf1);
        tf2 = isValidTf(player1State.tf) ? cloneTf(player1State.tf) : cloneTf(tf2);
        lastVideoPath1 = player2State.filePath || null;
        lastVideoPath2 = player1State.filePath || null;

        if (electronAPI) {
            if (lastVideoPath1) electronAPI.setLastVideo(VIDEO_PLAYER_IDS.video1, lastVideoPath1).catch(() => { });
            if (lastVideoPath2) electronAPI.setLastVideo(VIDEO_PLAYER_IDS.video2, lastVideoPath2).catch(() => { });
            if (lastSubtitlePath1) electronAPI.setLastSubtitle(VIDEO_PLAYER_IDS.video1, lastSubtitlePath1).catch(() => { });
            if (lastSubtitlePath2) electronAPI.setLastSubtitle(VIDEO_PLAYER_IDS.video2, lastSubtitlePath2).catch(() => { });
        }

        const restoreMain = async () => {
            if (player2State.src) {
                await loadVideoFromSource(video1, player2State.src, VIDEO_PLAYER_IDS.video1, player2State.filePath, { persist: false, clearSubtitles: false });
                configureAudioTrack(VIDEO_PLAYER_IDS.video1, player2State.audioTrack, player2State.filePath);
                if (player2State.externalAssSubtitle) {
                    applyAssSubtitleContent(1, player2State.externalAssSubtitle.content, player2State.externalAssSubtitle.path, { persist: false });
                } else {
                    configureVobSubTrack(VIDEO_PLAYER_IDS.video1, player2State.vobSubTrack, player2State.filePath);
                }
            } else {
                try { video1.pause(); } catch { }
                video1.removeAttribute('src');
                video1.load();
            }
            if (player2State.src) {
                const once = () => {
                    try { video1.currentTime = player2State.currentTime || 0; } catch { }
                    setPlayerVolume(1, Number.isFinite(player2State.volume) ? player2State.volume : 1);
                    setPlayerMuted(1, !!player2State.muted);
                    try { video1.playbackRate = Number.isFinite(player2State.playbackRate) ? player2State.playbackRate : globalPlaybackRate; } catch { }
                    if (player2State.paused === false) {
                        video1.play().catch(() => { });
                    } else {
                        try { video1.pause(); } catch { }
                    }
                    applyTransform(1);
                    updateSubtitles(1, video1.currentTime || 0);
                };
                video1.addEventListener('loadedmetadata', once, { once: true });
                setTimeout(once, 250);
            }
        };

        restoreMain();
        remotePlayer2State = {
            ...player1State,
            subtitles: Array.isArray(player1State.subtitles) ? [...player1State.subtitles] : [],
            tf: cloneTf(player1State.tf)
        };
        sendHydrateToPlayer2Window();

        if (wasSynced) {
            syncPoint1 = tempSyncPoint2;
            syncPoint2 = tempSyncPoint1;
            isSynced = true;
        }
        dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
        return;
    }

    // Store current states
    const video1Src = video1.src;
    const video2Src = video2.src;
    const video1CurrentTime = video1.currentTime;
    const video2CurrentTime = video2.currentTime;
    const video1Volume = video1.volume;
    const video2Volume = video2.volume;
    const video1Muted = getPlayerMuted(1);
    const video2Muted = getPlayerMuted(2);
    const video1PlaybackRate = video1.playbackRate;
    const video2PlaybackRate = video2.playbackRate;
    const video1Paused = video1.paused;
    const video2Paused = video2.paused;

    // Store subtitle states
    const tempSubtitles1 = [...subtitles1];
    const tempSubtitles2 = [...subtitles2];
    const tempSubtitlePath1 = lastSubtitlePath1;
    const tempSubtitlePath2 = lastSubtitlePath2;
    const tempExternalAssSubtitle1 = externalAssSubtitle1;
    const tempExternalAssSubtitle2 = externalAssSubtitle2;
    const tempSubtitlesEnabled1 = subtitlesEnabled1;
    const tempSubtitlesEnabled2 = subtitlesEnabled2;
    const tempSubtitleFontScale1 = subtitleFontScale1;
    const tempSubtitleFontScale2 = subtitleFontScale2;
    const tempVobSubTrack1 = vobSubTrack1;
    const tempVobSubTrack2 = vobSubTrack2;
    const tempVobSubTracks1 = [...vobSubTracks1];
    const tempVobSubTracks2 = [...vobSubTracks2];
    const tempAudioTrack1 = audioTrack1;
    const tempAudioTrack2 = audioTrack2;
    const tempAudioTracks1 = [...audioTracks1];
    const tempAudioTracks2 = [...audioTracks2];

    // Store sync points if they exist
    const tempSyncPoint1 = syncPoint1;
    const tempSyncPoint2 = syncPoint2;
    const wasSynced = isSynced;

    // Store transform states
    const tempTf1 = { ...tf1 };
    const tempTf2 = { ...tf2 };
    const tempPath1 = lastVideoPath1;
    const tempPath2 = lastVideoPath2;

    // Swap video sources
    video1.src = video2Src;
    video2.src = video1Src;
    window.hdrToneMapping?.swapVideoMetadata();
    disposeVobSubRenderer(1);
    disposeVobSubRenderer(2);
    lastVideoPath1 = tempPath2;
    lastVideoPath2 = tempPath1;
    externalAssSubtitle1 = tempExternalAssSubtitle2;
    externalAssSubtitle2 = tempExternalAssSubtitle1;
    vobSubTrack1 = tempVobSubTrack2;
    vobSubTrack2 = tempVobSubTrack1;
    setAvailableVobSubTracks(1, tempVobSubTracks2, vobSubTrack1);
    setAvailableVobSubTracks(2, tempVobSubTracks1, vobSubTrack2);
    audioTrack1 = tempAudioTrack2;
    audioTrack2 = tempAudioTrack1;
    setAvailableAudioTracks(1, tempAudioTracks2, audioTrack1);
    setAvailableAudioTracks(2, tempAudioTracks1, audioTrack2);
    configureAudioTrack(VIDEO_PLAYER_IDS.video1, audioTrack1, lastVideoPath1);
    configureAudioTrack(VIDEO_PLAYER_IDS.video2, audioTrack2, lastVideoPath2);
    if (externalAssSubtitle1) {
        applyAssSubtitleContent(1, externalAssSubtitle1.content, externalAssSubtitle1.path, { persist: false });
    } else {
        loadVobSubRenderer(1, vobSubTrack1, lastVideoPath1);
    }
    if (externalAssSubtitle2) {
        applyAssSubtitleContent(2, externalAssSubtitle2.content, externalAssSubtitle2.path, { persist: false });
    } else {
        loadVobSubRenderer(2, vobSubTrack2, lastVideoPath2);
    }
    if (electronAPI) {
        if (lastVideoPath1) electronAPI.setLastVideo(VIDEO_PLAYER_IDS.video1, lastVideoPath1).catch(() => { });
        if (lastVideoPath2) electronAPI.setLastVideo(VIDEO_PLAYER_IDS.video2, lastVideoPath2).catch(() => { });
        if (tempSubtitlePath2) electronAPI.setLastSubtitle(VIDEO_PLAYER_IDS.video1, tempSubtitlePath2).catch(() => { });
        if (tempSubtitlePath1) electronAPI.setLastSubtitle(VIDEO_PLAYER_IDS.video2, tempSubtitlePath1).catch(() => { });
    }

    // Wait for videos to load then restore states
    Promise.all([
        new Promise(resolve => {
            if (video1Src) {
                video1.addEventListener('loadeddata', resolve, { once: true });
            } else {
                resolve();
            }
        }),
        new Promise(resolve => {
            if (video2Src) {
                video2.addEventListener('loadeddata', resolve, { once: true });
            } else {
                resolve();
            }
        })
    ]).then(() => {
        // Restore states with swapped values
        if (video2Src) video1.currentTime = video2CurrentTime;
        if (video1Src) video2.currentTime = video1CurrentTime;

        setPlayerVolume(1, video2Volume);
        setPlayerVolume(2, video1Volume);
        setPlayerMuted(1, video2Muted);
        setPlayerMuted(2, video1Muted);
        video1.playbackRate = video2PlaybackRate;
        video2.playbackRate = video1PlaybackRate;

        // Update UI controls
        document.getElementById('volumeSlider1').value = video2Volume;
        document.getElementById('volumeSlider2').value = video1Volume;
        // Update visual fills after programmatic value changes
        const vs1 = document.getElementById('volumeSlider1');
        const vs2 = document.getElementById('volumeSlider2');
        if (vs1) vs1.style.setProperty('--vol', (video2Volume * 100) + '%');
        if (vs2) vs2.style.setProperty('--vol', (video1Volume * 100) + '%');
        document.getElementById('speedSelect1').value = video2PlaybackRate;
        document.getElementById('speedSelect2').value = video1PlaybackRate;

        // Update volume button icons
        changeVolume(video1, video1.volume, 'muteBtn1');
        changeVolume(video2, video2.volume, 'muteBtn2');

        // Swap subtitles
        subtitles1 = tempSubtitles2;
        subtitles2 = tempSubtitles1;
        lastSubtitlePath1 = tempSubtitlePath2;
        lastSubtitlePath2 = tempSubtitlePath1;
        subtitlesEnabled1 = tempSubtitlesEnabled2;
        subtitlesEnabled2 = tempSubtitlesEnabled1;
        setSubtitleFontScale(1, tempSubtitleFontScale2, { notify: false, broadcast: false });
        setSubtitleFontScale(2, tempSubtitleFontScale1, { notify: false, broadcast: false });

        // Update subtitle button states (buttons may not exist)
        const _b1 = document.getElementById('subtitleBtn1');
        const _b2 = document.getElementById('subtitleBtn2');
        if (_b1) _b1.style.background = subtitlesEnabled1 ? 'rgba(255,255,255,0.3)' : 'none';
        if (_b2) _b2.style.background = subtitlesEnabled2 ? 'rgba(255,255,255,0.3)' : 'none';

        // Restore sync points with swapped values
        if (wasSynced) {
            syncPoint1 = tempSyncPoint2; // Swap sync points
            syncPoint2 = tempSyncPoint1;
            isSynced = true;
        }

        // Restore play states
        if (!video2Paused && video1Src) {
            video1.play();
            document.getElementById('playBtn1').textContent = '⏸';
        } else {
            document.getElementById('playBtn1').textContent = '▶';
        }

        if (!video1Paused && video2Src) {
            video2.play();
            document.getElementById('playBtn2').textContent = '⏸';
        } else {
            document.getElementById('playBtn2').textContent = '▶';
        }

        // Swap transform states
        tf1 = tempTf2;
        tf2 = tempTf1;
        applyTransform(1);  // Apply swapped transform to video1
        applyTransform(2);  // Apply swapped transform to video2
    });
}

function changeVolume(video, volume, muteBtnId) {
    const playerNum = getPlayerNumFromVideo(video);
    setPlayerVolume(playerNum, volume);
    const muteBtn = document.getElementById(muteBtnId);
    if (getPlayerMuted(playerNum) || volume == 0) {
        muteBtn.textContent = '🔇';
    } else if (volume < 0.5) {
        muteBtn.textContent = '🔉';
    } else {
        muteBtn.textContent = '🔊';
    }
    if (isPlayer2Window() && video === video2) maybeBroadcastPlayer2State('volume-set');
}

function toggleMute(video, muteBtnId, sliderId) {
    const playerNum = getPlayerNumFromVideo(video);
    const muteBtn = document.getElementById(muteBtnId);
    const slider = document.getElementById(sliderId);

    if (getPlayerMuted(playerNum)) {
        setPlayerMuted(playerNum, false);
        setPlayerVolume(playerNum, slider.value);
        changeVolume(video, slider.value, muteBtnId);
        if (slider) slider.style.setProperty('--vol', (parseFloat(slider.value) * 100) + '%');
    } else {
        setPlayerMuted(playerNum, true);
        muteBtn.textContent = '🔇';
    }
    if (isPlayer2Window() && video === video2) maybeBroadcastPlayer2State('mute-toggle');
}

function setSyncPoint() {
    if (isPlayer2Window()) {
        requestPlayer2SetSync();
        return;
    }

    const player2Duration = getPlayer2Duration();
    if (video1.duration && player2Duration) {
        syncPoint1 = video1.currentTime;
        syncPoint2 = getPlayer2Time();
        isSynced = true;

        // Start video2 from its sync point when video1 plays
        if (isElectronWindowMode()) {
            remotePlayer2State.currentTime = syncPoint2;
            dispatchToPeer({ type: 'player2-seek', currentTime: syncPoint2 });
            remotePlayer2State.paused = false;
            dispatchToPeer({ type: 'player2-play' });
        } else {
            video2.currentTime = syncPoint2;
        }

        // Ensure both players are playing
        if (video1.paused) {
            video1.play();
            const pb1 = document.getElementById('playBtn1');
            if (pb1) pb1.textContent = '⏸';
        }
        // Always start video2
        if (!isElectronWindowMode()) {
            video2.play();
            const pb2 = document.getElementById('playBtn2');
            if (pb2) pb2.textContent = '⏸';
        }

        // (sync status UI removed)

        // Hide sync controls after setting sync point
        const syncControls = document.getElementById('syncControls');
        if (syncControls) syncControls.style.display = 'none';
        if (isElectronWindowMode()) {
            dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
        }
        schedulePersistElectronPlaybackSession(0);
    }
}

function clearSyncPoint() {
    if (isPlayer2Window()) {
        dispatchToPeer({ type: 'player2-request-clear-sync' });
        return;
    }

    syncPoint1 = null;
    syncPoint2 = null;
    isSynced = false;
    lastSyncTime = 0;

    const syncControls = document.getElementById('syncControls');
    if (syncControls) syncControls.style.display = '';
    if (isElectronWindowMode()) {
        dispatchToPeer({ type: 'player2-sync-meta', sync: buildPlayer2SyncMeta() });
    }
    schedulePersistElectronPlaybackSession(0);
}

function resetTimestampsAndClearSync() {
    if (isPlayer2Window()) {
        dispatchToPeer({ type: 'player2-request-reset-timestamps' });
        return;
    }

    clearSyncPoint();

    try { video1.currentTime = 0; } catch { }
    updateProgress(video1, 'progressBar1', 'timeDisplay1');
    updateSubtitles(1, 0);

    if (isElectronWindowMode()) {
        mergeRemotePlayer2State({ currentTime: 0 });
        dispatchToPeer({ type: 'player2-seek', currentTime: 0 });
    } else {
        try { video2.currentTime = 0; } catch { }
        updateProgress(video2, 'progressBar2', 'timeDisplay2');
        updateSubtitles(2, 0);
    }

    lastSyncTime = 0;
    schedulePersistElectronPlaybackSession(0);
}

// (Clear Sync and Delay controls removed)

let lastSyncTime = 0;
const SYNC_THRESHOLD = 0.9; // Window mode needs a wider tolerance to avoid visible overcorrection.
const SYNC_INTERVAL = 350; // Avoid hammering player2 with high-frequency seek corrections.

function handleSync() {
    if (isSynced && !video1.paused) {
        const now = Date.now();
        const targetTime = (video1.currentTime - syncPoint1) + syncPoint2 + delay;
        const currentPlayer2Time = getPlayer2Time();
        const timeDifference = Math.abs(currentPlayer2Time - targetTime);

        // Only sync if there's a significant difference and enough time has passed
        if (targetTime >= 0 &&
            timeDifference > SYNC_THRESHOLD &&
            now - lastSyncTime > SYNC_INTERVAL) {

            if (isElectronWindowMode()) {
                mergeRemotePlayer2State({
                    currentTime: targetTime,
                    paused: false,
                    playbackRate: globalPlaybackRate
                });
                dispatchToPeer({ type: 'player2-seek', currentTime: targetTime });
            } else {
                video2.currentTime = targetTime;
            }
            lastSyncTime = now;
        }
    }
}

// Show temporary notification for control toggle
function showControlNotification(message) {
    // Remove any existing notification
    const existing = document.getElementById('controlNotification');
    if (existing) existing.remove();

    // Create notification element
    const notification = document.createElement('div');
    notification.id = 'controlNotification';
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 5%;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 20px 40px;
        border-radius: 12px;
        font-size: 24px;
        font-weight: bold;
        z-index: 10000;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        border: 2px solid rgba(255, 255, 255, 0.2);
        pointer-events: none;
    `;

    document.body.appendChild(notification);

    // Remove after 1.5 seconds
    setTimeout(() => {
        notification.style.transition = 'opacity 0.3s ease';
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 1500);
}

// ================== Keyboard ==================
function getPunctuationDirectionFromEvent(event) {
    const key = String(event.key || '');
    const code = String(event.code || '');

    if (code === 'Period' || code === 'NumpadDecimal' || key === '.' || key === '>') return 1;
    if (code === 'Comma' || key === ',' || key === '<') return -1;
    return 0;
}

function getFrameStepDirectionFromEvent(event, options = {}) {
    if (!options.ignoreModifiers && (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)) return 0;
    return getPunctuationDirectionFromEvent(event);
}

function getSpeedShortcutDirectionFromEvent(event) {
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return 0;
    const direction = getPunctuationDirectionFromEvent(event);
    if (direction) return direction;
    return 0;
}

function updateFrameStepHeldKey(event, isHeld) {
    const direction = getFrameStepDirectionFromEvent(event, { ignoreModifiers: true });
    if (direction > 0) frameStepHeldKeys.period = !!isHeld;
    if (direction < 0) frameStepHeldKeys.comma = !!isHeld;
    if (direction) revealPlayerControls();
    return direction;
}

function getHeldFrameStepDirection(preferredDirection = 0) {
    if (frameStepHeldKeys.period && !frameStepHeldKeys.comma) return 1;
    if (frameStepHeldKeys.comma && !frameStepHeldKeys.period) return -1;
    if (frameStepHeldKeys.period && frameStepHeldKeys.comma) {
        return preferredDirection || frameStepHoldDirection || 1;
    }
    return 0;
}

function isFrameStepDirectionHeld(direction) {
    if (direction > 0) return !!frameStepHeldKeys.period;
    if (direction < 0) return !!frameStepHeldKeys.comma;
    return false;
}

function stopFrameStepHold() {
    frameStepHeldKeys.comma = false;
    frameStepHeldKeys.period = false;
    frameStepHoldDirection = 0;
    remoteFrameStepHoldDirection = 0;
    if (frameStepHoldStartTimer) {
        clearTimeout(frameStepHoldStartTimer);
        frameStepHoldStartTimer = null;
    }
    if (remoteFrameStepHoldStartTimer) {
        clearTimeout(remoteFrameStepHoldStartTimer);
        remoteFrameStepHoldStartTimer = null;
    }
}

function handleKeyboardKeyup(event) {
    const direction = updateFrameStepHeldKey(event, false);
    if (!direction) return;
    if (isPlayer2Window() && activeVideo === 1) {
        requestMainKeyboardControl('stop-frame-step', { direction });
        return;
    }
    frameStepHoldDirection = getHeldFrameStepDirection(frameStepHoldDirection);
}

function handleKeyboard(event) {
    if (isProfileMenuOpen() && event.key === 'Escape') {
        event.preventDefault();
        closeProfileMenu();
        return;
    }

    // Ctrl+Shift+` (same physical key as ~) toggles profile menu
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'Backquote') {
        event.preventDefault();
        if (isProfileMenuOpen()) closeProfileMenu();
        else openProfileMenu();
        return;
    }

    // Reload app/window
    if (event.key === 'F5' || event.code === 'F5') {
        event.preventDefault();
        window.location.reload();
        return;
    }

    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (isProfileMenuOpen()) return;

    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'KeyZ') {
        event.preventDefault();
        undoLastAction();
        return;
    }

    if (((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyY')
        || ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyZ')) {
        event.preventDefault();
        redoLastAction();
        return;
    }

    // Electron zoom shortcuts (mirror browser behavior)
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = String(event.key || '');
        if (key === '+' || key === '=') {
            event.preventDefault();
            adjustElectronZoom(1.1);
            return;
        }
        if (key === '-') {
            event.preventDefault();
            adjustElectronZoom(1 / 1.1);
            return;
        }
        if (key === '0') {
            event.preventDefault();
            resetElectronZoom();
            return;
        }
    }

    // Profiles:
    // Ctrl+Alt+Shift+Number => save profile
    // Ctrl+Shift+Number => load profile
    const slot = getProfileSlotFromEvent(event);
    if (slot !== null) {
        if (event.ctrlKey && event.shiftKey && event.altKey) {
            event.preventDefault();
            saveProfile(slot);
            return;
        }
        if (event.ctrlKey && event.shiftKey && !event.altKey) {
            event.preventDefault();
            loadProfile(slot);
            return;
        }
    }

    // Ctrl+Shift+P: reset both timestamps to 0 and clear sync
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyP') {
        event.preventDefault();
        if (requestMainKeyboardControl('reset-timestamps')) return;
        recordUndoableAction('Reset Timestamps', resetTimestampsAndClearSync);
        return;
    }

    if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        const key = String(event.key || '');
        const code = String(event.code || '');

        if (key === '+' || key === '=' || code === 'NumpadAdd') {
            event.preventDefault();
            if (requestMainKeyboardControl('subtitle-font-size', { direction: 1 })) return;
            adjustSubtitleFontScale(activeVideo, 1);
            return;
        }

        if (key === '-' || code === 'NumpadSubtract') {
            event.preventDefault();
            if (requestMainKeyboardControl('subtitle-font-size', { direction: -1 })) return;
            adjustSubtitleFontScale(activeVideo, -1);
            return;
        }

        if (key.toLowerCase() === 'c') {
            event.preventDefault();
            if (requestMainKeyboardControl('toggle-subtitles')) return;
            toggleSubtitles(activeVideo);
            return;
        }
    }

    // Space & arrows (existing behavior)
    if (event.key === ' ') {
        event.preventDefault();
        if (isPlayer2Window() && activeVideo === 1) {
            requestMainKeyboardControl('toggle-play');
            return;
        }
        const activeVid = activeVideo === 1 ? video1 : video2;
        const activeBtnId = activeVideo === 1 ? 'playBtn1' : 'playBtn2';
        togglePlay(activeVid, activeBtnId);
        return;
    }
    // "/" key: Toggle which video is controlled by keyboard shortcuts
    if (event.key === '/') {
        event.preventDefault();
        setActiveVideo(activeVideo === 1 ? 2 : 1, { broadcast: true });
        if (isPlayer2Window()) {
            dispatchToPeer({ type: 'player2-request-active-video', activeVideo });
        }
        return;
    }
    // "'" key: Swap videos
    if (event.key === "'") {
        event.preventDefault();
        swapVideos();
        return;
    }
    // Ctrl+Shift+Enter: Remove sync and allow setting a new sync point
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key === 'Enter') {
        event.preventDefault();
        if (requestMainKeyboardControl('clear-sync')) return;
        recordUndoableAction('Clear Sync', clearSyncPoint);
        return;
    }
    // Enter: Set Sync Point (only before sync is set)
    if (event.key === 'Enter') {
        event.preventDefault();
        if (requestMainKeyboardControl('set-sync')) return;
        if (!isSynced) recordSetSyncPoint();
        return;
    }
    // Toggle fullscreen with "F"
    if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFullscreen();
        return;
    }
    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (isPlayer2Window() && activeVideo === 1) {
            requestMainKeyboardControl('skip-time', { seconds: -5 });
            return;
        }
        skipTime(-5);
        return;
    }
    if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (isPlayer2Window() && activeVideo === 1) {
            requestMainKeyboardControl('skip-time', { seconds: 5 });
            return;
        }
        skipTime(5);
        return;
    }

    // Shift + '.' increase speed, Shift + ',' decrease speed
    const speedShortcutDirection = getSpeedShortcutDirectionFromEvent(event);
    if (speedShortcutDirection) {
        event.preventDefault();
        if (requestMainKeyboardControl('speed', { direction: speedShortcutDirection })) return;
        bumpSpeed(speedShortcutDirection);
        return;
    }

    // "." next frame, "," previous frame. Holding either key steps continuously.
    const frameStepDirection = getFrameStepDirectionFromEvent(event);
    if (frameStepDirection) {
        event.preventDefault();
        revealPlayerControls();
        if (event.repeat && isFrameStepDirectionHeld(frameStepDirection)) return;
        updateFrameStepHeldKey(event, true);
        if (isPlayer2Window() && activeVideo === 1) {
            requestMainKeyboardControl('step-frame', { direction: frameStepDirection, phase: 'press' });
            return;
        }
        startFrameStepHold(frameStepDirection);
        return;
    }

    // Numpad transform/move hotkeys for active video
    const code = event.code;
    const alt = event.altKey;
    const ctrl = event.ctrlKey;

    if (isPlayer2Window() && activeVideo === 1 && String(code || '').startsWith('Numpad')) {
        if (requestMainKeyboardControl('transform-key', { code, alt, ctrl })) {
            event.preventDefault();
            return;
        }
    }

    const tf = activeVideo === 1 ? tf1 : tf2;

    switch (code) {
        // === Zoom / Rotate90 / Move Up-Right ===
        case 'Numpad9':
            if (alt) { // Rotate ⭮ 90° (clockwise)
                tf.rot += 90; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Up-Right
                tf.tx += MOVE_STEP; tf.ty -= MOVE_STEP; applyTransform(); event.preventDefault();
            } else { // Zoom In
                tf.zoom = clamp(tf.zoom + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM); applyTransform(); event.preventDefault();
            }
            break;
        // === Zoom Out / Rotate ⭯ / Move Down-Left ===
        case 'Numpad1':
            if (alt) { // Rotate ⭯ (counterclockwise) small step
                tf.rot -= ROTATE_STEP; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Down-Left
                tf.tx -= MOVE_STEP; tf.ty += MOVE_STEP; applyTransform(); event.preventDefault();
            } else { // Zoom Out
                tf.zoom = clamp(tf.zoom - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM); applyTransform(); event.preventDefault();
            }
            break;
        // === Horizontal Stretch / Flip H / Move Right ===
        case 'Numpad6':
            if (alt) { // Flip Horizontally (toggle)
                tf.flipX *= -1; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Right
                tf.tx += MOVE_STEP; applyTransform(); event.preventDefault();
            } else { // Stretch X
                tf.stretchX = clamp(tf.stretchX + STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform(); event.preventDefault();
            }
            break;
        // === Horizontal Compress / Flip H / Move Left ===
        case 'Numpad4':
            if (alt) { // Flip Horizontally (toggle)
                tf.flipX *= -1; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Left
                tf.tx -= MOVE_STEP; applyTransform(); event.preventDefault();
            } else { // Compress X
                tf.stretchX = clamp(tf.stretchX - STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform(); event.preventDefault();
            }
            break;
        // === Vertical Stretch / Flip V / Move Up ===
        case 'Numpad8':
            if (alt) { // Flip Vertically (toggle)
                tf.flipY *= -1; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Up
                tf.ty -= MOVE_STEP; applyTransform(); event.preventDefault();
            } else { // Stretch Y
                tf.stretchY = clamp(tf.stretchY + STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform(); event.preventDefault();
            }
            break;
        // === Vertical Compress / Flip V / Move Down ===
        case 'Numpad2':
            if (alt) { // Flip Vertically (toggle)
                tf.flipY *= -1; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Down
                tf.ty += MOVE_STEP; applyTransform(); event.preventDefault();
            } else { // Compress Y
                tf.stretchY = clamp(tf.stretchY - STRETCH_STEP, MIN_STRETCH, MAX_STRETCH); applyTransform(); event.preventDefault();
            }
            break;
        // === Rotate ⭮ (clockwise small) / Move Down-Right ===
        case 'Numpad3':
            if (alt) { // Rotate ⭮
                tf.rot += ROTATE_STEP; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Down-Right
                tf.tx += MOVE_STEP; tf.ty += MOVE_STEP; applyTransform(); event.preventDefault();
            }
            break;
        // === Rotate ⭯ 90° (counterclockwise) / Move Up-Left ===
        case 'Numpad7':
            if (alt) { // Rotate ⭯ 90°
                tf.rot -= 90; applyTransform(); event.preventDefault();
            } else if (ctrl) { // Move Up-Left
                tf.tx -= MOVE_STEP; tf.ty -= MOVE_STEP; applyTransform(); event.preventDefault();
            }
            break;
        // === Recenter / Reset ===
        case 'Numpad5':
            if (ctrl) { // Recenter (only translate)
                recenter(); event.preventDefault();
            } else { // Reset all transformations
                resetTransforms(); event.preventDefault();
            }
            break;
        default:
            // no-op
            break;
    }
}

function seekRemotePlayer2(time, options = {}) {
    const commandId = options.waitForSeek ? `remote-player2-seek-${++remotePlayer2SeekCommandId}` : null;
    mergeRemotePlayer2State({
        currentTime: time,
        updatedAt: Date.now()
    });
    dispatchToPeer({ type: 'player2-seek', currentTime: time, commandId });
    return commandId ? waitForRemotePlayer2Seek(commandId) : Promise.resolve();
}

function skipTime(seconds, options = {}) {
    const pendingSeeks = [];
    const controllingRemotePlayer2 = isElectronWindowMode() && activeVideo === 2;
    const activeVid = activeVideo === 1 ? video1 : video2;
    const otherVid = activeVideo === 1 ? video2 : video1;
    const activeDuration = controllingRemotePlayer2 ? getPlayer2Duration() : (activeVid.duration || 0);
    const activeCurrentTime = controllingRemotePlayer2 ? getPlayer2Time() : (activeVid.currentTime || 0);
    const activeMaxTime = activeDuration > 0 ? activeDuration : Number.MAX_SAFE_INTEGER;
    const newTime = Math.max(0, Math.min(activeMaxTime, activeCurrentTime + seconds));

    if (isSynced) {
        // Calculate synced time for the other video
        let syncedTime;
        if (activeVideo === 1) {
            syncedTime = newTime - syncPoint1 + syncPoint2 + delay;
        } else {
            // When controlling video2, calculate video1's time
            syncedTime = newTime - syncPoint2 - delay + syncPoint1;
        }

        const otherDuration = activeVideo === 1 && isElectronWindowMode() ? getPlayer2Duration() : (otherVid.duration || 0);
        if (syncedTime >= 0 && syncedTime <= otherDuration) {
            if (activeVideo === 1 && isElectronWindowMode()) {
                pendingSeeks.push(seekRemotePlayer2(syncedTime, options));
            } else {
                otherVid.currentTime = syncedTime;
            }
            lastSyncTime = Date.now(); // Update last sync time to prevent immediate re-sync
        }
    }

    if (controllingRemotePlayer2) {
        pendingSeeks.push(seekRemotePlayer2(newTime, options));
    } else {
        activeVid.currentTime = newTime;
    }

    schedulePersistElectronPlaybackSession(0);
    return pendingSeeks.length ? Promise.all(pendingSeeks) : Promise.resolve();
}

function waitForRemotePlayer2Seek(commandId) {
    if (!commandId) return Promise.resolve();
    return new Promise((resolve) => {
        remotePlayer2SeekWaiters.set(commandId, {
            resolve: (value) => {
                resolve(value);
            }
        });
    });
}

async function stepRemotePlayer2Frame(direction, options = {}) {
    const step = (direction >= 0 ? 1 : -1) / getFrameRateForPlayer(2);
    const duration = getPlayer2Duration();
    const maxTime = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
    const newTime = Math.max(0, Math.min(maxTime, getPlayer2Time() + step));
    const commandId = options.waitForSeek ? `remote-frame-step-${++remotePlayer2SeekCommandId}` : null;

    mergeRemotePlayer2State({
        currentTime: newTime,
        paused: true,
        updatedAt: Date.now()
    });
    dispatchToPeer({ type: 'player2-pause' });
    dispatchToPeer({ type: 'player2-seek', currentTime: newTime, commandId });
    schedulePersistElectronPlaybackSession(0);
    if (commandId) await waitForRemotePlayer2Seek(commandId);
}

function startRemotePlayer2FrameStepHold(direction) {
    remoteFrameStepHoldDirection = direction >= 0 ? 1 : -1;
    if (remoteFrameStepHoldStartTimer || remoteFrameStepHoldRunning) return;
    runInitialRemotePlayer2FrameStep();
}

async function runInitialRemotePlayer2FrameStep() {
    remoteFrameStepHoldRunning = true;
    try {
        await stepRemotePlayer2Frame(remoteFrameStepHoldDirection, { waitForSeek: true });
    } finally {
        remoteFrameStepHoldRunning = false;
    }

    if (!remoteFrameStepHoldDirection) return;
    remoteFrameStepHoldStartTimer = setTimeout(() => {
        remoteFrameStepHoldStartTimer = null;
        if (remoteFrameStepHoldDirection && !remoteFrameStepHoldRunning) runRemotePlayer2FrameStepHold();
    }, FRAME_STEP_HOLD_START_DELAY_MS);
}

async function runRemotePlayer2FrameStepHold() {
    remoteFrameStepHoldRunning = true;
    try {
        while (remoteFrameStepHoldDirection) {
            await stepRemotePlayer2Frame(remoteFrameStepHoldDirection, { waitForSeek: true });
        }
    } finally {
        remoteFrameStepHoldRunning = false;
    }
}

// Frame stepping uses the active video's detected frame rate when available.
function delayMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForVideoSeek(video, timeoutMs = FRAME_STEP_SEEK_TIMEOUT_MS) {
    if (!video) return Promise.resolve();
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            video.removeEventListener('seeked', finish);
            resolve();
        };

        if (!video.seeking) {
            requestAnimationFrame(finish);
            return;
        }

        video.addEventListener('seeked', finish, { once: true });
        setTimeout(finish, timeoutMs);
    });
}

function waitForVideoSeekEvent(video) {
    if (!video) return Promise.resolve();
    return new Promise((resolve) => {
        if (!video.seeking) {
            resolve();
            return;
        }
        video.addEventListener('seeked', resolve, { once: true });
    });
}

function updateVideoAfterManualSeek(videoNum) {
    if (videoNum === 1) {
        updateProgress(video1, 'progressBar1', 'timeDisplay1');
        updateSubtitles(1, video1.currentTime || 0);
        return;
    }
    updateProgress(video2, 'progressBar2', 'timeDisplay2');
    updateSubtitles(2, video2.currentTime || 0);
}

function startFrameStepHold(direction) {
    revealPlayerControls();
    if (direction > 0) frameStepHeldKeys.period = true;
    if (direction < 0) frameStepHeldKeys.comma = true;
    frameStepHoldDirection = direction >= 0 ? 1 : -1;
    if (frameStepHoldRunning || frameStepHoldStartTimer) return;
    runInitialFrameStep();
}

async function runInitialFrameStep() {
    frameStepHoldRunning = true;
    try {
        await stepFrame(frameStepHoldDirection, { waitForSeek: true });
    } finally {
        frameStepHoldRunning = false;
    }

    frameStepHoldDirection = getHeldFrameStepDirection(frameStepHoldDirection);
    if (!frameStepHoldDirection) return;

    frameStepHoldStartTimer = setTimeout(() => {
        frameStepHoldStartTimer = null;
        if (frameStepHoldDirection && !frameStepHoldRunning) runFrameStepHold();
    }, FRAME_STEP_HOLD_START_DELAY_MS);
}

async function runFrameStepHold() {
    frameStepHoldRunning = true;
    try {
        while (frameStepHoldDirection) {
            revealPlayerControls();
            const direction = frameStepHoldDirection;
            await stepFrame(direction, { waitForSeek: true });
            frameStepHoldDirection = getHeldFrameStepDirection(direction);
            if (frameStepHoldDirection) {
                await delayMs(0);
            }
        }
    } finally {
        frameStepHoldRunning = false;
    }
}

async function stepFrame(direction, options = {}) {
    try { video1.pause(); } catch { }
    try { video2.pause(); } catch { }
    if (isElectronWindowMode()) {
        remotePlayer2State.paused = true;
        dispatchToPeer({ type: 'player2-pause' });
    }
    const wasRemotePlayer2 = isElectronWindowMode() && activeVideo === 2;
    const localVideoNum = activeVideo;
    const localVideo = localVideoNum === 1 ? video1 : video2;
    const step = (direction >= 0 ? 1 : -1) / getFrameRateForPlayer(activeVideo);
    const remoteSeekPromise = skipTime(step, { waitForSeek: options.waitForSeek });
    if (!wasRemotePlayer2) {
        updateVideoAfterManualSeek(localVideoNum);
        if (options.waitForSeek) {
            if (isElectronWindowMode() && activeVideo === 1 && isSynced) {
                await remoteSeekPromise;
            } else {
                await Promise.all([
                    waitForVideoSeek(localVideo),
                    remoteSeekPromise
                ]);
            }
            updateVideoAfterManualSeek(localVideoNum);
        }
    } else if (options.waitForSeek) {
        await remoteSeekPromise;
    }
}

function initializeDragging() {
    const overlay = document.getElementById('overlayPlayer');

    // Restore saved overlay geometry (position and size)
    (function restoreOverlayGeom() {
        const data = lsGet(LS_KEYS.overlayGeom);
        if (!data) return;
        try {
            const g = JSON.parse(data);
            applyOverlayGeom(g);
        } catch { }
    })();

    overlay.addEventListener('mousedown', startDrag);
    // Corner resize handles
    overlay.querySelectorAll('.resize-handle').forEach(h => {
        h.addEventListener('mousedown', startResize);
    });

    function startDrag(e) {
        // Don't start drag if clicking on controls or resize handle
        if (e.target.closest('.overlay-controls') || e.target.closest('.resize-handle')) return;

        // Check if clicking near the resize handle (bottom-right corner)
        const rect = overlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const isNearResizeHandle = x > rect.width - 20 && y > rect.height - 20;

        if (isNearResizeHandle) return;

        isDragging = true;
        dragOffset.x = e.clientX - rect.left;
        dragOffset.y = e.clientY - rect.top;

        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDrag);
        document.body.classList.add('dragging');

        // Temporarily disable resize while dragging
        overlay.style.resize = 'none';
    }

    function drag(e) {
        if (!isDragging) return;

        const x = e.clientX - dragOffset.x;
        const y = e.clientY - dragOffset.y;

        overlay.style.left = Math.max(0, Math.min(window.innerWidth - overlay.offsetWidth, x)) + 'px';
        overlay.style.top = Math.max(0, Math.min(window.innerHeight - overlay.offsetHeight, y)) + 'px';
        overlay.style.right = 'auto';
    }

    function stopDrag() {
        if (isDragging) {
            isDragging = false;
            document.removeEventListener('mousemove', drag);
            document.removeEventListener('mouseup', stopDrag);
            document.body.classList.remove('dragging');

            // Re-enable resize after dragging
            overlay.style.resize = 'none';

            // Persist geometry
            saveOverlayGeom(overlay);
        }
    }

    function startResize(e) {
        e.preventDefault();
        e.stopPropagation();
        const rect = overlay.getBoundingClientRect();
        isResizing = true;
        resizeState.startX = e.clientX;
        resizeState.startY = e.clientY;
        resizeState.startW = rect.width;
        resizeState.startH = rect.height;
        resizeState.startLeft = rect.left;
        resizeState.startTop = rect.top;
        resizeState.handle = e.target.getAttribute('data-handle');

        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);
        document.body.classList.add('dragging');
    }

    function doResize(e) {
        if (!isResizing) return;
        const dx = e.clientX - resizeState.startX;
        const dy = e.clientY - resizeState.startY;

        // Compute new geometry based on handle
        let newW = resizeState.startW;
        let newH = resizeState.startH;
        let newLeft = resizeState.startLeft;
        let newTop = resizeState.startTop;

        const handle = resizeState.handle;
        if (handle === 'se') {
            newW = resizeState.startW + dx;
            newH = resizeState.startH + dy;
        } else if (handle === 'sw') {
            newW = resizeState.startW - dx;
            newH = resizeState.startH + dy;
            newLeft = resizeState.startLeft + dx;
        } else if (handle === 'ne') {
            newW = resizeState.startW + dx;
            newH = resizeState.startH - dy;
            newTop = resizeState.startTop + dy;
        } else if (handle === 'nw') {
            newW = resizeState.startW - dx;
            newH = resizeState.startH - dy;
            newLeft = resizeState.startLeft + dx;
            newTop = resizeState.startTop + dy;
        } else if (handle === 'e') {
            // Right edge: adjust width only
            newW = resizeState.startW + dx;
        } else if (handle === 'w') {
            // Left edge: adjust width and left
            newW = resizeState.startW - dx;
            newLeft = resizeState.startLeft + dx;
        } else if (handle === 's') {
            // Bottom edge: adjust height only
            newH = resizeState.startH + dy;
        } else if (handle === 'n') {
            // Top edge: adjust height and top
            newH = resizeState.startH - dy;
            newTop = resizeState.startTop + dy;
        }

        // Enforce minimums
        const cs = window.getComputedStyle(overlay);
        const minW = parseFloat(cs.minWidth) || 200;
        const minH = parseFloat(cs.minHeight) || 112;

        if (newW < minW) {
            if (handle === 'sw' || handle === 'nw' || handle === 'w') {
                newLeft += (newW - minW);
            }
            newW = minW;
        }
        if (newH < minH) {
            if (handle === 'nw' || handle === 'ne' || handle === 'n') {
                newTop += (newH - minH);
            }
            newH = minH;
        }

        // Keep within viewport (optional soft clamp)
        newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - newW));
        newTop = Math.max(0, Math.min(newTop, window.innerHeight - newH));

        overlay.style.width = newW + 'px';
        overlay.style.height = newH + 'px';
        overlay.style.left = newLeft + 'px';
        overlay.style.top = newTop + 'px';
        overlay.style.right = 'auto';
    }

    function stopResize() {
        if (!isResizing) return;
        isResizing = false;
        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', stopResize);
        document.body.classList.remove('dragging');

        // Persist geometry
        saveOverlayGeom(overlay);
    }
}

function saveOverlayGeom(overlayEl) {
    try {
        const geom = getCurrentOverlayGeom(overlayEl);
        if (geom) lsSet(LS_KEYS.overlayGeom, JSON.stringify(geom));
    } catch { }
}

function toggleOverlay() {
    const overlay = document.getElementById('overlayPlayer');
    overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
}

// Initialize everything when page loads
document.addEventListener('DOMContentLoaded', initializePlayers);
if (new URLSearchParams(window.location.search).has('vobsub-smoke')) {
    window.__dvsVobSubSmoke = {
        applyFile: applySubtitleFile,
        getRenderer: getVobSubRenderer,
        getTrack: getVobSubTrack,
        persistChoice: persistVobSubChoice,
        prepareTracks: prepareVobSubTracks,
        selectTrack: selectVobSubTrackForPlayer,
        loadSource: loadVideoFromSource,
        setVideoPath(playerNum, filePath) {
            if (playerNum === 1) lastVideoPath1 = filePath;
            if (playerNum === 2) lastVideoPath2 = filePath;
        },
        setStatus: setVobSubLoadStatus
    };
}
if (new URLSearchParams(window.location.search).has('dynamic-audio-smoke')) {
    window.__dvsDynamicAudioSmoke = {
        configureTrack: configureAudioTrack,
        getTrack(playerNum) {
            return playerNum === 1 ? audioTrack1 : audioTrack2;
        },
        getPlayerState(playerNum) {
            return getDynamicAudioPlayer(playerNum)?.getDebugState() || null;
        },
        prepareTracks: prepareAudioTracks,
        selectTrack: selectAudioTrackForPlayer,
        setVideoPath(playerNum, filePath) {
            if (playerNum === 1) lastVideoPath1 = filePath;
            if (playerNum === 2) lastVideoPath2 = filePath;
        }
    };
}
})();
