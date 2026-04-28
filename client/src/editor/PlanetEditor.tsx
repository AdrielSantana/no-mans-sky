import { useCallback, useState } from 'react'
import { DEFAULT_PARAMS, computeAutoLod } from './editor-defaults'
import type { EditorParams } from './editor-defaults'
import { EditorCanvas } from './EditorCanvas'
import { EditorPanel } from './EditorPanel'

export function PlanetEditor() {
  const [params, setParams] = useState<EditorParams>(() => ({
    ...DEFAULT_PARAMS,
    lodMultipliers: computeAutoLod(DEFAULT_PARAMS.planetRadius, DEFAULT_PARAMS.gridSize),
  }))

  const handleChange = useCallback((next: EditorParams) => {
    if (next.autoLod) {
      next = { ...next, lodMultipliers: computeAutoLod(next.planetRadius, next.gridSize) }
    }
    setParams(next)
  }, [])

  return (
    <>
      <EditorCanvas params={params} />
      <EditorPanel params={params} onChange={handleChange} />
    </>
  )
}
