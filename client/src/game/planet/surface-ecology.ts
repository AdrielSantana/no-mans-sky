// Continuous planet-space fields, shared by trees, rocks and grass.
// Unlike the old integer-cell prop mask these have no square patch edges.
import { valueNoise3 } from '../../../../server/spacetimedb/src/shared/terrain-noise'

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function sampleSurfaceEcology(p: { x: number; y: number; z: number }, seed: number, slopeDot: number) {
  const moisture = valueNoise3(p.x / 640, p.y / 640, p.z / 640, seed + 3001)
  const stand = valueNoise3(p.x / 150, p.y / 150, p.z / 150, seed + 4703)
  const stone = valueNoise3(p.x / 85, p.y / 85, p.z / 85, seed + 7001)
  const exposure = smoothstep(0.025, 0.25, 1 - slopeDot)
  const woodland = smoothstep(0.35, 0.64, stand) * smoothstep(0.27, 0.64, moisture) * (1 - exposure)
  const outcrop = smoothstep(0.45, 0.72, stone) * (0.22 + exposure * 0.78)
  const meadow = (0.4 + moisture * 0.6) * (1 - woodland * 0.65) * (1 - outcrop * 0.85) * (1 - exposure)
  return { moisture, woodland, outcrop, meadow, exposure }
}
