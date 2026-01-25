# Dual Video Sync

A local web application for playing and synchronizing two video files simultaneously.

## Features

-   **Dual Video Playback**: Load and play two separate video files side-by-side.
-   **Synchronization**:
    -   Sync videos by setting a common sync point.
    -   Seek in one video and the other automatically updates to the synchronized time.
    -   Play/Pause syncs across both players.
-   **Independent & Global Controls**:
    -   Control speed (playback rate) globally or individually.
    -   Volume control with fine granularity for both players.
    -   Mute/Unmute toggles.
-   **Overlay Mode**: Secondary video can be resized, moved, and overlayed on the primary video.
-   **Subtitle Support**: Load `.srt` files for both videos with basic formatting support.
-   **Transform Controls**: (Keyboard shortcuts) Zoom, stretch, flip, and rotate videos.
-   **Persistence**: Saves playback rate and overlay geometry between sessions.

## Usage

1.  **Load Videos**:
    -   Click "Choose Video 1" to load the main video.
    -   Click "Choose Video 2" via the overlay controls to load the secondary video.
2.  **Sync**:
    -   Find a matching event in both videos.
    -   Click "Set Sync Point" to lock their relative timing.
3.  **Controls**:
    -   Use the on-screen controls for playback, volume, and speed.
    -   Mouse wheel over a video player adjusts its volume.
    -   Double-click the main player to toggle fullscreen.
