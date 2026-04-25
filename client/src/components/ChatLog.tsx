import { useState, useRef } from 'react'

interface Props {
  chatLog: Array<{ role: string; text: string; ts: number }>
  onSend: (text: string) => void
}

export default function ChatLog({ chatLog, onSend }: Props) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div
        ref={scrollRef}
        style={{
          maxHeight: '300px',
          overflowY: 'auto',
          borderRadius: '12px',
          background: '#111118',
          padding: '15px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        {chatLog.map((entry, i) => (
          <div
            key={i}
            style={{
              fontSize: '14px',
              lineHeight: 1.5,
              color:
                entry.role === 'user'
                  ? '#93c5fd'
                  : entry.role === 'agent'
                    ? '#c4b5fd'
                    : '#666',
              fontStyle: entry.role === 'system' ? 'italic' : 'normal',
            }}
          >
            <span style={{ color: '#444', fontSize: '11px', marginRight: '8px' }}>
              {new Date(entry.ts).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {entry.text}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '10px' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          style={{
            flex: 1,
            padding: '10px 15px',
            borderRadius: '8px',
            border: '1px solid #333',
            background: '#1a1a24',
            color: '#e0e0e0',
            fontSize: '14px',
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          style={{
            padding: '10px 20px',
            borderRadius: '8px',
            border: '1px solid #333',
            background: '#1a1a24',
            color: '#e0e0e0',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
