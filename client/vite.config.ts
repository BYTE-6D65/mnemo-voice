import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite doesn't know the MIME type for .vrm files (they're glTF binary / .glb).
 * Without the correct Content-Type, HTTPS browsers (Tailscale) will reject the fetch.
 * This plugin intercepts responses to .vrm files and sets the proper MIME type.
 */
function vrmMimeType(): Plugin {
  return {
    name: 'vrm-mime-type',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const originalEnd = res.end.bind(res)
        const originalWriteHead = res.writeHead.bind(res)

        if (req.url && /\.vrm(\?|$)/.test(req.url)) {
          const origSetHeader = res.setHeader.bind(res)
          res.setHeader = (name: string, value: any) => {
            if (name.toLowerCase() === 'content-type') {
              return origSetHeader(name, 'model/gltf-binary')
            }
            return origSetHeader(name, value)
          }
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), vrmMimeType()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: ['zectal.tail871f65.ts.net'],
    proxy: {
      '/ws': {
        target: 'http://localhost:8765',
        ws: true,
      },
    },
  },
})
