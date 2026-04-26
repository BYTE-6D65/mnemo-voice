/**
 * Avatar driver — connects the voice pipeline to an AvatarRenderer.
 *
 * Takes audio events from useVoiceClient and produces AvatarFrame objects
 * that any renderer can consume. Handles:
 *   - Viseme extraction from audio amplitude (simple, no phoneme analysis needed)
 *   - Expression state from agent events
 *   - Smooth transitions between states
 *   - Idle animation when not speaking
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { AvatarFrame, ExpressionName, VisemeName } from './types'

export type AgentState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

interface UseAvatarDriverOptions {
  /** How many audio samples to average for amplitude (smoothness) */
  amplitudeWindow?: number
  /** How fast visemes blend (0–1, lower = smoother) */
  blendSpeed?: number
}

const DEFAULT_OPTS: Required<UseAvatarDriverOptions> = {
  amplitudeWindow: 8,
  blendSpeed: 0.15,
}

export function useAvatarDriver(
  agentState: AgentState,
  analyser: AnalyserNode | null,
  opts?: UseAvatarDriverOptions,
) {
  const { amplitudeWindow, blendSpeed } = { ...DEFAULT_OPTS, ...opts }
  const frameRef = useRef<AvatarFrame>(emptyFrame())
  const amplitudeHistory = useRef<number[]>([])
  const rafRef = useRef<number>(0)
  const prevViseme = useRef<VisemeName>('neutral')
  const prevWeight = useRef(0)
  const [frame, setFrame] = useState<AvatarFrame>(emptyFrame())
  const timeRef = useRef(0)

  // Expression mapping from agent state
  const getExpression = useCallback((state: AgentState): Record<ExpressionName, number> => {
    const exprs: Record<ExpressionName, number> = {
      happy: 0, angry: 0, sad: 0, surprised: 0,
      neutral: 1, relaxed: 0, lookUp: 0, lookDown: 0,
    }

    switch (state) {
      case 'speaking':
        exprs.neutral = 0.6
        exprs.happy = 0.2
        break
      case 'thinking':
        exprs.neutral = 0.3
        exprs.lookUp = 0.4
        break
      case 'listening':
        exprs.neutral = 0.8
        exprs.surprised = 0.1
        break
    }
    return exprs
  }, [])

  // Amplitude-based viseme extraction from the analyser node
  const getAmplitude = useCallback((): number => {
    if (!analyser) return 0
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    return Math.sqrt(sum / data.length)
  }, [analyser])

  // Main animation loop
  useEffect(() => {
    const tick = () => {
      timeRef.current += 1 / 60
      const t = timeRef.current

      // Get smoothed amplitude
      const amp = getAmplitude()
      amplitudeHistory.current.push(amp)
      if (amplitudeHistory.current.length > amplitudeWindow) {
        amplitudeHistory.current.shift()
      }
      const avgAmp = amplitudeHistory.current.reduce((a, b) => a + b, 0) / amplitudeHistory.current.length

      // Map amplitude to viseme
      const isSpeaking = agentState === 'speaking' && avgAmp > 0.01
      let viseme: VisemeName = 'neutral'
      let weight = 0

      if (isSpeaking || agentState === 'speaking') {
        // Simple amplitude-to-mouth mapping
        // In a real implementation, you'd use the TTS timing data
        const threshold = 0.02
        if (avgAmp > threshold) {
          // Alternate between open mouth shapes based on amplitude
          if (avgAmp > 0.08) viseme = 'aa'
          else if (avgAmp > 0.05) viseme = 'oh'
          else if (avgAmp > 0.03) viseme = 'ee'
          else viseme = 'ih'
          weight = Math.min(avgAmp * 8, 1.0)
        }
      } else if (agentState === 'idle') {
        // Idle: subtle breathing / blink cycle
        const breathCycle = Math.sin(t * 0.5) * 0.02
        weight = Math.max(0, breathCycle)
        viseme = 'neutral'

        // Occasional blink
        const blinkPhase = t % 4 // every ~4 seconds
        if (blinkPhase > 3.8) viseme = 'blink'
      }

      // Smooth viseme transition
      const blendedWeight = prevWeight.current + (weight - prevWeight.current) * blendSpeed
      prevViseme.current = viseme
      prevWeight.current = blendedWeight

      // Build viseme map
      const visemeMap: Record<VisemeName, number> = {
        aa: 0, ih: 0, ou: 0, ee: 0, oh: 0,
        neutral: 1 - blendedWeight,
        blink: 0,
      }
      if (viseme !== 'neutral') {
        visemeMap[viseme] = blendedWeight
        visemeMap.neutral = 1 - blendedWeight
      }

      const newFrame: AvatarFrame = {
        viseme: visemeMap,
        expression: getExpression(agentState),
        lookAt: { x: 0, y: 0, z: -1 },
        isSpeaking,
      }

      frameRef.current = newFrame
      setFrame(newFrame)
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [agentState, analyser, amplitudeWindow, blendSpeed, getAmplitude, getExpression])

  return { frame }
}

function emptyFrame(): AvatarFrame {
  return {
    viseme: {
      aa: 0, ih: 0, ou: 0, ee: 0, oh: 0,
      neutral: 1, blink: 0,
    },
    expression: {
      happy: 0, angry: 0, sad: 0, surprised: 0,
      neutral: 1, relaxed: 0, lookUp: 0, lookDown: 0,
    },
    lookAt: { x: 0, y: 0, z: -1 },
    isSpeaking: false,
  }
}
