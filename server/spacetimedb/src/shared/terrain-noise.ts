// Deterministic C2-continuous value noise in world coordinates.
function hashGrid(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ seed
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function noiseFade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = noiseFade(x - ix)
  const fy = noiseFade(y - iy)
  const fz = noiseFade(z - iz)

  const x00 = lerp(hashGrid(ix, iy, iz, seed), hashGrid(ix + 1, iy, iz, seed), fx)
  const x10 = lerp(hashGrid(ix, iy + 1, iz, seed), hashGrid(ix + 1, iy + 1, iz, seed), fx)
  const x01 = lerp(hashGrid(ix, iy, iz + 1, seed), hashGrid(ix + 1, iy, iz + 1, seed), fx)
  const x11 = lerp(hashGrid(ix, iy + 1, iz + 1, seed), hashGrid(ix + 1, iy + 1, iz + 1, seed), fx)
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz)
}
