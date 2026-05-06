import { useState, useRef, useEffect } from 'react'

interface Props {
  chatLog: Array<{ role: string; text: string; ts: number }>
  onSend: (text: string) => void
  isConnected: boolean
}

export default function ChatLog({ chatLog, onSend, isConnected }: Props) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chatLog.length])

  const handleSend = () => {
    if (!input.trim()) return
    onSend(input.trim())
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      flex: 1,
      minHeight: 0,
    }}>
      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          borderRadius: 14,
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.05)',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        {chatLog.length === 0 && (
          <div style={{
            textAlign: 'center',
            color: '#52525b',
            fontSize: 13,
            padding: '40px 20px',
            fontStyle: 'italic',
          }}>
            Tap the mic and start talking, or type below =^･ω･^=
          </div>
        )}
        {chatLog.map((entry, i) => (
          <MessageBubble key={i} entry={entry} />
        ))}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? 'Type a message...' : 'Connecting...'}
          disabled={!isConnected}
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.04)',
            color: '#e4e4e7',
            fontSize: 14,
            outline: 'none',
            fontFamily: 'inherit',
            transition: 'border-color 0.2s, background 0.2s',
          }}
        />
        <button
          onClick={handleSend}
          disabled={!isConnected || !input.trim()}
          style={{
            padding: '10px 18px',
            borderRadius: 12,
            border: 'none',
            background: input.trim() && isConnected
              ? 'linear-gradient(135deg, #7c3aed, #6366f1)'
              : 'rgba(255,255,255,0.05)',
            color: input.trim() && isConnected ? '#fff' : '#52525b',
            cursor: input.trim() && isConnected ? 'pointer' : 'default',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            transition: 'all 0.2s',
            letterSpacing: '0.01em',
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}

function MessageBubble({ entry }: { entry: { role: string; text: string; ts: number } }) {
  const isUser = entry.role === 'user'
  const isAgent = entry.role === 'agent'
  const isSystem = entry.role === 'system'

  if (isSystem) {
    return (
      <div style={{
        textAlign: 'center',
        fontSize: 11,
        color: '#52525b',
        padding: '4px 0',
        fontStyle: 'italic',
      }}>
        {entry.text}
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        maxWidth: '85%',
        padding: '8px 14px',
        borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
        background: isUser
          ? 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(124,58,237,0.15))'
          : 'rgba(255,255,255,0.05)',
        border: `1px solid ${isUser ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)'}`,
        fontSize: 14,
        lineHeight: 1.55,
        color: isUser ? '#c7d2fe' : '#d4d4d8',
        wordBreak: 'break-word',
      }}>
        {isAgent && (
          <div style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#a78bfa',
            marginBottom: 3,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            Mnemo
          </div>
        )}
        {entry.text}
      </div>
    </div>
  )
}
