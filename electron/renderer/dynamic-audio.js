(() => {
    const HARD_SYNC_DRIFT_SECONDS = 0.35;

    function clampVolume(value) {
        const volume = Number(value);
        return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    }

    class DynamicAudioPlayer {
        constructor({ video, electronAPI, onStatus }) {
            if (!video) throw new Error('Converted audio requires a video element.');
            this.video = video;
            this.electronAPI = electronAPI;
            this.onStatus = typeof onStatus === 'function' ? onStatus : () => { };
            this.audio = document.createElement('audio');
            this.audio.hidden = true;
            this.audio.preload = 'auto';
            this.audio.setAttribute('aria-hidden', 'true');
            document.body.appendChild(this.audio);
            this.track = null;
            this.filePath = null;
            this.cacheKey = null;
            this.requestId = null;
            this.expectedSourceUrl = '';
            this.generation = 0;
            this.ready = false;
            this.disposed = false;
            this.userMuted = !!video.muted;
            this.forcingNativeMute = false;
            this.conversionProgress = 0;
            this.playAttempts = 0;
            this.playSuccesses = 0;
            this.waitingEvents = 0;
            this.stalledEvents = 0;
            this.lastPlayError = '';
            this.bound = [];
            this.removeProgressListener = this.electronAPI?.onDynamicAudioProgress?.((payload) => {
                this.handleConversionProgress(payload);
            }) || null;
            this.bindEvents();
        }

        bind(target, eventName, listener) {
            target.addEventListener(eventName, listener);
            this.bound.push(() => target.removeEventListener(eventName, listener));
        }

        bindEvents() {
            this.bind(this.video, 'play', () => this.handleVideoPlay());
            this.bind(this.video, 'pause', () => this.handleVideoPause());
            this.bind(this.video, 'seeking', () => this.handleVideoSeeking());
            this.bind(this.video, 'seeked', () => this.handleVideoSeeked());
            this.bind(this.video, 'ratechange', () => this.applyPlaybackRate());
            this.bind(this.video, 'volumechange', () => this.handleNativeVolumeChange());
            this.bind(this.video, 'timeupdate', () => this.synchronize());
            this.bind(this.audio, 'loadedmetadata', () => this.handleAudioReady());
            this.bind(this.audio, 'canplay', () => this.handleAudioReady());
            this.bind(this.audio, 'playing', () => {
                if (!this.hasTrack() || !this.hasExpectedSource()) return;
                this.ready = true;
                this.onStatus('ready', `Playing ${this.describeTrack()}`);
            });
            this.bind(this.audio, 'waiting', () => {
                this.waitingEvents += 1;
                if (this.ready && !this.video.paused) this.onStatus('loading', `Buffering ${this.describeTrack()}...`);
            });
            this.bind(this.audio, 'stalled', () => {
                this.stalledEvents += 1;
                if (this.ready) this.onStatus('loading', `Buffering ${this.describeTrack()}...`);
            });
            this.bind(this.audio, 'error', () => {
                if (!this.hasTrack() || !this.hasExpectedSource()) return;
                this.ready = false;
                const details = this.audio.error?.message || 'The converted audio file could not be played.';
                this.onStatus('error', details);
            });
        }

        describeTrack() {
            if (!this.track) return 'audio';
            const language = this.track.language && this.track.language !== 'und'
                ? String(this.track.language).toUpperCase()
                : 'audio';
            const codec = this.track.profile || String(this.track.codec || '').toUpperCase();
            return [language, codec].filter(Boolean).join(' - ');
        }

        hasTrack() {
            return !!(this.track && this.filePath);
        }

        async setTrack(track, filePath) {
            const nextTrack = track && Number.isInteger(Number(track.streamIndex))
                ? { ...track, streamIndex: Number(track.streamIndex) }
                : null;
            const nextFilePath = typeof filePath === 'string' && filePath ? filePath : null;
            const wasActive = this.hasTrack();
            const sameTrack = wasActive
                && nextTrack
                && Number(this.track.streamIndex) === Number(nextTrack.streamIndex)
                && this.filePath === nextFilePath;
            if (!wasActive) this.userMuted = !!this.video.muted;
            this.track = nextTrack;
            this.filePath = nextFilePath;

            if (!this.hasTrack()) {
                this.stop({ restoreNativeMute: true });
                this.onStatus('off', 'Using original audio');
                return;
            }
            this.forceNativeMute();
            if (sameTrack && (this.ready || this.requestId)) {
                this.applyOutputState();
                return;
            }
            await this.prepare();
        }

        async prepare() {
            if (!this.hasTrack() || this.disposed) return;
            const generation = ++this.generation;
            const requestId = `${Date.now()}-${generation}-${this.track.streamIndex}`;
            this.requestId = requestId;
            this.cacheKey = null;
            this.ready = false;
            this.conversionProgress = 0;
            this.expectedSourceUrl = '';
            this.audio.pause();
            this.clearAudioSource();
            this.onStatus('loading', `Converting ${this.describeTrack()}... 0%`);

            try {
                const result = await this.electronAPI.prepareDynamicAudioTrack(
                    this.filePath,
                    this.track.streamIndex,
                    requestId
                );
                if (generation !== this.generation || !this.hasTrack()) return;
                if (!result?.url || !result?.cacheKey) throw new Error('The audio conversion did not create a file.');
                this.requestId = null;
                this.cacheKey = result.cacheKey;
                this.conversionProgress = 1;
                this.expectedSourceUrl = result.url;
                this.audio.src = result.url;
                this.applyOutputState();
                this.audio.load();
                this.onStatus('loading', `Loading ${this.describeTrack()}...`);
            } catch (error) {
                if (generation !== this.generation) return;
                this.requestId = null;
                this.onStatus('error', error?.message || 'Could not convert the selected audio track.');
            }
        }

        handleConversionProgress(payload) {
            if (!payload || payload.requestId !== this.requestId || !this.hasTrack()) return;
            this.conversionProgress = Math.max(0, Math.min(1, Number(payload.progress) || 0));
            const percent = Math.max(0, Math.min(100, Math.round(this.conversionProgress * 100)));
            this.onStatus('loading', `Converting ${this.describeTrack()}... ${percent}%`);
        }

        clearAudioSource() {
            this.audio.removeAttribute('src');
            try { this.audio.load(); } catch { }
        }

        stop({ restoreNativeMute = false } = {}) {
            this.generation += 1;
            this.requestId = null;
            this.cacheKey = null;
            this.ready = false;
            this.expectedSourceUrl = '';
            this.audio.pause();
            this.clearAudioSource();
            if (restoreNativeMute) this.restoreNativeMute();
        }

        handleVideoSeeking() {
            if (!this.hasTrack() || !this.ready) return;
            this.audio.pause();
            this.alignToVideo();
        }

        handleVideoSeeked() {
            if (!this.hasTrack() || !this.ready) return;
            this.alignToVideo();
            if (!this.video.paused) this.playAudio();
        }

        handleVideoPlay() {
            if (!this.hasTrack()) return;
            this.forceNativeMute();
            if (!this.ready) return;
            this.synchronize(true);
            this.playAudio();
        }

        handleVideoPause() {
            this.audio.pause();
            if (this.hasTrack() && this.ready) this.onStatus('ready', `Ready: ${this.describeTrack()}`);
        }

        handleAudioReady() {
            if (!this.hasTrack() || !this.hasExpectedSource() || this.audio.readyState < 2) return;
            if (!this.ready) {
                this.ready = true;
                this.alignToVideo();
            }
            this.applyOutputState();
            if (!this.video.paused) this.playAudio();
            else this.onStatus('ready', `Ready: ${this.describeTrack()}`);
        }

        alignToVideo() {
            const target = Math.max(0, Number(this.video.currentTime) || 0);
            try { this.audio.currentTime = target; } catch { }
        }

        synchronize(force = false) {
            if (!this.hasTrack() || !this.ready || !this.audio.src) return;
            if (this.video.paused) {
                if (!this.audio.paused) this.audio.pause();
                return;
            }
            const drift = (Number(this.video.currentTime) || 0) - (Number(this.audio.currentTime) || 0);
            if (force || Math.abs(drift) >= HARD_SYNC_DRIFT_SECONDS) this.alignToVideo();
            if (this.audio.paused && this.audio.readyState >= 2) this.playAudio();
        }

        applyPlaybackRate() {
            const rate = Number(this.video.playbackRate);
            if (Number.isFinite(rate) && rate > 0 && Math.abs(this.audio.playbackRate - rate) > 0.001) {
                this.audio.playbackRate = rate;
            }
        }

        playAudio() {
            if (!this.hasTrack() || !this.ready || !this.hasExpectedSource() || this.audio.readyState < 2) return;
            this.playAttempts += 1;
            this.audio.play().then(() => {
                this.playSuccesses += 1;
                this.lastPlayError = '';
            }).catch((error) => {
                this.lastPlayError = error?.message || String(error);
                this.onStatus('error', this.lastPlayError);
            });
        }

        applyOutputState() {
            this.applyPlaybackRate();
            this.audio.volume = clampVolume(this.video.volume);
            this.audio.muted = !!this.userMuted;
            this.forceNativeMute();
        }

        handleNativeVolumeChange() {
            if (!this.hasTrack() || this.forcingNativeMute) return;
            this.audio.volume = clampVolume(this.video.volume);
            if (!this.video.muted) {
                this.userMuted = false;
                this.audio.muted = false;
                this.forceNativeMute();
            }
        }

        forceNativeMute() {
            if (!this.hasTrack() || this.video.muted) return;
            this.forcingNativeMute = true;
            this.video.muted = true;
            this.forcingNativeMute = false;
        }

        restoreNativeMute() {
            this.forcingNativeMute = true;
            this.video.muted = !!this.userMuted;
            this.forcingNativeMute = false;
        }

        setVolume(value) {
            const volume = clampVolume(value);
            this.video.volume = volume;
            this.audio.volume = volume;
        }

        getMuted() {
            return this.hasTrack() ? !!this.userMuted : !!this.video.muted;
        }

        setMuted(value) {
            this.userMuted = !!value;
            if (this.hasTrack()) {
                this.audio.muted = this.userMuted;
                this.forceNativeMute();
            } else {
                this.video.muted = this.userMuted;
            }
        }

        getDebugState() {
            return {
                track: this.track ? { ...this.track } : null,
                sessionId: this.cacheKey,
                cacheKey: this.cacheKey,
                requestId: this.requestId,
                conversionProgress: this.conversionProgress,
                videoCurrentTime: Number(this.video.currentTime) || 0,
                audioCurrentTime: Number(this.audio.currentTime) || 0,
                audioReadyState: this.audio.readyState,
                audioPaused: this.audio.paused,
                audioMuted: this.audio.muted,
                audioVolume: this.audio.volume,
                audioPlaybackRate: this.audio.playbackRate,
                playAttempts: this.playAttempts,
                playSuccesses: this.playSuccesses,
                waitingEvents: this.waitingEvents,
                stalledEvents: this.stalledEvents,
                lastPlayError: this.lastPlayError,
                nativeVideoMuted: this.video.muted,
                muted: this.getMuted(),
                ready: this.ready,
                source: this.audio.currentSrc || this.audio.src || ''
            };
        }

        hasExpectedSource() {
            const source = this.audio.currentSrc || this.audio.src || '';
            if (!source || !this.expectedSourceUrl) return false;
            try { return new URL(source).href === new URL(this.expectedSourceUrl).href; } catch { return source === this.expectedSourceUrl; }
        }

        dispose() {
            this.disposed = true;
            this.track = null;
            this.filePath = null;
            this.stop({ restoreNativeMute: true });
            for (const unbind of this.bound.splice(0)) unbind();
            try { this.removeProgressListener?.(); } catch { }
            this.audio.remove();
        }
    }

    window.DynamicAudioPlayer = DynamicAudioPlayer;
})();
