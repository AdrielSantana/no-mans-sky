export function probeTerrainShaders() {
  const p = window.__nmsEditorDebug.planet
  const OPS = ['texture2D', 'texture(', 'textureLod', 'pow(', 'normalize(', 'atan', 'asin(',
    'acos(', 'sqrt(', 'exp(', 'noise', 'fbm', 'snoise', 'hash', 'smoothstep(', 'mix(',
    'sin(', 'cos(', 'for (', 'dFdx', 'fwidth', '#include', 'clamp(', 'dot(', 'length(']
  const describe = (label, material) => {
    if (!material?.fragmentShader) return { label, missing: true }
    const frag = material.fragmentShader
    const ops = {}
    for (const op of OPS) {
      const n = frag.split(op).length - 1
      if (n > 0) ops[op] = n
    }
    return {
      label,
      fragLines: frag.split('\n').length,
      vertLines: material.vertexShader.split('\n').length,
      uniforms: Object.keys(material.uniforms ?? {}).length,
      textureUniforms: Object.values(material.uniforms ?? {}).filter(u => u.value?.isTexture).length,
      ops,
    }
  }
  return {
    farMaterialCount: p.farLodMaterials.length,
    materials: [
      describe('near', p.material),
      describe('far[0]', p.farLodMaterials[0]),
      describe('simple', p.simpleTerrainMaterial),
    ],
  }
}
