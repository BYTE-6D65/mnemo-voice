import useVoiceClient from './hooks/useVoiceClient'
import WaveformVisualizer from './components/WaveformVisualizer'
import ChatLog from './components/ChatLog'
import { AvatarScene, useAvatarDriver } from './avatar'
import { useState, useEffect } from 'react'

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

// TODO: make this configurable — for now, null = placeholder cube
const VRM_MODEL_URL: string | null = null
// const VRM_MODEL_URL = '/models/avatar.vrm'

const STATE_CONFIG: Record<string, { label: string; color: string; glow: string; bg: string }> = {
  idle:        { label: 'Ready',            color: '#a78bfa', glow: 'rgba(167,139,250,0.2)',  bg: 'rgba(167,139,250,0.05)' },
  listening:   { label: 'Hearing you...',   color: '#fbbf24', glow: 'rgba(251,191,36,0.3)',   bg: 'rgba(251,191,36,0.08)' },
  transcribing:{ label: 'Transcribing...',  color: '#fbbf24', glow: 'rgba(251,191,36,0.3)',   bg: 'rgba(251,191,36,0.08)' },
  thinking:    { label: 'Thinking...',      color: '#818cf8', glow: 'rgba(129,140,248,0.35)', bg: 'rgba(129,140,248,0.08)' },
  speaking:    { label: 'Speaking...',      color: '#34d399', glow: 'rgba(52,211,153,0.3)',   bg: 'rgba(52,211,153,0.08)' },
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" fill={active ? 'currentColor' : 'none'} />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
      {active && <circle cx="12" cy="12" r="10" strokeDasharray="4 4" opacity="0.3" />}
    </svg>
  )
}

export default function App() {
  const {
    connection,
    agentState,
    agentStatus,
    isRecording,
    chatLog,
    analyser,
    startRecording,
    stopRecording,
    bargeIn,
    sendText,
  } = useVoiceClient(WS_URL)

  // Drive the avatar from the voice pipeline
  const { frame } = useAvatarDriver(agentState, analyser)

  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const isConnected = connection === 'connected'
  const isSpeaking = agentState === 'speaking'
  const config = STATE_CONFIG[agentState] || STATE_CONFIG.idle

  const handleMicToggle = () => {
    if (isRecording) {
      stopRecording()
      return
    }
    if (isSpeaking) bargeIn()
    void startRecording()
  }

  const statusText = !isConnected
    ? connection === 'connecting' ? 'Connecting...' : 'Disconnected'
    : agentState === 'idle' && isRecording
      ? 'Mic on — listening'
      : config.label

  const statusColor = !isConnected ? '#ef4444' : config.color

  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(ellipse at 20% 50%, rgba(88,28,135,0.15) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(30,58,138,0.12) 0%, transparent 50%), radial-gradient(ellipse at 50% 100%, rgba(52,211,153,0.05) 0%, transparent 40%), #09090b',
      color: '#e4e4e7',
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: mounted ? 1 : 0,
      transition: 'opacity 0.6s ease',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 560,
        padding: '24px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        height: '100vh',
        maxHeight: '100vh',
        boxSizing: 'border-box',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg, #7c3aed 0%, #6366f1 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, boxShadow: '0 2px 8px rgba(124,58,237,0.3)',
            }}>
              =^
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Mnemo</div>
              <div style={{ fontSize: 11, color: '#71717a', marginTop: 1 }}>Voice Interface</div>
            </div>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
            borderRadius: 20,
            background: isConnected ? 'rgba(52,211,153,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${isConnected ? 'rgba(52,211,153,0.2)' : 'rgba(239,68,68,0.2)'}`,
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isConnected ? '#34d399' : '#ef4444',
              boxShadow: isConnected ? '0 0 6px rgba(52,211,153,0.5)' : '0 0 6px rgba(239,68,68,0.5)',
            }} />
            <span style={{ fontSize: 11, color: isConnected ? '#34d399' : '#ef4444', fontWeight: 500 }}>
              {isConnected ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
          </div>
        </div>

        {/* 3D Avatar — takes up ~40% of the viewport */}
        <div style={{
          flex: '0 0 40vh',
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.06)',
          position: 'relative',
        }}>
          <AvatarScene modelUrl={VRM_MODEL_URL} frame={frame} />
          {/* State indicator overlay */}
          <div style={{
            position: 'absolute', bottom: 8, right: 12,
            fontSize: 11, color: statusColor, opacity: 0.7,
            fontWeight: 500, letterSpacing: '0.02em',
          }}>
            {statusText}
          </div>
        </div>

        {/* Waveform */}
        <div style={{
          borderRadius: 16, overflow: 'hidden', position: 'relative',
          background: config.bg,
          border: `1px solid ${config.color}22`,
          boxShadow: `0 0 40px ${config.glow}, inset 0 1px 0 rgba(255,255,255,0.05)`,
          height: 60, transition: 'all 0.5s ease',
        }}>
          <WaveformVisualizer analyser={analyser} active={isRecording} color={config.color} />
        </div>

        {/* Agent status */}
        {agentStatus && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '2px 0', opacity: 0.85 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#818cf8', animation: 'pulse 1.5s ease-in-out infinite' }} />
            <span style={{ fontSize: 12, color: '#a1a1aa', fontWeight: 500 }}>{agentStatus}</span>
          </div>
        )}

        {/* Mic button */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={handleMicToggle}
            disabled={!isConnected}
            aria-pressed={isRecording}
            aria-label={isRecording ? 'Turn microphone off' : 'Turn microphone on'}
            style={{
              width: 64, height: 64, borderRadius: '50%', border: 'none',
              background: isRecording ? 'linear-gradient(135deg, #7c3aed, #6366f1)' : 'rgba(255,255,255,0.06)',
              color: isRecording ? '#fff' : '#a1a1aa',
              cursor: isConnected ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: isRecording
                ? '0 4px 24px rgba(124,58,237,0.4), 0 0 0 4px rgba(124,58,237,0.1)'
                : 'inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 3px rgba(0,0,0,0.3)',
              transform: isRecording ? 'scale(1.05)' : 'scale(1)',
              outline: 'none', position: 'relative',
            }}
          >
            <MicIcon active={isRecording} />
            {isRecording && (
              <div style={{
                position: 'absolute', inset: -4, borderRadius: '50%',
                border: '2px solid rgba(124,58,237,0.3)',
                animation: 'pulse-ring 1.5s ease-out infinite',
              }} />
            )}
          </button>
        </div>

        {/* Chat log */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ChatLog chatLog={chatLog} onSend={sendText} isConnected={isConnected} />
        </div>
      </div>

      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1.35); opacity: 0; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
        button:focus-visible { outline: 2px solid #7c3aed; outline-offset: 2px; }
        input:focus-visible { outline: none; border-color: #7c3aed !important; box-shadow: 0 0 0 2px rgba(124,58,237,0.2); }
      `}</style>
    </div>
  )
}
