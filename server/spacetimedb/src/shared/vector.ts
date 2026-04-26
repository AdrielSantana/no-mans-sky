export interface Vec3Like {
  x: number
  y: number
  z: number
}

export function vec3(x = 0, y = 0, z = 0): Vec3Like {
  return { x, y, z }
}

export function add(a: Vec3Like, b: Vec3Like): Vec3Like {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z)
}

export function sub(a: Vec3Like, b: Vec3Like): Vec3Like {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function scale(v: Vec3Like, s: number): Vec3Like {
  return vec3(v.x * s, v.y * s, v.z * s)
}

export function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross(a: Vec3Like, b: Vec3Like): Vec3Like {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  )
}

export function lengthSq(v: Vec3Like): number {
  return dot(v, v)
}

export function length(v: Vec3Like): number {
  return Math.sqrt(lengthSq(v))
}

export function normalize(v: Vec3Like): Vec3Like {
  const len = length(v)
  if (len <= 1e-8) return vec3(0, 1, 0)
  return scale(v, 1 / len)
}

export function projectOnPlane(v: Vec3Like, normal: Vec3Like): Vec3Like {
  return sub(v, scale(normal, dot(v, normal)))
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
