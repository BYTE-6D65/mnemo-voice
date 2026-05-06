/**
 * VRM hot-reload hook — watches a .vrm file for changes and forces a reload.
 *
 * Works by polling the file's Last-Modified header via HEAD request.
 * When a change is detected, the model URL gets a cache-busting query param
 * which causes VRMRenderer to unload the old model and load the new one.
 *
 * No gateway restart needed — just drop a new .vrm on disk.
 */

import { useState, useEffect, useRef } from 'react'

interface VrmHotReloadResult {
  /** URL with cache-busting param, or null if no model */
  modelUrl: string | null
  /** Force a reload right now */
  reload: () => void
  /** Last-known file mtime */
  lastModified: string | null
}

const POLL_INTERVAL = 2000 // ms

export function useVrmHotReload(baseUrl: string | null): VrmHotReloadResult {
  const [modelUrl, setModelUrl] = useState<string | null>(baseUrl)
  const [lastModified, setLastModified] = useState<string | null>(null)
  const bustRef = useRef(0)

  // Manual reload trigger
  const reload = () => {
    bustRef.current += 1
    if (baseUrl) {
      setModelUrl(`${baseUrl}?_=${bustRef.current}`)
    }
  }

  useEffect(() => {
    if (!baseUrl) return

    let timer: ReturnType<typeof setInterval>
    let stopped = false

    const check = async () => {
      try {
        const res = await fetch(baseUrl, { method: 'HEAD', cache: 'no-store' })
        const mtime = res.headers.get('Last-Modified')
        if (!mtime) return

        if (lastModified && mtime !== lastModified) {
          // File changed — bust the cache
          bustRef.current += 1
          if (!stopped) {
            setModelUrl(`${baseUrl}?_=${bustRef.current}`)
          }
        }
        if (!stopped) setLastModified(mtime)
      } catch {
        // File might not exist yet, ignore
      }
    }

    // Initial check
    check()

    // Poll for changes
    timer = setInterval(check, POLL_INTERVAL)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [baseUrl, lastModified])

  return { modelUrl, reload, lastModified }
}
