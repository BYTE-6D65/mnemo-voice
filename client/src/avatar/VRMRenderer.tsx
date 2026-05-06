/**
 * VRM Avatar Renderer — loads and renders a VRM model using three-vrm.
 *
 * Consumes AvatarFrame from useAvatarDriver and applies it to a VRM model:
 *   - Viseme weights → VRM blend shape proxy
 *   - Expression weights → VRM expression presets
 *   - Spring bones handle hair/clothing physics automatically
 *
 * Drop any VRM file (from VRChat avatar → Unity VRM export) and it just works.
 */

import { useRef, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRM, VRMUtils } from '@pixiv/three-vrm'
import type { AvatarFrame, AvatarOverride, VisemeName, ExpressionName } from './types'

interface VRMRendererProps {
  /** URL or path to .vrm file */
  modelUrl: string
  /** Current avatar frame from useAvatarDriver */
  frame: AvatarFrame
  /** Override from parsed avatar tags (head tilt, etc.) */
  override?: AvatarOverride
  /** Called when model finishes loading */
  onLoaded?: (vrm: VRM) => void
  /** Called on load error */
  onError?: (error: Error) => void
}

/** Maps our viseme names to VRM blend shape names */
const VISEME_MAP: Record<VisemeName, string> = {
  aa: 'A',
  ih: 'I',
  ou: 'O',
  ee: 'E',
  oh: 'O',
  neutral: 'neutral',
  blink: 'blink',
}

/** Maps our expression names to VRM expression preset names */
const EXPRESSION_MAP: Record<ExpressionName, string> = {
  happy: 'happy',
  angry: 'angry',
  sad: 'sad',
  surprised: 'surprised',
  neutral: 'neutral',
  relaxed: 'relaxed',
  lookUp: 'lookUp',
  lookDown: 'lookDown',
}

// Temporary vector for look-at target — avoids GC per frame
const _lookAtTarget = new THREE.Object3D()

export function VRMRenderer({ modelUrl, frame, override, onLoaded, onError }: VRMRendererProps) {
  const vrmRef = useRef<VRM | null>(null)
  const { scene } = useThree()

  // Load the VRM model
  useEffect(() => {
    let cancelled = false
    const loader = new GLTFLoader()

    loader.register((parser: any) => new VRMLoaderPlugin(parser))

    loader.load(
      modelUrl,
      (gltf: any) => {
        if (cancelled) return
        const vrm = gltf.userData.vrm as VRM | undefined
        if (!vrm) {
          onError?.(new Error('No VRM data found in glTF'))
          return
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.removeUnnecessaryJoints(gltf.scene)

        // Rotate to face camera (VRM uses +Z forward, Three.js uses -Z)
        vrm.scene.rotation.y = Math.PI

        console.log('[VRM] Loaded:', {
          meshes: gltf.scene.children.length,
          vrmHumanoid: !!vrm.humanoid,
          vrmExpressions: !!vrm.expressionManager,
        })

        // Debug bounding box
        const box = new THREE.Box3().setFromObject(vrm.scene)
        const size = new THREE.Vector3()
        const center = new THREE.Vector3()
        box.getSize(size)
        box.getCenter(center)
        console.log('[VRM] Bounding box:', { min: box.min.toArray(), max: box.max.toArray(), size: size.toArray(), center: center.toArray() })

        scene.add(vrm.scene)
        vrmRef.current = vrm
        onLoaded?.(vrm)
      },
      undefined,
      (error: unknown) => {
        if (!cancelled) onError?.(error instanceof Error ? error : new Error(String(error)))
      },
    )

    return () => {
      cancelled = true
      if (vrmRef.current) {
        scene.remove(vrmRef.current.scene)
        VRMUtils.deepDispose(vrmRef.current.scene)
        vrmRef.current = null
      }
    }
  }, [modelUrl, scene, onLoaded, onError])

  // Apply frame every render tick
  useFrame((_, delta) => {
    const vrm = vrmRef.current
    if (!vrm) return

    // Update spring bones + expression handler
    vrm.update(delta)

    // Apply visemes and expressions
    const expressions = vrm.expressionManager
    if (expressions) {
      for (const viseme of Object.keys(VISEME_MAP) as VisemeName[]) {
        const vrmName = VISEME_MAP[viseme]
        try {
          expressions.setValue(vrmName, frame.viseme[viseme] ?? 0)
        } catch {
          // Blend shape might not exist in this model — skip
        }
      }

      for (const expr of Object.keys(EXPRESSION_MAP) as ExpressionName[]) {
        const vrmName = EXPRESSION_MAP[expr]
        try {
          expressions.setValue(vrmName, frame.expression[expr] ?? 0)
        } catch {
          // skip missing expressions
        }
      }
    }

    // Apply look-at
    if (frame.lookAt && vrm.lookAt) {
      _lookAtTarget.position.set(
        frame.lookAt.x * 2,
        frame.lookAt.y * 2 + 1.5,
        frame.lookAt.z * 2,
      )
      vrm.lookAt.target = _lookAtTarget
    }

    // Apply head tilt via head bone roll (after vrm.update so spring bones don't overwrite)
    if (vrm.humanoid) {
      const headBone = vrm.humanoid.getNormalizedBoneNode('head')
      if (headBone) {
        const tilt = override?.headTilt ?? 0
        headBone.node.rotation.z = tilt
        headBone.node.updateMatrix()
        headBone.node.updateMatrixWorld(true)
      }
    }
  })

  return null // renders into the Three.js scene, no DOM output
}

/** Placeholder cube when no VRM model is loaded */
export function AvatarPlaceholder() {
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.3
    }
  })

  return (
    <mesh ref={meshRef} position={[0, 1, 0]}>
      <boxGeometry args={[0.5, 0.5, 0.5]} />
      <meshStandardMaterial color="#7c3aed" wireframe />
    </mesh>
  )
}
