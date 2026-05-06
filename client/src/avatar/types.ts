/**
 * Avatar system types — renderer-agnostic interfaces.
 *
 * The voice pipeline produces these. Any renderer (VRM, Live2D, debug)
 * consumes them. Neither side knows about the other.
 */

/** VRM-standard viseme blend shape names */
export type VisemeName =
  | 'aa' | 'ih' | 'ou' | 'ee' | 'oh'
  | 'neutral' | 'blink'

/** Expression blend shapes — maps to VRM expression presets */
export type ExpressionName =
  | 'happy' | 'angry' | 'sad' | 'surprised'
  | 'neutral' | 'relaxed' | 'lookUp' | 'lookDown'

/** Expression/look override parsed from agent text tags */
export interface AvatarOverride {
  expression?: Partial<Record<ExpressionName, number>>
  lookAt?: { x: number; y: number; z: number }
  /** Head roll in radians (positive = tilt right, negative = tilt left) */
  headTilt?: number
}

/** A single frame of avatar state, produced every render tick */
export interface AvatarFrame {
  /** Current viseme weight (0–1). Only one should be dominant. */
  viseme: Record<VisemeName, number>
  /** Expression override from agent sentiment, 0–1 each */
  expression: Record<ExpressionName, number>
  /** Head look direction (normalized, agent "looks" at things) */
  lookAt?: { x: number; y: number; z: number }
  /** Is the avatar currently speaking? */
  isSpeaking: boolean
}

/** The renderer interface — anything that visualizes an AvatarFrame */
export interface AvatarRenderer {
  /** Called once to load model assets */
  init(): Promise<void>
  /** Called every frame with the current avatar state */
  update(frame: AvatarFrame): void
  /** Clean up GPU resources */
  dispose(): void
}

/**
 * Viseme extraction result — timing + weights.
 * Produced by the TTS viseme extractor, consumed by the avatar driver.
 */
export interface VisemeTrack {
  /** Viseme events sorted by time */
  events: Array<{
    time: number      // seconds from audio start
    viseme: VisemeName
    weight: number    // 0–1
    duration: number  // how long this viseme holds (seconds)
  }>
  /** Total audio duration in seconds */
  duration: number
}
