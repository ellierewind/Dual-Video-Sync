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
-   **Subtitle Support**: Load `.srt` files for both videos with basic formatting support and responsive line wrapping.
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
