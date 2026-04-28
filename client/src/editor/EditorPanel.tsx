import type { EditorParams } from './editor-defaults'
import { DEFAULT_PARAMS, RANGES } from './editor-defaults'
import './EditorPanel.css'

interface Props {
  params: EditorParams
  onChange: (params: EditorParams) => void
}

export function EditorPanel({ params, onChange }: Props) {
  const set = <K extends keyof EditorParams>(key: K, value: EditorParams[K]) => {
    onChange({ ...params, [key]: value })
  }

  return (
    <div className="editor-panel">
      <div className="editor-title">Planet Editor</div>

      <div className="editor-section">
        <div className="editor-section-title">Planet Type</div>
        <div className="editor-row">
          <span className="editor-label">Type</span>
          <select
            className="editor-select"
            value={params.planetType}
            onChange={e => set('planetType', e.target.value)}
          >
            <option value="rocky">Rocky</option>
            <option value="gas">Gas Giant</option>
            <option value="ice">Ice</option>
          </select>
        </div>
        <div className="editor-row">
          <span className="editor-label">Seed</span>
          <input
            className="editor-number"
            type="number"
            value={params.seed}
            onChange={e => set('seed', Number(e.target.value))}
          />
        </div>
        <div className="editor-btn-row">
          <button className="editor-btn" onClick={() => set('seed', Math.floor(Math.random() * 99999))}>
            Randomize
          </button>
          <button className="editor-btn" onClick={() => onChange({ ...DEFAULT_PARAMS })}>
            Reset
          </button>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Geometry</div>
        <div className="editor-row">
          <span className="editor-label">Radius</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.planetRadius.min}
            max={RANGES.planetRadius.max}
            step={RANGES.planetRadius.step}
            value={params.planetRadius}
            onChange={e => set('planetRadius', Number(e.target.value))}
          />
          <span className="editor-value">{params.planetRadius}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Terrain Scale</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.terrainScale.min}
            max={RANGES.terrainScale.max}
            step={RANGES.terrainScale.step}
            value={params.terrainScale}
            onChange={e => set('terrainScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.terrainScale.toFixed(2)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Surface</div>
        <div className="editor-row">
          <span className="editor-label">Water Level</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.waterLevel.min}
            max={RANGES.waterLevel.max}
            step={RANGES.waterLevel.step}
            value={params.waterLevel}
            onChange={e => set('waterLevel', Number(e.target.value))}
          />
          <span className="editor-value">{params.waterLevel.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Color A</span>
          <input
            className="editor-color"
            type="color"
            value={params.colorA}
            onChange={e => set('colorA', e.target.value)}
          />
          <span className="editor-value">{params.colorA}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Color B</span>
          <input
            className="editor-color"
            type="color"
            value={params.colorB}
            onChange={e => set('colorB', e.target.value)}
          />
          <span className="editor-value">{params.colorB}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Atmosphere</div>
        <div className="editor-row">
          <span className="editor-label">Color</span>
          <input
            className="editor-color"
            type="color"
            value={params.atmosphereColor}
            onChange={e => set('atmosphereColor', e.target.value)}
          />
          <span className="editor-value">{params.atmosphereColor}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Density</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.atmosphereDensity.min}
            max={RANGES.atmosphereDensity.max}
            step={RANGES.atmosphereDensity.step}
            value={params.atmosphereDensity}
            onChange={e => set('atmosphereDensity', Number(e.target.value))}
          />
          <span className="editor-value">{params.atmosphereDensity.toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}
