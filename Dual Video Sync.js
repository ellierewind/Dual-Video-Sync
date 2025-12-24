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
// Global playback rate that persists across loads
let globalPlaybackRate = 1;
// Track which video is controlled by keyboard shortcuts (1 or 2)
let activeVideo = 1;

// ===== Persistence (localStorage) =====
const LS_KEYS = {
    rate: 'dvs:rate',
    overlayGeom: 'dvs:overlay:geom',
    video1Tf: 'dvs:video1:tf',
    video2Tf: 'dvs:video2:tf'
};

function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch { }
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

    const sx = tf.zoom * tf.stretchX * tf.flipX;
    const sy = tf.zoom * tf.stretchY * tf.flipY;
    video.style.transform = `translate(${tf.tx}px, ${tf.ty}px) rotate(${tf.rot}deg) scale(${sx}, ${sy})`;
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

// Initialize players
function initializePlayers() {
    // File inputs
    document.getElementById('file1').addEventListener('change', (e) => loadVideo(e, video1));
    document.getElementById('file2').addEventListener('change', (e) => loadVideo(e, video2));

    // Subtitle inputs
    document.getElementById('subtitle1').addEventListener('change', (e) => loadSubtitle(e, 1));
    document.getElementById('subtitle2').addEventListener('change', (e) => loadSubtitle(e, 2));

    // Subtitle toggle buttons removed (default remains enabled)

    // Settings dropdowns: open/close + actions
    setupDropdown('1');
    setupDropdown('2');

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
    // Ensure both selects and playbackRates start in sync, using saved rate if available
    const s1 = document.getElementById('speedSelect1');
    const savedRateStr = lsGet(LS_KEYS.rate);
    const savedRate = savedRateStr ? parseFloat(savedRateStr) : NaN;
    const initialRate = Number.isFinite(savedRate)
        ? String(savedRate)
        : (s1 && s1.value) ? s1.value : '1';
    changeSpeed(video1, initialRate);

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
    });
    document.getElementById('muteBtn1').addEventListener('click', () => toggleMute(video1, 'muteBtn1', 'volumeSlider1'));
    document.getElementById('muteBtn2').addEventListener('click', () => toggleMute(video2, 'muteBtn2', 'volumeSlider2'));
    // Fullscreen button (main controls, toggles app-wide fullscreen including overlay)
    const fsBtn = document.getElementById('fsBtnMain') || document.getElementById('fsBtn1');
    if (fsBtn) fsBtn.addEventListener('click', () => toggleFullscreen());
    // Hide any legacy fullscreen button in the left group if present
    const legacyFs = document.getElementById('fsBtn1');
    if (legacyFs && legacyFs !== fsBtn) legacyFs.style.display = 'none';
    // Remove overlay fullscreen button if it exists
    const fs2Old = document.getElementById('fsBtn2');
    if (fs2Old) fs2Old.remove();

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
    }

    // Sync control (Set only)
    document.getElementById('setSyncBtn').addEventListener('click', setSyncPoint);

    // Video events
    video1.addEventListener('timeupdate', () => {
        updateProgress(video1, 'progressBar1', 'timeDisplay1');
        updateSubtitles(1, video1.currentTime);
    });
    video2.addEventListener('timeupdate', () => {
        updateProgress(video2, 'progressBar2', 'timeDisplay2');
        updateSubtitles(2, video2.currentTime);
    });
    // Keep play/pause icons in sync with state, even on programmatic play/pause
    video1.addEventListener('play', () => { const b = document.getElementById('playBtn1'); if (b) b.textContent = '⏸'; });
    video1.addEventListener('pause', () => { const b = document.getElementById('playBtn1'); if (b) b.textContent = '▶'; });
    video2.addEventListener('play', () => { const b = document.getElementById('playBtn2'); if (b) b.textContent = '⏸'; });
    video2.addEventListener('pause', () => { const b = document.getElementById('playBtn2'); if (b) b.textContent = '▶'; });
    video1.addEventListener('timeupdate', handleSync);

    // Keyboard controls (includes transform hotkeys for MAIN player)
    document.addEventListener('keydown', handleKeyboard);

    // Dragging functionality (restores saved overlay geometry)
    initializeDragging();

    // Inactivity handling (hide controls and cursor)
    setupInactivityHide();

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
}

// Wheel-based volume control for a specific player
// Finer wheel increments; sliders now step 0.01
const VOLUME_WHEEL_STEP = 0.02; // per notch
function handleWheelVolume(event, video, sliderId, muteBtnId) {
    // Avoid interfering with pinch-zoom or modified scrolls
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    const slider = document.getElementById(sliderId);
    if (!slider) return;
    const dir = event.deltaY < 0 ? 1 : -1; // up increases, down decreases
    const current = Math.max(0, Math.min(1, parseFloat(slider.value)));
    // Snap to 0.01 steps to align with slider
    let next = current + dir * VOLUME_WHEEL_STEP;
    next = Math.max(0, Math.min(1, Math.round(next * 100) / 100));
    if (next === current) return;
    // Changing volume should unmute
    if (video.muted && next > 0) video.muted = false;
    slider.value = next.toFixed(2);
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
    if (fs1) fs1.textContent = '⛶'; // keep icon constant
}

document.addEventListener('fullscreenchange', updateFullscreenButtons);

function setupDropdown(id) {
    const dropdown = document.getElementById(`settings${id}`);
    if (!dropdown) return;
    const toggle = document.getElementById(`settingsToggle${id}`);
    const ccItem = document.getElementById(`ccToggle${id}`);

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

function loadVideo(event, video) {
    const file = event.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        video.src = url;
        video.load();
        // Apply the user's chosen rate immediately and on metadata
        try { video.playbackRate = globalPlaybackRate; } catch { }
        video.addEventListener('loadedmetadata', () => { try { video.playbackRate = globalPlaybackRate; } catch { } }, { once: true });
    }
}

function togglePlay(video, btnId) {
    const btn = document.getElementById(btnId);
    if (video.paused) {
        video.play();
        btn.textContent = '⏸';
    } else {
        video.pause();
        btn.textContent = '▶';
    }

    // Sync play/pause if synced (works for both players)
    if (isSynced) {
        if (video === video1) {
            if (video.paused) {
                video2.pause();
                document.getElementById('playBtn2').textContent = '▶';
            } else {
                video2.play();
                document.getElementById('playBtn2').textContent = '⏸';
            }
        } else if (video === video2) {
            if (video.paused) {
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

    video.currentTime = newTime;

    // Sync-aware seeking
    if (isSynced) {
        if (video === video1) {
            // When seeking video1, move video2 according to current mapping
            const syncedTime = newTime - syncPoint1 + syncPoint2 + delay;
            if (syncedTime >= 0 && syncedTime <= (video2.duration || Infinity)) {
                video2.currentTime = syncedTime;
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
}

function changeSpeed(video, speed) {
    const rate = parseFloat(speed);
    globalPlaybackRate = rate; // persist for future loads
    // Always keep both players and both selects in lockstep
    try { video1.playbackRate = rate; } catch { }
    try { video2.playbackRate = rate; } catch { }
    const s1 = document.getElementById('speedSelect1');
    const s2 = document.getElementById('speedSelect2');
    if (s1) s1.value = String(rate);
    if (s2) s2.value = String(rate);
    // Persist user choice
    lsSet(LS_KEYS.rate, String(rate));
}

// Helpers to bump playback speed among available select options
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
    const rates = getAvailableRates();
    const current = Number.isFinite(globalPlaybackRate) ? globalPlaybackRate : 1;
    let idx = rates.findIndex(r => Math.abs(r - current) < 1e-6);
    if (idx === -1) {
        // find insertion point
        let firstGreater = rates.findIndex(r => r > current);
        if (firstGreater === -1) {
            idx = rates.length - 1;
        } else {
            idx = firstGreater;
        }
    }
    let nextIdx = idx + (dir > 0 ? 1 : -1);
    nextIdx = Math.max(0, Math.min(rates.length - 1, nextIdx));
    const nextRate = rates[nextIdx];
    changeSpeed(video1, nextRate);

    // Show visual notification of speed change
    showControlNotification(`${nextRate}x`);
}

function updateProgress(video, progressBarId, timeDisplayId) {
    const progressBar = document.getElementById(progressBarId);
    const timeDisplay = document.getElementById(timeDisplayId);

    if (video.duration) {
        const percentage = (video.currentTime / video.duration) * 100;
        progressBar.style.width = percentage + '%';

        const current = formatTime(video.currentTime);
        const total = formatTime(video.duration);
        timeDisplay.textContent = `${current} / ${total}`;
    }
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function loadSubtitle(event, playerNum) {
    const file = event.target.files[0];
    if (file && file.name.endsWith('.srt')) {
        const reader = new FileReader();
        reader.onload = function (e) {
            const srtContent = e.target.result;
            const parsedSubtitles = parseSRT(srtContent);

            if (playerNum === 1) {
                subtitles1 = parsedSubtitles;
            } else {
                subtitles2 = parsedSubtitles;
            }
        };
        reader.readAsText(file);
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
    if (playerNum === 1) {
        subtitlesEnabled1 = !subtitlesEnabled1;
        const btn = document.getElementById('subtitleBtn1');
        const display = document.getElementById('subtitle1Display');

        if (btn) btn.style.background = subtitlesEnabled1 ? 'rgba(255,255,255,0.3)' : 'none';
        if (!subtitlesEnabled1) {
            display.style.display = 'none';
        }
    } else {
        subtitlesEnabled2 = !subtitlesEnabled2;
        const btn = document.getElementById('subtitleBtn2');
        const display = document.getElementById('subtitle2Display');

        if (btn) btn.style.background = subtitlesEnabled2 ? 'rgba(255,255,255,0.3)' : 'none';
        if (!subtitlesEnabled2) {
            display.style.display = 'none';
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

    // Convert SRT newlines and \N to <br>
    escaped = escaped.replace(/\\N/g, '<br>');
    // Convert newlines to <br>
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
    // Store current states
    const video1Src = video1.src;
    const video2Src = video2.src;
    const video1CurrentTime = video1.currentTime;
    const video2CurrentTime = video2.currentTime;
    const video1Volume = video1.volume;
    const video2Volume = video2.volume;
    const video1Muted = video1.muted;
    const video2Muted = video2.muted;
    const video1PlaybackRate = video1.playbackRate;
    const video2PlaybackRate = video2.playbackRate;
    const video1Paused = video1.paused;
    const video2Paused = video2.paused;

    // Store subtitle states
    const tempSubtitles1 = [...subtitles1];
    const tempSubtitles2 = [...subtitles2];
    const tempSubtitlesEnabled1 = subtitlesEnabled1;
    const tempSubtitlesEnabled2 = subtitlesEnabled2;

    // Store sync points if they exist
    const tempSyncPoint1 = syncPoint1;
    const tempSyncPoint2 = syncPoint2;
    const wasSynced = isSynced;

    // Store transform states
    const tempTf1 = { ...tf1 };
    const tempTf2 = { ...tf2 };

    // Swap video sources
    video1.src = video2Src;
    video2.src = video1Src;

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

        video1.volume = video2Volume;
        video2.volume = video1Volume;
        video1.muted = video2Muted;
        video2.muted = video1Muted;
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
        subtitlesEnabled1 = tempSubtitlesEnabled2;
        subtitlesEnabled2 = tempSubtitlesEnabled1;

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
    video.volume = volume;
    const muteBtn = document.getElementById(muteBtnId);
    if (volume == 0) {
        muteBtn.textContent = '🔇';
    } else if (volume < 0.5) {
        muteBtn.textContent = '🔉';
    } else {
        muteBtn.textContent = '🔊';
    }
}

function toggleMute(video, muteBtnId, sliderId) {
    const muteBtn = document.getElementById(muteBtnId);
    const slider = document.getElementById(sliderId);

    if (video.muted) {
        video.muted = false;
        video.volume = slider.value;
        changeVolume(video, slider.value, muteBtnId);
        if (slider) slider.style.setProperty('--vol', (parseFloat(slider.value) * 100) + '%');
    } else {
        video.muted = true;
        muteBtn.textContent = '🔇';
    }
}

function setSyncPoint() {
    if (video1.duration && video2.duration) {
        syncPoint1 = video1.currentTime;
        syncPoint2 = video2.currentTime;
        isSynced = true;

        // Start video2 from its sync point when video1 plays
        video2.currentTime = syncPoint2;

        // Ensure both players are playing
        if (video1.paused) {
            video1.play();
            const pb1 = document.getElementById('playBtn1');
            if (pb1) pb1.textContent = '⏸';
        }
        // Always start video2
        video2.play();
        const pb2 = document.getElementById('playBtn2');
        if (pb2) pb2.textContent = '⏸';

        // (sync status UI removed)

        // Hide sync controls after setting sync point
        document.getElementById('syncControls').style.display = 'none';
    }
}

// (Clear Sync and Delay controls removed)

let lastSyncTime = 0;
const SYNC_THRESHOLD = 0.5; // Only sync if difference is more than 0.5 seconds
const SYNC_INTERVAL = 100; // Minimum time between sync adjustments (ms)

function handleSync() {
    if (isSynced && !video1.paused) {
        const now = Date.now();
        const targetTime = (video1.currentTime - syncPoint1) + syncPoint2 + delay;
        const timeDifference = Math.abs(video2.currentTime - targetTime);

        // Only sync if there's a significant difference and enough time has passed
        if (targetTime >= 0 &&
            timeDifference > SYNC_THRESHOLD &&
            now - lastSyncTime > SYNC_INTERVAL) {

            video2.currentTime = targetTime;
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
function handleKeyboard(event) {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    // Space & arrows (existing behavior)
    if (event.key === ' ') {
        event.preventDefault();
        const activeVid = activeVideo === 1 ? video1 : video2;
        const activeBtnId = activeVideo === 1 ? 'playBtn1' : 'playBtn2';
        togglePlay(activeVid, activeBtnId);
        return;
    }
    // "/" key: Toggle which video is controlled by keyboard shortcuts
    if (event.key === '/') {
        event.preventDefault();
        activeVideo = activeVideo === 1 ? 2 : 1;
        showControlNotification(`Controlling Video ${activeVideo}`);
        return;
    }
    // "'" key: Swap videos
    if (event.key === "'") {
        event.preventDefault();
        swapVideos();
        return;
    }
    // Enter: Set Sync Point (only before sync is set)
    if (event.key === 'Enter') {
        event.preventDefault();
        if (!isSynced) setSyncPoint();
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
        skipTime(-5);
        return;
    }
    if (event.key === 'ArrowRight') {
        event.preventDefault();
        skipTime(5);
        return;
    }

    // '.' next frame, ',' previous frame (no Shift)
    if (!event.shiftKey && (event.code === 'Period' || event.key === '.')) {
        event.preventDefault();
        stepFrame(+1);
        return;
    }
    if (!event.shiftKey && (event.code === 'Comma' || event.key === ',')) {
        event.preventDefault();
        stepFrame(-1);
        return;
    }

    // Shift + '.' increase speed, Shift + ',' decrease speed
    if (event.shiftKey && (event.code === 'Period' || event.key === '.' || event.key === '>')) {
        event.preventDefault();
        bumpSpeed(+1);
        return;
    }
    if (event.shiftKey && (event.code === 'Comma' || event.key === ',' || event.key === '<')) {
        event.preventDefault();
        bumpSpeed(-1);
        return;
    }

    // Numpad transform/move hotkeys for active video
    const code = event.code;
    const alt = event.altKey;
    const ctrl = event.ctrlKey;
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

function skipTime(seconds) {
    const activeVid = activeVideo === 1 ? video1 : video2;
    const otherVid = activeVideo === 1 ? video2 : video1;

    const newTime = Math.max(0, Math.min(activeVid.duration || 0, (activeVid.currentTime || 0) + seconds));
    activeVid.currentTime = newTime;

    if (isSynced) {
        // Calculate synced time for the other video
        let syncedTime;
        if (activeVideo === 1) {
            syncedTime = newTime - syncPoint1 + syncPoint2 + delay;
        } else {
            // When controlling video2, calculate video1's time
            syncedTime = newTime - syncPoint2 - delay + syncPoint1;
        }

        if (syncedTime >= 0 && syncedTime <= (otherVid.duration || 0)) {
            otherVid.currentTime = syncedTime;
            lastSyncTime = Date.now(); // Update last sync time to prevent immediate re-sync
        }
    }
}

// Frame stepping (approximate). Uses 1/30s per frame.
const FRAME_STEP_SECONDS = 1 / 30;
function stepFrame(direction) {
    try { video1.pause(); } catch { }
    try { video2.pause(); } catch { }
    const step = (direction >= 0 ? 1 : -1) * FRAME_STEP_SECONDS;
    skipTime(step);
}

function initializeDragging() {
    const overlay = document.getElementById('overlayPlayer');

    // Restore saved overlay geometry (position and size)
    (function restoreOverlayGeom() {
        const data = lsGet(LS_KEYS.overlayGeom);
        if (!data) return;
        try {
            const g = JSON.parse(data);
            const valid = v => typeof v === 'number' && isFinite(v) && v >= 0;
            if (g && valid(g.left) && valid(g.top) && valid(g.width) && valid(g.height)) {
                overlay.style.left = g.left + 'px';
                overlay.style.top = g.top + 'px';
                overlay.style.width = g.width + 'px';
                overlay.style.height = g.height + 'px';
                overlay.style.right = 'auto';
            }
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
        const rect = overlayEl.getBoundingClientRect();
        const geom = {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        };
        lsSet(LS_KEYS.overlayGeom, JSON.stringify(geom));
    } catch { }
}

function toggleOverlay() {
    const overlay = document.getElementById('overlayPlayer');
    overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
}

// Initialize everything when page loads
document.addEventListener('DOMContentLoaded', initializePlayers);
