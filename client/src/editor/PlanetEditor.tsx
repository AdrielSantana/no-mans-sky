import { useState } from 'react'
import { DEFAULT_PARAMS } from './editor-defaults'
import type { EditorParams } from './editor-defaults'
import { EditorCanvas } from './EditorCanvas'
import { EditorPanel } from './EditorPanel'

export function PlanetEditor() {
  const [params, setParams] = useState<EditorParams>({ ...DEFAULT_PARAMS })

  return (
    <>
      <EditorCanvas params={params} />
      <EditorPanel params={params} onChange={setParams} />
    </>
  )
}
