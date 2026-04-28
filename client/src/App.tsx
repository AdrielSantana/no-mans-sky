import Scene from './Scene'
import { PlanetEditor } from './editor/PlanetEditor'

const isEditor = new URLSearchParams(window.location.search).has('editor')

function App() {
  return isEditor ? <PlanetEditor /> : <Scene />
}

export default App
