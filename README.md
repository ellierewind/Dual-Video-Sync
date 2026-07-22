# Dual Video Sync

A local dual-video player that can run in a browser (`index.html`) or as an Electron desktop app.

## Features

-   **Dual Video Playback**: Load and play two separate video files side-by-side.
-   **Synchronization**:
    -   Sync videos by setting a common sync point.
    -   Seek in one video and the other automatically updates to the synchronized time.
    -   Play/Pause syncs across both players.
-   **Independent & Global Controls**:
    -   Control speed (playback rate) globally or individually.
    -   Use on-screen speed up/down buttons on both players.
    -   Use keyboard shortcuts to step playback speed up to `4x`, with `0.1x` steps above `2x`.
    -   Step forward or backward one frame at a time, including continuous stepping while a frame key is held.
    -   Volume control with fine granularity for both players.
    -   Mute/Unmute toggles.
-   **Overlay Mode**: Secondary video can be resized, moved, and overlayed on the primary video.
-   **Subtitle Support**: Load `.srt`, `.ass`, and `.ssa` files for both videos. The Electron app dynamically renders embedded MKV VobSub, Blu-ray PGS, and fully styled ASS/SSA tracks over the original video.
-   **Embedded Audio Support**: The Electron app converts selected AC-3, E-AC-3, DTS, and DTS-HD tracks to a fast local PCM audio cache without transcoding the video.
-   **Transform Controls**: (Keyboard shortcuts) Zoom, stretch, flip, and rotate videos.
-   **Profiles**: Save/load multiple layout profiles (video transforms + overlay position/size).
-   **Persistence**: Saves playback rate, transforms, overlay geometry, and profiles between sessions.

## Electron-only Features

-   **Remembers Last Videos** to automatically reopen the last video used in Player 1 and Player 2.
-   **Remembers Playback Session** including the latest timestamps and sync point across app restarts.
-   **Frame-rate-aware timestamps and stepping** using `ffprobe` metadata when available, with a `30 fps` fallback.
-   **Popped-out Player 2 synchronization** for seeking, frame stepping, playback controls, and sync-point capture.
-   **Paired window lifecycle** so closing either app window also closes its companion window.
-   **Native file picker integration** for `Choose Video 1` / `Choose Video 2`.
-   **Dynamic MKV bitmap subtitle overlays** using the MIT-licensed `libbitsub` WASM renderer for VobSub and Blu-ray PGS. The selected subtitle stream is copied to a small cache while the untouched original MKV begins playback normally.
-   **Full ASS/SSA rendering** through JASSUB's WebAssembly/WebGL port of `libass`, preserving authored styles, positioning, animation, karaoke, drawings, and MKV font attachments without burning subtitles into the video.
-   Standalone `.ass` and `.ssa` files use the same libass renderer and remain available across relaunches, player swaps, and Player 2 pop-out/docking.
-   **Cached AC-3/DTS-family audio** using the bundled FFmpeg decoder. Audio selection, pause, seeking, speed, volume, mute, swapping, and popped-out Player 2 remain tied to the original video timeline.
-   **Experimental GPU HDR-to-SDR tone mapping** using WebGL on the original Chromium video frames, with automatic HDR detection, MPC Video Renderer's PQ/Hable conversion sequence, BT.2020-to-BT.709 conversion, dithering, and an adjustable `25-400` nit SDR target.
-   **Last-loaded video persistence** per player across app restarts.
-   **Windows `.exe` packaging** via the `electron/` project.

## Usage

1.  **Load Videos**:
    -   Click "Choose Video 1" to load the main video.
    -   Click "Choose Video 2" via the overlay controls to load the secondary video.
2.  **Sync**:
    -   Find a matching event in both videos.
    -   Click "Set Sync Point" to lock their relative timing.
3.  **Controls**:
    -   Use the on-screen controls for playback, volume, and speed.
    -   Use `.` and `,` to step one frame forward or backward; hold either key for continuous stepping.
    -   Use `Shift + .` and `Shift + ,` to raise or lower playback speed, up to `4x`.
    -   Mouse wheel over a video player adjusts its volume.
    -   Double-click either player, or use its fullscreen button, to toggle fullscreen.
    -   `Enter` sets the sync point (only when not currently synced).
    -   `Ctrl + Shift + Enter` clears the current sync so you can set a new sync point.
    -   `Ctrl + Shift + P` resets both timestamps to `0` and clears the current sync.
    -   `Ctrl + Z` undoes the last sync/timestamp command; `Ctrl + Y` or `Ctrl + Shift + Z` redoes it.
    -   `F5` reloads the app window.
    -   `Ctrl + Alt + Shift + <number>` saves a profile slot (`0-9`).
    -   `Ctrl + Shift + <number>` loads that profile slot (`0-9`).
    -   `Ctrl + Shift + \`` (same key as `~`) opens/closes the profile menu to load profiles and rename them.

## Install

-   **Browser mode (no Electron)**: open `index.html` directly.
-   **Electron run**:
    -   `cd electron`
    -   `npm install`
    -   `npm start`
-   **Build Windows installer**:
    -   `cd electron`
    -   `npm run dist:win` (outputs to `electron/dist/`)

## MKV subtitle notes

-   The original video is never transcoded, remuxed, or replaced with a proxy. It is assigned directly to the native video element.
-   Only the selected bitmap subtitle stream is copied: VobSub uses a small cached `.mks` file and PGS uses a raw `.sup` file. `libbitsub` decodes the bitmap cues and synchronizes a transparent canvas with the video while it plays and seeks.
-   Selected ASS/SSA streams are copied losslessly to the subtitle cache and rendered with JASSUB/libass. Attached OpenType, TrueType, WOFF, and WOFF2 fonts are extracted and passed directly to libass so authored typesetting is retained.
-   Track selection defaults to English when an English supported subtitle stream is available. Every embedded VobSub, PGS, ASS, or SSA track can be selected—or turned off—from each player's settings menu, and manual choices are remembered per player/video.
-   A visible overlay reports subtitle extraction/loading while it runs, with persistent ready/error status in the track menu. Existing subtitle toggle and size controls also apply to the bitmap overlay.
-   FFmpeg/ffprobe provide stream discovery and subtitle-only extraction; their packaged license and build-source notices remain alongside the binaries.

## Embedded audio notes

-   The original video stream remains untouched. For codecs Chromium cannot normally play, FFmpeg converts the complete selected audio track to a finite 48 kHz stereo PCM WAV file before playback. The conversion avoids a slow audio encoder and reports progress in the player UI.
-   Playback uses the converted audio after the complete selected track is ready. The video itself is never processed and no full-video proxy is created.
-   Each player's settings menu lists every embedded audio track plus the original/default Chromium path. AC-3, E-AC-3, DTS, DTS-HD, and TrueHD tracks use dynamic decoding by default when selected.
-   The selected audio track is remembered per player/video. Converted WAV files are cached and reused; seeking uses the same finite file immediately and follows playback rate, volume, and mute state without restarting FFmpeg.

## HDR-to-SDR notes

-   Enable `Convert HDR to SDR` in either player's settings menu and set the SDR display brightness in nits. The setting applies to both players so their presentation path remains matched.
-   Chromium remains responsible for decoding, playback, seeking, audio, and the media clocks. WebGL uploads the exact currently presented video frame with browser color conversion disabled; it never creates a proxy or re-encodes the video.
-   SDR and non-PQ HDR sources stay on Chromium's native video path. HDR metadata comes from the existing `ffprobe` inspection; the custom nits-based shader currently applies to HDR10/PQ sources.
-   Chromium exposes the uploaded frame to WebGL as an 8-bit RGB texture. Tone mapping is real, but this prototype cannot provide a fully 10-bit pipeline and may show more banding than a native renderer such as libplacebo.
-   Run `window.hdrToneMapping.getMetrics()` in DevTools to inspect rendered frames, callback gaps/lateness, Chromium dropped frames, canvas resolution, and whether the frame path is zero-copy.
