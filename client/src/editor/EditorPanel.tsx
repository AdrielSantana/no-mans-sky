import type { EditorParams } from './editor-defaults'
import { DEFAULT_PARAMS, RANGES, TYPE_PRESETS } from './editor-defaults'
import './EditorPanel.css'

interface Props {
  params: EditorParams
  onChange: (params: EditorParams) => void
}

export function EditorPanel({ params, onChange }: Props) {
  const set = <K extends keyof EditorParams>(key: K, value: EditorParams[K]) => {
    onChange({ ...params, [key]: value })
  }

  const setPlanetType = (planetType: string) => {
    const preset = TYPE_PRESETS[planetType]
    onChange({ ...params, planetType, ...preset })
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
            onChange={e => setPlanetType(e.target.value)}
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
        <div className="editor-section-title">World Gen</div>
        <div className="editor-row">
          <span className="editor-label">Octaves</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.octaves.min}
            max={RANGES.octaves.max}
            step={RANGES.octaves.step}
            value={params.octaves}
            onChange={e => set('octaves', Number(e.target.value))}
          />
          <span className="editor-value">{params.octaves}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Lacunarity</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.lacunarity.min}
            max={RANGES.lacunarity.max}
            step={RANGES.lacunarity.step}
            value={params.lacunarity}
            onChange={e => set('lacunarity', Number(e.target.value))}
          />
          <span className="editor-value">{params.lacunarity.toFixed(1)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Gain</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.gain.min}
            max={RANGES.gain.max}
            step={RANGES.gain.step}
            value={params.gain}
            onChange={e => set('gain', Number(e.target.value))}
          />
          <span className="editor-value">{params.gain.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Frequency</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.frequency.min}
            max={RANGES.frequency.max}
            step={RANGES.frequency.step}
            value={params.frequency}
            onChange={e => set('frequency', Number(e.target.value))}
          />
          <span className="editor-value">{params.frequency.toFixed(1)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Warp</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.warpStrength.min}
            max={RANGES.warpStrength.max}
            step={RANGES.warpStrength.step}
            value={params.warpStrength}
            onChange={e => set('warpStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.warpStrength.toFixed(2)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Terrain Layers</div>
        <div className="editor-row">
          <span className="editor-label">Continents</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.continentalScale.min}
            max={RANGES.continentalScale.max}
            step={RANGES.continentalScale.step}
            value={params.continentalScale}
            onChange={e => set('continentalScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.continentalScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Mountains</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.mountainScale.min}
            max={RANGES.mountainScale.max}
            step={RANGES.mountainScale.step}
            value={params.mountainScale}
            onChange={e => set('mountainScale', Number(e.target.value))}
          />
          <span className="editor-value">{params.mountainScale.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Hydraulic</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.erosionStrength.min}
            max={RANGES.erosionStrength.max}
            step={RANGES.erosionStrength.step}
            value={params.erosionStrength}
            onChange={e => set('erosionStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.erosionStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Thermal</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.thermalStrength.min}
            max={RANGES.thermalStrength.max}
            step={RANGES.thermalStrength.step}
            value={params.thermalStrength}
            onChange={e => set('thermalStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.thermalStrength.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Fine Detail</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.detailStrength.min}
            max={RANGES.detailStrength.max}
            step={RANGES.detailStrength.step}
            value={params.detailStrength}
            onChange={e => set('detailStrength', Number(e.target.value))}
          />
          <span className="editor-value">{params.detailStrength.toFixed(2)}</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">LOD ({params.lodMultipliers.length} levels)</div>
        <div className="editor-row">
          <span className="editor-label">Grid Size</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.gridSize.min}
            max={RANGES.gridSize.max}
            step={RANGES.gridSize.step}
            value={params.gridSize}
            onChange={e => set('gridSize', Number(e.target.value))}
          />
          <span className="editor-value">{params.gridSize}</span>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.skirts}
              onChange={e => set('skirts', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Skirts</span>
          </label>
        </div>
        <div className="editor-row">
          <span className="editor-label">Horizon</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.horizonMargin.min}
            max={RANGES.horizonMargin.max}
            step={RANGES.horizonMargin.step}
            value={params.horizonMargin}
            onChange={e => set('horizonMargin', Number(e.target.value))}
          />
          <span className="editor-value">{params.horizonMargin.toFixed(2)}</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Workers</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.terrainWorkers.min}
            max={RANGES.terrainWorkers.max}
            step={RANGES.terrainWorkers.step}
            value={params.terrainWorkers}
            onChange={e => set('terrainWorkers', Number(e.target.value))}
          />
          <span className="editor-value">{params.terrainWorkers === 0 ? 'Auto' : params.terrainWorkers}</span>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.autoLod}
              onChange={e => set('autoLod', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Auto LOD</span>
          </label>
        </div>
        {params.lodMultipliers.map((val, i) => (
          <div className="editor-row" key={i}>
            <span className="editor-label">LOD {i + 1}</span>
            <input
              className="editor-slider"
              type="range"
              min={RANGES.lodMultiplier.min}
              max={RANGES.lodMultiplier.max}
              step={RANGES.lodMultiplier.step}
              value={val}
              disabled={params.autoLod}
              onChange={e => {
                const next = [...params.lodMultipliers]
                next[i] = Number(e.target.value)
                set('lodMultipliers', next)
              }}
            />
            <span className="editor-value">{val.toFixed(2)}</span>
          </div>
        ))}
        {!params.autoLod && (
          <div className="editor-btn-row">
            <button
              className="editor-btn"
              disabled={params.lodMultipliers.length <= 1}
              onClick={() => set('lodMultipliers', params.lodMultipliers.slice(0, -1))}
            >
              Remove Last
            </button>
            <button
              className="editor-btn"
              disabled={params.lodMultipliers.length >= 15}
              onClick={() => {
                const last = params.lodMultipliers[params.lodMultipliers.length - 1] ?? 1
                set('lodMultipliers', [...params.lodMultipliers, Math.max(0.01, last * 0.45)])
              }}
            >
              Add Level
            </button>
          </div>
        )}
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

      <div className="editor-section">
        <div className="editor-section-title">Lighting</div>
        <div className="editor-row">
          <span className="editor-label">Sun Azimuth</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.sunAzimuth.min}
            max={RANGES.sunAzimuth.max}
            step={RANGES.sunAzimuth.step}
            value={params.sunAzimuth}
            onChange={e => set('sunAzimuth', Number(e.target.value))}
          />
          <span className="editor-value">{params.sunAzimuth.toFixed(0)}°</span>
        </div>
        <div className="editor-row">
          <span className="editor-label">Sun Elevation</span>
          <input
            className="editor-slider"
            type="range"
            min={RANGES.sunElevation.min}
            max={RANGES.sunElevation.max}
            step={RANGES.sunElevation.step}
            value={params.sunElevation}
            onChange={e => set('sunElevation', Number(e.target.value))}
          />
          <span className="editor-value">{params.sunElevation.toFixed(0)}°</span>
        </div>
      </div>

      <div className="editor-section">
        <div className="editor-section-title">Diagnostics</div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugBloom}
              onChange={e => set('debugBloom', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Bloom</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugOcean}
              onChange={e => set('debugOcean', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Ocean</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugAtmosphere}
              onChange={e => set('debugAtmosphere', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Atmosphere</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugSimpleTerrain}
              onChange={e => set('debugSimpleTerrain', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Simple Terrain</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugNearTerrainShader}
              onChange={e => set('debugNearTerrainShader', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Near Terrain Shader</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugFarTerrainShader}
              onChange={e => set('debugFarTerrainShader', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Far Terrain Shader</span>
          </label>
        </div>
        <div className="editor-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={params.debugFallbackTerrainShader}
              onChange={e => set('debugFallbackTerrainShader', e.target.checked)}
              style={{ accentColor: '#2dd4a7' }}
            />
            <span className="editor-label" style={{ width: 'auto' }}>Fallback Terrain Shader</span>
          </label>
        </div>
      </div>
    </div>
  )
}
