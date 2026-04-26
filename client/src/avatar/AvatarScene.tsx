/**
 * Avatar scene — the R3F canvas that hosts the VRM model.
 *
 * Wraps @react-three/fiber Canvas with proper lighting and camera,
 * then renders the VRM model driven by the avatar driver.
 */

import { Suspense, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { VRMRenderer, AvatarPlaceholder } from './VRMRenderer'
import type { AvatarFrame } from './types'

interface AvatarSceneProps {
  /** URL to .vrm model file */
  modelUrl: string | null
  /** Current avatar frame from useAvatarDriver */
  frame: AvatarFrame
  /** CSS class or inline style for the container */
  className?: string
  style?: React.CSSProperties
}

export function AvatarScene({ modelUrl, frame, className, style }: AvatarSceneProps) {
  const [loadError, setLoadError] = useState<string | null>(null)

  return (
    <div className={className} style={{ width: '100%', height: '100%', ...style }}>
      <Canvas
        camera={{ position: [0, 1.3, 2.5], fov: 35 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
      >
        {/* Lighting */}
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 5, 5]} intensity={0.8} />
        <directionalLight position={[-3, 3, -3]} intensity={0.3} color="#818cf8" />

        {/* Camera controls — orbit around the model */}
        <OrbitControls
          target={[0, 1, 0]}
          enablePan={false}
          minDistance={1}
          maxDistance={5}
          minPolarAngle={Math.PI / 4}
          maxPolarAngle={Math.PI / 1.5}
        />

        <Suspense fallback={<AvatarPlaceholder />}>
          {modelUrl && (
            <VRMRenderer
              modelUrl={modelUrl}
              frame={frame}
              onLoaded={() => {
                setLoadError(null)
              }}
              onError={(err) => {
                setLoadError(err.message)
              }}
            />
          )}
          {!modelUrl && <AvatarPlaceholder />}
        </Suspense>

        {/* Optional: subtle grid floor */}
        <gridHelper args={[4, 8, '#333', '#222']} position={[0, 0, 0]} />
      </Canvas>

      {loadError && (
        <div style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '4px 12px',
          borderRadius: 6,
          background: 'rgba(239,68,68,0.2)',
          color: '#f87171',
          fontSize: 12,
        }}>
          Model load failed: {loadError}
        </div>
      )}
    </div>
  )
}
