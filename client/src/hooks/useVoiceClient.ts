import { useState, useEffect, useRef, useCallback } from 'react'
import type { AvatarOverride, ExpressionName } from '../avatar/types'

// ── Types ──────────────────────────────────────────────────

interface ServerEvent {
  type: string
  data?: Record<string, unknown>
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected'
type AgentState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

interface ChatEntry {
  role: 'user' | 'agent' | 'system'
  text: string
  ts: number
}

// ── Voice Client Hook ──────────────────────────────────────

function useVoiceClient(url: string) {
  const wsRef = useRef<WebSocket | null>(null)
  // Separate contexts: playback and mic capture must not share/close each other
  const playbackCtxRef = useRef<AudioContext | null>(null)
  const captureCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const isRecordingRef = useRef(false)
  // Scheduling: tracks when the next chunk should start playing
  const nextStartTimeRef = useRef(0)

  const [connection, setConnection] = useState<ConnectionState>('disconnected')
  const [agentState, setAgentState] = useState<AgentState>('idle')
  const [chatLog, setChatLog] = useState<ChatEntry[]>([])
  const [sampleRate, setSampleRate] = useState(16000)
  const [isRecording, setIsRecording] = useState(false)
  const [agentStatus, setAgentStatus] = useState<string | null>(null)
  const [avatarOverride, setAvatarOverride] = useState<AvatarOverride | null>(null)

  // Parse [expression:X] and [look:Y] tags from agent text.
  // Returns { cleanText, override }.
  const parseAvatarTags = useCallback((text: string): { cleanText: string; override: AvatarOverride } => {
    const override: AvatarOverride = {}
    // [expression:happy] [expression:angry,surprised:0.5] etc.
    const exprRegex = /\[expression:([^\]]+)\]/g
    // [look:left] [look:right] [look:up] [look:down]
    const lookRegex = /\[look:(left|right|up|down)\]/g

    let cleanText = text

    // Parse expression tags
    let match: RegExpExecArray | null
    const exprMap: Partial<Record<ExpressionName, number>> = {}
    exprRegex.lastIndex = 0
    while ((match = exprRegex.exec(text)) !== null) {
      const raw = match[1]
      // Support comma-separated: "happy,surprised:0.3"
      for (const part of raw.split(',')) {
        const [name, weightStr] = part.trim().split(':')
        const weight = weightStr ? parseFloat(weightStr) : 1.0
        if (['happy', 'angry', 'sad', 'surprised', 'neutral', 'relaxed', 'lookUp', 'lookDown'].includes(name.trim())) {
          (exprMap as Record<string, number>)[name.trim()] = weight
        }
      }
      cleanText = cleanText.replace(match[0], '')
    }
    if (Object.keys(exprMap).length > 0) override.expression = exprMap

    // Parse look tags
    lookRegex.lastIndex = 0
    while ((match = lookRegex.exec(text)) !== null) {
      const dir = match[1]
      const lookMap: Record<string, { x: number; y: number; z: number }> = {
        left:  { x: -0.7, y: 0, z: -0.7 },
        right: { x:  0.7, y: 0, z: -0.7 },
        up:    { x: 0, y:  0.7, z: -0.7 },
        down:  { x: 0, y: -0.5, z: -0.7 },
      }
      if (lookMap[dir]) override.lookAt = lookMap[dir]
      cleanText = cleanText.replace(match[0], '')
    }

    // [tilt:left] [tilt:right] [tilt:0.3] (radians)
    const tiltRegex = /\[tilt:(left|right|[\d.\-]+)\]/g
    tiltRegex.lastIndex = 0
    while ((match = tiltRegex.exec(text)) !== null) {
      const val = match[1]
      if (val === 'left') override.headTilt = -0.8
      else if (val === 'right') override.headTilt = 0.8
      else override.headTilt = parseFloat(val)
      cleanText = cleanText.replace(match[0], '')
    }

    return { cleanText: cleanText.trim(), override }
  }, [])

  const addLog = useCallback((role: ChatEntry['role'], text: string) => {
    setChatLog(prev => [...prev, { role, text, ts: Date.now() }])
  }, [])

  const logDebug = useCallback((message: string, data?: unknown) => {
    console.debug(`[voice] ${message}`, data ?? '')
  }, [])

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'connected':
        setSampleRate((event.data?.sample_rate as number) || 16000)
        setConnection('connected')
        setAgentState('idle')
        addLog('system', 'Connected to voice server')
        break
      case 'speech_start':
        setAgentState('listening')
        break
      case 'speech_end':
        setAgentState('transcribing')
        break
      case 'transcribing':
        setAgentState('transcribing')
        break
      case 'transcription': {
        const text = event.data?.text as string
        if (text) addLog('user', text)
        break
      }
      case 'transcription_empty':
        setAgentState('idle')
        break
      case 'agent_thinking':
        setAgentState('thinking')
        setAgentStatus('Thinking...')
        break
      case 'agent_response': {
        const rawText = event.data?.text as string
        if (rawText) {
          const { cleanText, override } = parseAvatarTags(rawText)
          if (cleanText) addLog('agent', cleanText)
          if (override.expression || override.lookAt) {
            setAvatarOverride(override)
            // Clear override after 4 seconds so it doesn't stick forever
            setTimeout(() => setAvatarOverride(null), 4000)
          }
        }
        setAgentStatus(null)
        break
      }
      case 'agent_status': {
        const action = event.data?.action as string
        if (action) setAgentStatus(action)
        break
      }
      case 'audio_start':
        // Reset playback schedule for new utterance
        nextStartTimeRef.current = 0
        setAgentState('speaking')
        break
      case 'audio_end':
        setAgentState('idle')
        setAgentStatus(null)
        break
      case 'audio_error':
        addLog('system', `Audio error: ${event.data?.error}`)
        setAgentState('idle')
        break
    }
  }, [addLog])

  // Connect
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    setConnection('connecting')
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => logDebug('websocket open', { url })
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        handleEvent(JSON.parse(e.data))
      } else if (e.data instanceof ArrayBuffer) {
        playAudioChunk(e.data)
      }
    }
    ws.onclose = () => {
      logDebug('websocket closed')
      isRecordingRef.current = false
      setIsRecording(false)
      setConnection('disconnected')
      setAgentState('idle')
      setAgentStatus(null)
      // Auto-reconnect
      setTimeout(() => connect(), 3000)
    }
    ws.onerror = () => {
      logDebug('websocket error')
      addLog('system', 'Connection error')
    }
  }, [url, handleEvent, addLog, logDebug])

  // Disconnect
  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  // Audio playback — schedules chunks sequentially so they don't overlap
  const playAudioChunk = useCallback((buffer: ArrayBuffer) => {
    // Use a dedicated playback context, separate from mic capture
    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AudioContext({ sampleRate })
      nextStartTimeRef.current = 0
    }
    const ctx = playbackCtxRef.current

    const int16 = new Int16Array(buffer)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate)
    audioBuffer.getChannelData(0).set(float32)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)

    // Schedule this chunk right after the previous one ends
    const now = ctx.currentTime
    const startTime = Math.max(now, nextStartTimeRef.current)
    source.start(startTime)
    nextStartTimeRef.current = startTime + audioBuffer.duration
  }, [sampleRate])

  // Start recording
  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return

    if (!navigator.mediaDevices?.getUserMedia) {
      const msg = window.isSecureContext
        ? 'getUserMedia is unavailable in this browser/context'
        : 'mic requires a secure context: use localhost or HTTPS'
      addLog('system', `Mic unavailable: ${msg}`)
      logDebug('mic capability missing', {
        origin: location.origin,
        isSecureContext: window.isSecureContext,
        hasMediaDevices: Boolean(navigator.mediaDevices),
      })
      return
    }

    // Separate capture context — closing this won't kill playback
    const ctx = new AudioContext({ sampleRate })
    captureCtxRef.current = ctx

    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    if (!ctx.audioWorklet) {
      addLog('system', 'AudioWorklet is unavailable in this browser')
      await ctx.close()
      captureCtxRef.current = null
      return
    }

    await ctx.audioWorklet.addModule('/pcm-capture-worklet.js')
    logDebug('audio context ready', {
      requestedSampleRate: sampleRate,
      actualSampleRate: ctx.sampleRate,
      state: ctx.state,
    })

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      addLog('system', `Mic access denied: ${msg}`)
      await ctx.close()
      captureCtxRef.current = null
      return
    }

    streamRef.current = stream
    const source = ctx.createMediaStreamSource(stream)

    // Analyser for waveform
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyserRef.current = analyser
    source.connect(analyser)

    // AudioWorklet for raw PCM capture. ScriptProcessorNode is deprecated and
    // also runs on the main thread, which is exactly where realtime audio gets sad.
    const processor = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    })
    processorRef.current = processor
    processor.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!isRecordingRef.current) return
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(e.data)
      }
    }
    source.connect(processor)
    processor.connect(ctx.destination)

    isRecordingRef.current = true
    setIsRecording(true)
    setAgentState('listening')
    addLog('system', 'Mic capture started')
  }, [sampleRate, addLog, logDebug])

  // Stop recording
  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) return
    isRecordingRef.current = false
    setIsRecording(false)

    processorRef.current?.disconnect()
    processorRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    // Only close the capture context — playback stays alive
    void captureCtxRef.current?.close()
    captureCtxRef.current = null

    if (agentState === 'listening') {
      setAgentState('idle')
    }
    addLog('system', 'Mic capture stopped')
  }, [agentState, addLog])

  // Barge in
  const bargeIn = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'barge_in' }))
    }
  }, [])

  // Send text
  const sendText = useCallback((text: string) => {
    if (!text.trim()) return
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ type: 'text_input', text }))
    addLog('user', text)
  }, [addLog])

  // Auto-connect on mount
  useEffect(() => {
    connect()
    return () => { disconnect() }
  }, [connect, disconnect])

  return {
    connection,
    agentState,
    agentStatus,
    isRecording,
    chatLog,
    analyser: analyserRef.current,
    avatarOverride,
    startRecording,
    stopRecording,
    bargeIn,
    sendText,
  }
}

export default useVoiceClient
