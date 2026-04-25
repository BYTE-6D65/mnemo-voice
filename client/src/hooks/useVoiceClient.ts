import { useState, useEffect, useRef, useCallback } from 'react'

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
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const isRecordingRef = useRef(false)

  const [connection, setConnection] = useState<ConnectionState>('disconnected')
  const [agentState, setAgentState] = useState<AgentState>('idle')
  const [chatLog, setChatLog] = useState<ChatEntry[]>([])
  const [sampleRate, setSampleRate] = useState(16000)
  const addLog = useCallback((role: ChatEntry['role'], text: string) => {
    setChatLog(prev => [...prev, { role, text, ts: Date.now() }])
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
        break
      case 'agent_response': {
        const text = event.data?.text as string
        if (text) addLog('agent', text)
        break
      }
      case 'audio_start':
        setAgentState('speaking')
        break
      case 'audio_end':
        setAgentState('idle')
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

    ws.onopen = () => {}
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        handleEvent(JSON.parse(e.data))
      } else if (e.data instanceof ArrayBuffer) {
        playAudioChunk(e.data)
      }
    }
    ws.onclose = () => {
      setConnection('disconnected')
      setAgentState('idle')
      // Auto-reconnect
      setTimeout(() => connect(), 3000)
    }
    ws.onerror = () => {
      addLog('system', 'Connection error')
    }
  }, [url, handleEvent, addLog])

  // Disconnect
  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  // Audio playback
  const playAudioChunk = useCallback((buffer: ArrayBuffer) => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate })
    }
    const ctx = audioCtxRef.current

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
    source.start(0)
  }, [sampleRate])

  // Start recording
  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return

    const ctx = new AudioContext({ sampleRate })
    audioCtxRef.current = ctx

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
      return
    }

    streamRef.current = stream
    const source = ctx.createMediaStreamSource(stream)

    // Analyser for waveform
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyserRef.current = analyser
    source.connect(analyser)

    // Script processor for raw PCM capture
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    processorRef.current = processor
    processor.onaudioprocess = (e) => {
      if (!isRecordingRef.current) return
      const float32 = e.inputBuffer.getChannelData(0)
      const int16 = new Int16Array(float32.length)
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]))
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(int16.buffer)
      }
    }
    source.connect(processor)
    processor.connect(ctx.destination)

    isRecordingRef.current = true
    setAgentState('listening')
  }, [sampleRate, addLog])

  // Stop recording
  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) return
    isRecordingRef.current = false

    processorRef.current?.disconnect()
    processorRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null

    if (agentState === 'listening') {
      setAgentState('idle')
    }
  }, [agentState])

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
    chatLog,
    analyser: analyserRef.current,
    startRecording,
    stopRecording,
    bargeIn,
    sendText,
  }
}

export default useVoiceClient
