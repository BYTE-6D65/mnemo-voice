/**
 * Mnemo Voice Client
 *
 * WebSocket voice client that captures mic audio, sends to server,
 * and plays back TTS audio from the agent.
 */

class VoiceClient {
    constructor() {
        this.ws = null;
        this.audioContext = null;
        this.mediaStream = null;
        this.scriptProcessor = null;
        this.analyser = null;
        this.isRecording = false;
        this.isPlaying = false;
        this.audioQueue = [];
        this.playbackSource = null;

        // DOM
        this.statusDot = document.getElementById('statusDot');
        this.statusText = document.getElementById('statusText');
        this.micBtn = document.getElementById('micBtn');
        this.chatLog = document.getElementById('chatLog');
        this.textInput = document.getElementById('textInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.canvas = document.getElementById('visualizer');
        this.canvasCtx = this.canvas.getContext('2d');

        this.sampleRate = 16000;

        this.connect();
        this.setupUI();
        this.startVisualizer();
    }

    // ── Connection ──────────────────────────────────────────

    connect() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws`;
        this.log('system', `Connecting to ${url}...`);

        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.log('system', 'Connected');
            this.setStatus('connected', 'Connected — press mic to talk');
        };

        this.ws.onclose = () => {
            this.log('system', 'Disconnected');
            this.setStatus('disconnected', 'Disconnected — reconnecting...');
            setTimeout(() => this.connect(), 3000);
        };

        this.ws.onerror = (err) => {
            this.log('system', 'Connection error');
        };

        this.ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                this.handleJSON(JSON.parse(event.data));
            } else if (event.data instanceof ArrayBuffer) {
                this.handleAudio(event.data);
            }
        };
    }

    // ── Audio Capture ───────────────────────────────────────

    async startRecording() {
        if (this.isRecording) return;

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: this.sampleRate,
        });

        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.sampleRate,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                }
            });
        } catch (err) {
            this.log('system', `Mic access denied: ${err.message}`);
            return;
        }

        const source = this.audioContext.createMediaStreamSource(this.mediaStream);

        // Analyser for waveform visualization
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        source.connect(this.analyser);

        // Script processor to capture raw PCM
        const bufferSize = 4096;
        this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
        this.scriptProcessor.onaudioprocess = (e) => {
            if (!this.isRecording) return;
            const float32 = e.inputBuffer.getChannelData(0);
            const int16 = this.float32ToInt16(float32);
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(int16.buffer);
            }
        };

        source.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.audioContext.destination);

        this.isRecording = true;
        this.micBtn.classList.add('active');
        this.log('system', '🎤 Listening...');
    }

    stopRecording() {
        if (!this.isRecording) return;

        this.isRecording = false;
        this.micBtn.classList.remove('active');

        if (this.scriptProcessor) {
            this.scriptProcessor.disconnect();
            this.scriptProcessor = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        if (this.audioContext && !this.isPlaying) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.log('system', '⏹ Stopped listening');
    }

    // ── Audio Playback ──────────────────────────────────────

    handleAudio(arrayBuffer) {
        this.audioQueue.push(arrayBuffer);
        if (!this.isPlaying) {
            this.playQueue();
        }
    }

    async playQueue() {
        this.isPlaying = true;
        this.micBtn.classList.add('speaking');

        while (this.audioQueue.length > 0) {
            const chunk = this.audioQueue.shift();
            await this.playChunk(chunk);
        }

        this.isPlaying = false;
        this.micBtn.classList.remove('speaking');
    }

    playChunk(arrayBuffer) {
        return new Promise((resolve) => {
            if (!this.audioContext || this.audioContext.state === 'closed') {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: this.sampleRate,
                });
            }

            const int16 = new Int16Array(arrayBuffer);
            const float32 = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) {
                float32[i] = int16[i] / 32768.0;
            }

            const audioBuffer = this.audioContext.createBuffer(1, float32.length, this.sampleRate);
            audioBuffer.getChannelData(0).set(float32);

            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioContext.destination);
            source.onended = resolve;
            source.start(0);
        });
    }

    stopPlayback() {
        this.audioQueue = [];
        this.isPlaying = false;
        this.micBtn.classList.remove('speaking');
        // Send barge-in
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'barge_in' }));
        }
    }

    // ── Message Handling ────────────────────────────────────

    handleJSON(msg) {
        switch (msg.type) {
            case 'connected':
                this.sampleRate = msg.data?.sample_rate || 16000;
                break;
            case 'speech_start':
                this.setStatus('connected', '🎤 Hearing speech...');
                break;
            case 'speech_end':
                this.setStatus('thinking', 'Processing...');
                break;
            case 'transcribing':
                this.setStatus('thinking', 'Transcribing...');
                break;
            case 'transcription':
                this.log('user', msg.data.text);
                break;
            case 'transcription_empty':
                this.setStatus('connected', 'Connected — didn\'t catch that');
                break;
            case 'agent_thinking':
                this.setStatus('thinking', 'Thinking...');
                break;
            case 'agent_response':
                this.log('agent', msg.data.text);
                break;
            case 'audio_start':
                this.setStatus('connected', '🔊 Speaking...');
                break;
            case 'audio_end':
                this.setStatus('connected', 'Connected — press mic to talk');
                break;
            case 'audio_error':
                this.log('system', `Audio error: ${msg.data.error}`);
                break;
        }
    }

    // ── Visualizer ──────────────────────────────────────────

    startVisualizer() {
        const draw = () => {
            requestAnimationFrame(draw);
            const { width, height } = this.canvas;
            this.canvasCtx.fillStyle = '#111118';
            this.canvasCtx.fillRect(0, 0, width, height);

            if (!this.analyser || !this.isRecording) {
                // Draw flat line
                this.canvasCtx.strokeStyle = '#333';
                this.canvasCtx.lineWidth = 1;
                this.canvasCtx.beginPath();
                this.canvasCtx.moveTo(0, height / 2);
                this.canvasCtx.lineTo(width, height / 2);
                this.canvasCtx.stroke();
                return;
            }

            const bufferLength = this.analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            this.analyser.getByteTimeDomainData(dataArray);

            this.canvasCtx.lineWidth = 2;
            this.canvasCtx.strokeStyle = this.isPlaying ? '#4ade80' : '#a78bfa';
            this.canvasCtx.beginPath();

            const sliceWidth = width / bufferLength;
            let x = 0;
            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * height / 2;
                if (i === 0) {
                    this.canvasCtx.moveTo(x, y);
                } else {
                    this.canvasCtx.lineTo(x, y);
                }
                x += sliceWidth;
            }
            this.canvasCtx.lineTo(width, height / 2);
            this.canvasCtx.stroke();
        };
        draw();
    }

    // ── UI ──────────────────────────────────────────────────

    setupUI() {
        // Mic button — push to talk
        this.micBtn.addEventListener('mousedown', () => {
            if (this.isPlaying) {
                this.stopPlayback();
            }
            this.startRecording();
        });
        this.micBtn.addEventListener('mouseup', () => this.stopRecording());
        this.micBtn.addEventListener('mouseleave', () => {
            if (this.isRecording) this.stopRecording();
        });

        // Touch support
        this.micBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (this.isPlaying) {
                this.stopPlayback();
            }
            this.startRecording();
        });
        this.micBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.stopRecording();
        });

        // Text input
        this.sendBtn.addEventListener('click', () => this.sendText());
        this.textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendText();
        });

        // Resize canvas
        const resizeCanvas = () => {
            const rect = this.canvas.parentElement.getBoundingClientRect();
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
        };
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
    }

    sendText() {
        const text = this.textInput.value.trim();
        if (!text || this.ws.readyState !== WebSocket.OPEN) return;

        this.ws.send(JSON.stringify({ type: 'text_input', text }));
        this.log('user', text);
        this.textInput.value = '';
    }

    setStatus(state, text) {
        this.statusDot.className = `status-dot ${state}`;
        this.statusText.textContent = text;
    }

    log(role, text) {
        const entry = document.createElement('div');
        entry.className = `chat-entry ${role}`;

        const time = document.createElement('span');
        time.className = 'timestamp';
        time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        entry.appendChild(time);
        entry.appendChild(document.createTextNode(text));
        this.chatLog.appendChild(entry);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }

    // ── Utils ───────────────────────────────────────────────

    float32ToInt16(float32Array) {
        const int16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16;
    }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
    new VoiceClient();
});
