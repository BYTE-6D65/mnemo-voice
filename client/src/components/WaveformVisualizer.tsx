import { useRef, useEffect } from 'react'

interface Props {
  analyser: AnalyserNode | null
  active: boolean
  color: string
}

export default function WaveformVisualizer({ analyser, active, color }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number

    const draw = () => {
      animId = requestAnimationFrame(draw)
      const { width, height } = canvas

      ctx.fillStyle = '#111118'
      ctx.fillRect(0, 0, width, height)

      if (!analyser || !active) {
        ctx.strokeStyle = '#333'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, height / 2)
        ctx.lineTo(width, height / 2)
        ctx.stroke()
        return
      }

      const bufLen = analyser.frequencyBinCount
      const data = new Uint8Array(bufLen)
      analyser.getByteTimeDomainData(data)

      ctx.lineWidth = 2
      ctx.strokeStyle = color
      ctx.beginPath()

      const sliceWidth = width / bufLen
      let x = 0
      for (let i = 0; i < bufLen; i++) {
        const v = data[i] / 128.0
        const y = (v * height) / 2
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
        x += sliceWidth
      }
      ctx.lineTo(width, height / 2)
      ctx.stroke()
    }

    draw()
    return () => cancelAnimationFrame(animId)
  }, [analyser, active, color])

  // Resize canvas to container
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        canvas.width = entry.contentRect.width
        canvas.height = entry.contentRect.height
      }
    })
    observer.observe(canvas.parentElement!)
    return () => observer.disconnect()
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
