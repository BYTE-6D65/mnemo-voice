import useVoiceClient from './hooks/useVoiceClient'
import WaveformVisualizer from './components/WaveformVisualizer'
import ChatLog from './components/ChatLog'

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

const STATE_LABELS: Record<string, string> = {
  idle: 'Ready',
  listening: '🎤 Hearing speech...',
  transcribing: 'Transcribing...',
  thinking: 'Thinking...',
  speaking: '🔊 Speaking...',
}

const STATE_COLORS: Record<string, string> = {
  idle: '#4ade80',
  listening: '#facc15',
  transcribing: '#facc15',
  thinking: '#facc15',
  speaking: '#4ade80',
}

export default function App() {
  const {
    connection,
    agentState,
    chatLog,
    analyser,
    startRecording,
    stopRecording,
    bargeIn,
    sendText,
  } = useVoiceClient(WS_URL)

  const isConnected = connection === 'connected'
  const isListening = agentState === 'listening'
  const isSpeaking = agentState === 'speaking'

  const handleMicDown = () => {
    if (isSpeaking) bargeIn()
    startRecording()
  }

  const handleMicUp = () => {
    stopRecording()
  }

  const dotColor = isConnected ? STATE_COLORS[agentState] || '#4ade80' : '#ef4444'
  const statusText = isConnected
    ? STATE_LABELS[agentState] || 'Ready'
    : connection === 'connecting'
      ? 'Connecting...'
      : 'Disconnected'

  return (
    <div style={{
      background: '#0a0a0f',
      color: '#e0e0e0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{ width: '100%', maxWidth: 600, padding: 20 }}>
        {/* Status */}
        <div style={{ textAlign: 'center', marginBottom: 30 }}>
          <span style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            borderRadius: '50%',
            marginRight: 8,
            verticalAlign: 'middle',
            background: dotColor,
            animation: agentState === 'thinking' ? 'pulse 1s infinite' : undefined,
          }} />
          <span style={{ fontSize: 14, color: '#888', verticalAlign: 'middle' }}>
            {statusText}
          </span>
        </div>

        {/* Waveform */}
        <div style={{
          width: '100%',
          height: 120,
          borderRadius: 12,
          background: '#111118',
          overflow: 'hidden',
          margin: '20px 0',
        }}>
          <WaveformVisualizer
            analyser={analyser}
            active={isListening}
            color={isSpeaking ? '#4ade80' : '#a78bfa'}
          />
        </div>

        {/* Mic button */}
        <div style={{ textAlign: 'center', margin: '20px 0' }}>
          <button
            onMouseDown={handleMicDown}
            onMouseUp={handleMicUp}
            onMouseLeave={handleMicUp}
            onTouchStart={(e) => { e.preventDefault(); handleMicDown() }}
            onTouchEnd={(e) => { e.preventDefault(); handleMicUp() }}
            disabled={!isConnected}
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              border: `3px solid ${isListening ? '#ef4444' : isSpeaking ? '#4ade80' : '#333'}`,
              background: isListening ? '#2a1015' : isSpeaking ? '#0a2a15' : '#1a1a24',
              color: '#e0e0e0',
              fontSize: 32,
              cursor: isConnected ? 'pointer' : 'not-allowed',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s',
              boxShadow: isListening
                ? '0 0 20px rgba(239,68,68,0.3)'
                : isSpeaking
                  ? '0 0 20px rgba(74,222,128,0.3)'
                  : 'none',
            }}
          >
            🎙
          </button>
        </div>

        {/* Chat */}
        <ChatLog chatLog={chatLog} onSend={sendText} />
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
