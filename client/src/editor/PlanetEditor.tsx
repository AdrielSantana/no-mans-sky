import { useCallback, useState } from 'react'
import { DEFAULT_PARAMS } from './editor-defaults'
import type { EditorParams } from './editor-defaults'
import { EditorCanvas } from './EditorCanvas'
import { EditorPanel } from './EditorPanel'

export function PlanetEditor() {
  const [params, setParams] = useState<EditorParams>({ ...DEFAULT_PARAMS })
  const [panelVisible, setPanelVisible] = useState(true)
  const togglePanel = useCallback(() => setPanelVisible(v => !v), [])

  return (
    <>
      <EditorCanvas params={params} panelVisible={panelVisible} onTogglePanel={togglePanel} />
      {panelVisible && <EditorPanel params={params} onChange={setParams} />}
    </>
  )
}
