# Backlog de performance

Estado depois da auditoria de 2026-08-28 e da primeira rodada de correções.
Tudo abaixo foi lido no código; os números são medidos, não estimados.

**Antes de atacar qualquer coisa daqui: meça de novo.** A lista original foi
construída sobre um profile que já não existe — a amostragem de terreno ficou
22,5% mais rápida, o build de chunk 21%, e três blocos grandes de main thread e
GPU sumiram. O HUD (`?perf`) agora reporta `draw`/`tri` de verdade.

---

## 1. Props — o subsistema mais pesado que sobrou

Todos os quatro problemas identificados foram corrigidos: backface culling e
alpha-test (1.1), LOD tiers (1.1b), raymarch de sombra fora da main thread
(1.2) e texturas (1.3). O que resta são refinamentos, não gargalos.

### 1.1 Backface culling e alpha-test — FEITO
As árvores são **tronco e galhos, sem folhas** (escolha deliberada do autor).
Isso invalidou a análise original, que assumia cards de folhagem alpha-cut.

Verificado nos assets:
- `alphaMode: OPAQUE` nos dois GLB de árvore
- baseColor é **JPEG**, formato sem canal alpha — `texel.a` é sempre 1.0
- soldando os vértices por posição: `rock_1` fechada (0 arestas de borda),
  `oak_tree` 3 e `winter_tree` 20 em ~26k, **zero arestas não-manifold** nas
  três. Sólidos fechados com o fundo do tronco aberto, não superfícies de
  cards — cada card contribuiria com 4 arestas de borda.

Consequências, ambas corrigidas:
- `sourceMaterialAlphaTest` forçava `alphaTest >= 0.08` em qualquer árvore com
  mapa. Como o alpha é sempre 1.0, o `discard` nunca disparava — custo zero
  visual, mas a presença do `discard` no fragment shader **desativa early-Z**.
  Agora o discard sai do shader por `#define PROP_ALPHA_TEST` quando não há
  alpha test. Zerar o uniform não bastaria.
- `side` era `DoubleSide` hardcoded para árvores (e vinha `DoubleSide` do GLB
  para rochas), rasterizando ~17,5k triângulos por árvore **duas vezes** em
  backfaces nunca visíveis. Agora `FrontSide` nos dois.

**Se algum dia forem adicionados cards de folhagem a esses modelos, isto tem
de voltar a ser uma decisão por submesh.**

### 1.1b LOD tiers — FEITO
Tiers gerados offline com `gltf-transform weld` + `simplify --ratio 0.30
--error 0.02`, determinístico e sem custo de runtime:

Escadas autoradas, quatro tiers cada, 7,07 MB de VRAM por árvore:

| modelo | tier 0 | tier 1 | tier 2 | tier 3 |
|---|---|---|---|---|
| `oak_tree` | 3.970 | 1.032 | 275 | 90 |
| `winter_tree` | 3.774 | 1.024 | 302 | 88 |

Texturas por tier: 1024² / 512² / 256² / 128².

**Rochas estão desativadas** enquanto as árvores são retrabalhadas
(`ROCKS_ENABLED` em `planet-props.ts`). Os GLBs entram por import dinâmico, então
com a flag desligada eles saem do grafo de módulos e nem são emitidos no build.
Religar é trocar o booleano — o RNG de placement é semeado por tipo
(`${chunkKey}:${kind}`), então ligar ou desligar rocha **não move nenhuma
árvore**.

Quando voltarem, os alvos são 400–700 triângulos no tier 0 e 120–200 no tier 1.

Detalhes que importam se mexer nisso:
- **Os LOD herdam a matriz `normalize` do modelo base.** `loadPropModel` deriva
  essa matriz da bounding box; se o LOD derivasse a dele, a árvore daria um
  pulo na troca de tier, porque o simplificador move a caixa em ~0,02%.
- A troca é `mesh.geometry = <tier>`, reaproveitando os mesmos
  `InstancedBufferAttribute`. Placements, matrizes e valores de sombra
  sobrevivem — **trocar de tier nunca re-roda o raymarch de horizonte**.
- Geometrias por tier são construídas sob demanda e mantidas em cache: a
  maioria dos chunks só precisa de uma.
- As texturas embutidas nos GLB de LOD foram reduzidas a 8×8 porque só a
  geometria é lida — o material vem sempre do modelo base.
- Limiar em `PROP_LOD1_DISTANCE_FRACTION` (0,35 da distância de exibição, ~227m
  no game) com 12% de histerese. O histograma de tiers está exposto em
  `visibleLayersByLod` nos stats de debug, para calibrar contra o que está
  realmente na tela.

### 1.1c Convenção de assets de prop
Modelos com múltiplos tiers vivem num diretório por modelo, com os arquivos
nomeados `lod_0.glb` … `lod_N.glb` — **numerados pela contagem de triângulos**,
não pelo nome que o gerador deu. Exportadores costumam mentir: os quatro tiers
do carvalho chegaram como `lod_100`, `lod_100`, `lod_300` e `lod_0`, sendo os
valores reais 91, 1.044, 309 e 3.990.

**A pegadinha que importa:** tiers exportados independentemente por um gerador
(Meshy e afins) re-assam o próprio atlas — os UVs deles **não** batem com o do
modelo base. Emparelhar a textura do tier 0 com a geometria do tier 2 nesse caso
dá lixo. Já tiers produzidos decimando um mesh (`gltf-transform simplify`)
preservam os UVs e devem reusar o material base.

Não dá pra detectar isso do arquivo com confiança, então é declarado por asset
em `PropLodSpec.ownMaterial`. As duas árvores usam `true` em todos os tiers; um
tier decimado do mesh base usaria `false`.

**Importação:** use `node scripts/import-prop-lods.mjs <diretório>`. Ele ordena
por contagem de triângulo (não pelo nome), remove os mapas que o shader não lê,
poda, redimensiona por tier e **só apaga os originais depois que as quatro
saídas validam**.

Consequência: `updatePlanetPropMaterials` tem de percorrer **todos** os tiers,
senão props distantes ficam sem posição do sol, sombra de nuvem e tinta de
atmosfera.

Higiene de textura no import:
- Só a base color é lida pelo shader. `normalTexture`, `metallicRoughnessTexture`
  e afins devem ser removidos do material e podados — o carvalho chegou com
  10,4 MB de normal map e 1,4 MB de metallic-roughness que o `GLTFLoader`
  decodifica e o shader nunca amostra.
- Uma resolução por tier, acompanhando a faixa de distância:
  1024² / 512² / 256² / 128². A escada inteira do carvalho fica em **7,07 MB de
  VRAM** e 1,1 MB em disco, contra ~102 MB dos exports crus.

**Oportunidade registrada:** os modelos vêm *com* normal map. O shader de props
não usa nenhum e a iluminação é por vértice (`vLight`, `planet-props.ts:333`).
Adicionar normal mapping seria um upgrade visual maior do que qualquer
geometria extra — e permitiria alvos de triângulo mais baixos ainda.

### 1.2 Raymarch de sombra — FEITO
`computeHorizonSunLight` rodava 10 amostras de `samplePlanetHeightDetailed` por
instância, no main thread, durante a integração do chunk. Medido no worker
depois da mudança: **6,8 a 66,6 ms por camada de 33 instâncias** — bem acima dos
~4,4 ms/chunk que a auditoria estimou.

A computação é pura (lê só os arrays de placement, a direção do sol e os params
de terreno), então foi extraída inteira para `prop-sun-light.ts`, compartilhada
verbatim com o worker.

- **Um job por camada**, não por placement: camada é a unidade que nasce, morre
  e é invalidada, então rastrear staleness por camada mantém o bookkeeping
  honesto.
- **Um worker dedicado**, não um pool. Resultados que chegam tarde são
  descartados e re-pedidos; oversubscrever mataria o streaming de terreno
  (ver secção 2).
- No `attachPropLayer` a camada é iluminada com o **termo de normal apenas**
  (`skipHorizon`), que é praticamente grátis. Ela continua se reportando como
  stale, então o job real refina logo em seguida — árvores nunca aparecem
  pretas, e nada disso entra no orçamento de 2,5 ms de integração de chunk.
- Fallback preservado: sem `Worker`, com o worker em erro, ou com a fila cheia
  (`MAX_PROP_SUN_IN_FLIGHT`), cai no caminho main-thread orçado em 2 ms/frame.

Verificado bit-idêntico ao HEAD em 10.800 instâncias (3 presets × 4 direções de
sol, incluindo sol rasante onde o raymarch domina).

**Ainda não feito:** o early-out analítico. `blocker` só pode ficar não-zero se
algum `obstacleSlope` exceder `stylizedSunSlope - 0.015`; um limite por planeta
de slope alcançável colapsaria o caso diurno comum num compare. Agora que o
custo está fora da main thread isso virou otimização de latência, não de frame
time.

### 1.3 Texturas — FEITO
85,1 → 21,3 MB de VRAM. Ver secção 3.

---

### 1.4 Folhagem procedural — FEITO

As árvores são tronco e galhos de propósito: as folhas são geradas na engine
para que quantidade, tamanho, cor, balanço e translucidez sejam parâmetros vivos.

Como funciona (`tree-foliage.ts`):

1. **Âncoras** vêm só do `lod_0`. Para cada vértice soldado por posição, o raio
   local do galho é estimado por PCA numa vizinhança (`estimateLocalRadii`) —
   nos assets reais isso separa p05 de p95 por 6.6x, que é o sinal usado.
   Rejeição de Poisson espalha as âncoras pelos galhos.
   **Não dá para fazer isso nos tiers baixos**: oak `lod_2` tem 153 posições
   distintas e o estimador devolve zero na maior parte da malha.
2. **Cards** são quads gerados por âncora, embaralhados deterministicamente para
   que *qualquer prefixo* da lista seja uma amostra espacialmente uniforme.
3. **LOD é `setDrawRange`**, não troca de geometria. Por isso o embaralhamento
   importa: truncar em ordem de score depenaria um lado da árvore.
4. **Atlas de folha** é desenhado num canvas no load. Textura em vez de silhueta
   analítica porque só textura tem mipmap, e sem mipmap folha alpha-testada
   pequena serrilha muito.

Medido: oak 523 âncoras → 1569 cards, winter 295 → 885. 34 árvores num chunk
saem em **4 draw calls** (2 troncos + 2 folhagens).

Armadilhas que custaram tempo:

- **`MAX_VERTEX_ATTRIBS` é 16.** A primeira versão usava atributos separados
  para `uv`, `leafAxisY`, `leafCorner` e `leafHash` e batia em exatamente 16 com
  `instanceMatrix` (4) mais os 6 por instância — o programa não linkava, com
  "Too many attributes". Hoje corner, célula do atlas e hash dividem um `vec4`,
  o segundo eixo do card sai de `cross(leafAxisX, normal)` e a uv é calculada no
  shader. Ficou em 14. **Sobram 2 slots**: qualquer atributo novo em prop
  precisa caber nisso.
- **Um shader que não compila ainda conta triângulos** em `renderer.info`. Custou
  duas rodadas até eu capturar o console do headless.
- **O vento tem que ser a mesma função nos dois materiais.** Tronco e folha
  chamam `propWindSway` com os mesmos argumentos no mesmo ponto; qualquer
  divergência faz as folhas escorregarem do galho durante a rajada. Por isso
  `PROP_WIND_STIFFNESS` vive em `prop-shading.ts` e não em nenhum dos dois.
- **Cor é por espécie, não global** (`FoliagePalette` ao lado de `heightRange`).

### 1.5 Geometria compartilhada entre chunks — FEITO (achado no caminho)

`buildTierGeometry` fazia `geometry.clone()` por chunk, e
`BufferAttribute.clone()` copia o array: **cada chunk carregava e subia sua
própria cópia da malha da árvore** — 121 KB por oak por chunk, por tier já
visitado. Com folhagem por cima ia multiplicar.

Agora `buildInstancedGeometry` referencia os atributos da fonte e só acrescenta
os atributos instanciados. O contrapeso é `disposeInstancedGeometry`: os
atributos compartilhados são **desanexados antes** de `dispose()`, senão o
primeiro chunk a sair de cena apagaria os buffers que o resto do planeta ainda
está desenhando — e eles voltariam a subir no frame seguinte, para sempre,
conforme os chunks entram e saem.

Isso é seguro só porque os nomes não colidem: fonte usa `position`/`normal`/
`uv`/`leafAxisX`/`leafData`, instanciados usam o prefixo `instance`.

### 1.6 Folhagem — o que ficou de fora

- **O atlas é o mesmo para as duas espécies.** Um conífero quer ramo de agulha,
  não tufo de folha larga. Hoje o winter tree só se diferencia pela cor.
- **`alphaToCoverage` continua inerte** porque o renderer roda `antialias: false`.
  Com MSAA ligado, folhagem seria o primeiro lugar a se beneficiar.
- **Sem sombra de folha no chão.** As props recebem sombra do terreno e das
  nuvens, mas não projetam nada.
- **Sem fade por distância nos cards.** O LOD corta em degraus via draw range;
  um fade de tamanho no último tier tiraria o pop.

## 2. Pool global de workers — agora com evidência

`initTerrainWorkers` (`planet-renderer.ts`) cria até `min(8, threads-1)` workers
**por PlanetRenderer**, e `celestial-system.ts` cria um renderer por planeta.

Isto deixou de ser teórico. Ao paralelizar o job do oceano medi:

| fatias | wall | maior fatia | trabalho real por fatia |
|---|---|---|---|
| 6 | 1748 ms | 1338 ms | ~380 ms |
| 3 | 1875 ms | 1479 ms | ~760 ms |

Numa máquina de 10 núcleos, 8 workers de chunk + N de oceano saturam tudo: o
número de fatias deixa de importar porque o gargalo é disponibilidade de CPU.
Por isso `resolveOceanSliceCount` é deliberadamente conservador (`threads / 3`,
máx. 3) — oversubscrever deixa o streaming de terreno mais lento, e isso o
jogador vê.

**O conserto é um pool global compartilhado com prioridade por distância**, em
vez de um pool por planeta. Destrava a paralelização do oceano e acelera o
streaming ao mesmo tempo.

---

## 3. Assets — FEITO (parcialmente)

Redimensionados com `gltf-transform resize --filter lanczos3` para 1024², e a
textura do astronauta reconvertida para JPEG q92.

| asset | antes | depois | |
|---|---|---|---|
| `rock_1.glb` | 4,03 MB | 0,32 MB | 12,7× |
| `rock_2.glb` | 4,36 MB | 0,35 MB | 12,4× |
| `winter_tree.glb` | 5,03 MB | 1,02 MB | 5,0× |
| `oak_tree.glb` | 5,31 MB | 0,95 MB | 5,6× |
| `astronaut` (PNG→JPEG) | 6,72 MB | 1,26 MB | 5,3× |

- **VRAM de props: 85,1 → 21,3 MB.** `dist` inteiro: 32 MB → 11 MB.
- Geometria preservada exatamente — contagens de vértice e triângulo conferidas
  contra os valores originais nos quatro GLB.
- 1024², não 512², mesmo nas rochas: o jogador pode chegar perto delas.
  Combinado com anisotropia 16 (aplicada em `sourceMaterialMap`), 1024²
  resolve **mais** detalhe do que os 2048² originais resolviam a 1×.
- `astronaut.jpg` mantém 2048², então a VRAM dele não mudou — o ganho é de
  download. O PNG era colorType 2 (RGB, sem alpha) e o shader lê só `.rgb`,
  então não havia canal empacotado a perder.
- Anisotropia do avatar subida de 4 para 16, alinhando com terreno e props.

### Ainda pendente

**`astronaut.fbx` carrega 2,7 MB de mídia embutida.** Um `Video/Content` que o
`FBXLoader` transforma em blob URL e decodifica — e `prepareModel` substitui
todos os materiais três linhas depois, descartando o resultado. É a mesma
textura já servida separadamente. Reexportar sem mídia embutida levaria
3,4 MB → ~645 KB.

**Não** tente resolver em código com `URL.revokeObjectURL(map.image.src)`:
`map.image` ainda é null nesse ponto, o `TypeError` é engolido pelo catch, e o
astronauta nunca aparece. É edição de asset, não de código.

**KTX2** continua na mesa se quiser mais: cortaria a VRAM outros 4-8×. Use
**UASTC + Zstd** — ETC1S é visivelmente blocado em albedo ruidoso de rocha.

**Peso de repositório:** os arquivos do `pathfinder_spaceship` (20,2 MB) não são
importados por nenhum módulo. Como o Vite só empacota o que é importado, isso
nunca esteve no bundle — mas está no clone.

## 4. macroAO — 46% do build de chunk

Só o hoisting de alocação foi feito. A subamostragem continua na mesa, mas com
uma ressalva que a auditoria original não capturou:

`sampleDirectionalAo` recebe `center = macroHeight`, que é a altura do **próprio
vértice**, em frequência cheia. O AO não é uma função suave na escala do `step`,
então subamostrar e bilerpar ingenuamente borra variação de alta frequência.

**Abordagem correta:** interpolar apenas as *estatísticas de vizinhança* — os
seis pontos médios `(a+b)/2` e o min/max dos 12 vizinhos — e recombinar com o
`center` exato por vértice. Isso preserva a dependência do vértice e só
interpola o que de facto varia na escala do `step`.

Cuidados:
- Endpoints inclusive em `[u0,u1]×[v0,v1]` para vizinhos de mesmo LOD
  compartilharem amostras de borda (sem costura).
- **Não** hardcode `lod >= 6` com 9×9: a frequência segura depende de
  `terrain.frequency`, que varia 2,0-4,0 entre presets.
- **Não** estenda ao `microAo` — os taps dele são métricos (0,45-3,7 m),
  comparáveis ao espaçamento de vértice em lod 7.
- Valide com `max |Δ| ≤ 0.02` (≈0,5% de luminância em `amount 0.28`).

**Ressalva de valor:** o build roda em worker pool, então isto não move o p95
numa máquina com 8+ núcleos. O que compra é latência de pop-in de LOD.

---

## 5. Antialiasing — não existe nenhum hoje

`RenderPass` rasteriza em alvos com `samples = 0` (`engine.ts:29-37`), e nada
além do quad do `OutputPass` chega ao framebuffer. `antialias: false` já foi
aplicado (era custo puro sem benefício), mas AA de verdade continua ausente.

Duas rotas:
- **MSAA no composer** (`samples: 2`): funciona, mas **ambos** os alvos ficam
  multisampled obrigatoriamente — a paridade de swap é dinâmica
  (`needsSwap = hasClouds`, `UnderwaterPass.enabled`). Custo: RGBA16F
  multisampled em DPR 2, até 4 resolves por frame.
- **Pass pós-tonemap** (SMAA/FXAA): um pass fullscreen, ~0,2-0,4 ms a 1080p,
  deixa os alvos HalfFloat e o depth read do cloud pass intactos.

**Recomendado:** post-AA, salvo se a medição de MSAA 2× surpreender.

`alphaToCoverage` está ligado em grama e props e é **inerte** — os dois shaders
escrevem alpha constante 1.0 e resolvem silhueta por `discard` binário. Só vale
mexer depois de existir MSAA, e então separando cobertura de silhueta do fade
(dobrar o fade na cobertura vira screen-door de 4 níveis).

---

## 6. Itens menores verificados

- **`collectRenderKeys` sem teste de facing** (`planet-renderer.ts`). O
  hemisfério de trás inteiro é submetido todo frame. O vertex shader far roda um
  `terrainFbm` de 3 oitavas por vértice, que backface culling não elimina.
  Alternativa de baixo risco ao conserto de winding (que é de três arquivos:
  `terrain-geometry`, as saias, e `buildIndexForStitching`, que descarta os
  triângulos de saia quando há stitching ativo — sob `FrontSide` isso vira
  buraco para o espaço).
  *Meça o `draw` no HUD antes de decidir.*
- **Espectro iFFT base sem gate de distância** (`planet-renderer.ts`): 20 passes
  fullscreen 512² incondicionais, enquanto o de detalhe já tem cadência.
  **Pré-requisito:** o decaimento de espuma em `ocean-gpu-ifft.ts:542` decai por
  *update*, não por segundo — sem corrigir isso você troca GPU por pop de espuma.
- **Alvos ping-pong do iFFT são RGBA16F carregando 2 canais**
  (`ocean-gpu-ifft.ts`). `RGFormat` no spectrum/ping/pong, mantendo os outputs em
  RGBA. **Não** mexa no `DataTexture` de h0: o buffer é alocado com stride 4 e
  trocar só o format corrompe o espectro inicial.
- **`oceanMesh.frustumCulled = false`** (`planet-renderer.ts`). Conserte com
  `boundingSphere` explícito em vez de desligar culling.
- **`CLOUD_OCCLUDER_RENDER_LAYER` nunca é renderizado.** É habilitado em toda
  mesh de chunk, no oceano e na fallbackSphere, mas `engine.ts` só importa
  `CLOUD_RENDER_LAYER`. Custo de `layers.enable` a zero de benefício.
- **`CloudCompositePass` traversa o grafo 3× por frame** (`engine.ts`). Cada
  `renderer.render()` chama `scene.updateMatrixWorld()`, e `projectObject`
  recursa nos filhos fora do teste de visibilidade — o teste de layer não poda a
  árvore. `matrixAutoUpdate = false` não aparece em lugar nenhum do projeto.
- **`client/src/game/planet/noise.ts` é código morto** — zero importadores.
- **`grassHeight` podia ser uniform** (`fluffy-grass.ts`): só alimenta a escala
  da instância. Como uniform, o slider deixa de precisar de rebuild.

---

## 7. Deliberadamente NÃO feito

**Passo métrico fixo na normal do terreno** (`terrain-geometry.ts`).
`normalSampleStep` é proporcional ao tamanho da célula, logo ao LOD: o mesmo
ponto do mundo recebe normal diferente em LOD 5 e 6, e o sombreamento "pula"
quando um chunk divide.

Um passo fixo em metros elimina o pop — mas em chunks grosseiros passa a
amostrar bem abaixo do espaçamento de vértice, trocando pop de LOD por aliasing
de normal. Além disso este item veio do agente crítico e **não passou pela
verificação adversarial**, ao contrário do resto da auditoria.

Precisa de uma decisão de arte, não de uma otimização.

---

## Como validar mudanças aqui

O harness de teste diferencial usado na primeira rodada compara a implementação
nova contra `git HEAD` sobre entradas aleatórias. Vale reconstruí-lo para
qualquer mudança em terreno, AO ou geometria:

- Amostragem de terreno: 400k direções × 5 presets, comparando as 5 funções
  exportadas de `planet-terrain.ts` com `Object.is`.
- Geometria de chunk: 144 builds (4 presets × 6 nós × 3 gridSizes × skirts),
  comparando os 8 buffers.
- Índice de stitching: 72 configurações, comparando o índice efetivamente
  desenhado (respeitando `drawRange`).

**`planet-terrain.ts` é compartilhado com o servidor SpacetimeDB.** Qualquer
mudança ali tem de ser bit-idêntica, ou cliente e servidor discordam sobre a
altura do terreno e o jogador afunda no chão. A ordem de multiplicação em
`grad4dot` é deliberada por esse motivo — a variante "otimizada" que fatora
`norm` no final diverge em 59,5% das amostras.
