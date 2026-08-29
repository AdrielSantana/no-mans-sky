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

**Rochas voltaram** (`ROCKS_ENABLED` em `planet-props.ts`, ver §1.8). Os GLBs
entram por import dinâmico, então com a flag desligada eles saem do grafo de
módulos e nem são emitidos no build. O RNG de placement é semeado por tipo
(`${chunkKey}:${kind}`), então ligar ou desligar rocha **não move nenhuma
árvore**.

O alvo era 400–700 triângulos no tier 0 e 120–200 no tier 1; as quatro pedras
novas ficaram em 628–630 e 186–188.

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
  não tufo de folha larga. Na folhagem, o winter tree só se diferencia pela cor
  — o tronco e a raiz já são outra malha.
- **`alphaToCoverage` continua inerte** porque o renderer roda `antialias: false`.
  Com MSAA ligado, folhagem seria o primeiro lugar a se beneficiar.
- **Sem sombra de folha no chão.** As props recebem sombra do terreno e das
  nuvens, mas não projetam nada.
- **Sem fade por distância nos cards.** O LOD corta em degraus via draw range;
  um fade de tamanho no último tier tiraria o pop.

### 1.7 Raízes flutuando em encosta — FEITO

Árvore em terreno inclinado ficava com as raízes no ar do lado de baixo. Não era
uma coisa só, eram três, medidas em cima das malhas de verdade:

1. **A causa principal, geométrica.** A base do oak é um disco de raio **0,156
   da altura da própria árvore** — a saia de raízes é larga. A árvore fica quase
   na vertical na encosta de propósito (`lerp(radial, normal, 0.18)`: ela cresce
   pro céu, não perpendicular ao morro), então o eixo dela e o do chão discordam
   por um ângulo `a` e a borda de baixo do disco sobe `raio * sin(a)`. Oak de
   13 m numa encosta de 20°: **0,73 m de luz do dia embaixo da raiz.** O winter
   tree da época, um cilindro de base 0,037, mal aparecia — o problema era quase
   todo do oak. Foi essa assimetria que apontou pra saia de raiz como causa.
2. **O pivô estava na copa.** `normalize` centrava o modelo em x/z pelo
   *bounding box*, que segue a copa: no oak isso põe a origem a 0,05 da altura
   de distância do próprio tronco. O `spin` aleatório então jogava esse offset
   pra uma direção diferente em cada árvore — na encosta, umas ficavam 25 cm
   mais altas e outras enterravam o mesmo tanto. Daí a inconsistência entre
   vizinhas. Agora `measureBasePivot` centra pela base.
3. **`sampleSurface` amostrava a superfície errada.** A malha do chunk divide
   cada célula na diagonal i10–i01; interpolar os quatro cantos de uma vez
   amostra o *patch bilinear*, que descola dos triângulos por um quarto do twist
   da célula. Em chunk grosseiro (props existem até `maxLod - 4`, células ~16×
   maiores) isso sozinho já pendura a árvore acima do chão em que ela foi
   plantada. Agora é baricêntrico no triângulo certo.

O `+0.08` de *levantada* que existia antes só piorava os três.

**Afundar a árvore não era a resposta.** Foi a primeira tentativa: descer o prop
por `baseRadius * escala * sin(a)`. Fecha a folga, mas pra fechar 0,73 m enterra
1,03 m morro acima — mais do que a saia inteira do oak, que tem 0,78 m de
altura. Some justamente a raiz que se queria ver.

**A resposta é a mesma das folhas: contato com o chão é da engine.** O vertex
shader do tronco agora *deforma a base* em vez de descer a árvore. Em chão
plano um vértice fica exatamente `position.y * scaleY` acima da superfície; o
desvio disso é a luz do dia. O shader cancela o desvio no fundo da malha e
solta o cancelamento subindo o tronco (`PROP_SKIRT_BAND = 0.12`, folgado o
bastante pra passar da saia de 0,06 sem vincar). A saia de raiz acompanha a
inclinação; nada afunda.

Medido varrendo o `spin` em 24 ângulos sobre a saia inteira:

| modelo | encosta | folga antes | folga afundando | enterro afundando | folga skirt | enterro skirt |
|---|---|---|---|---|---|---|
| oak 13 m | 20° | 0,73 m | 0,12 m | 1,03 m | **0,00 m** | **0,21 m** |
| oak 13 m | 30° | 1,03 m | 0,24 m | 1,45 m | **0,00 m** | **0,29 m** |
| winter 22 m | 20° | 0,95 m | 0,08 m | 1,31 m | **0,00 m** | **0,30 m** |
| winter 22 m | 30° | 1,37 m | 0,22 m | 1,83 m | **0,00 m** | **0,39 m** |

Sanidade do harness: em 0° de encosta a folga "antes" dá exatamente 0,08 m — a
levantada antiga. O enterro que sobra no skirt é a saia morro acima passando
abaixo do plano, que é o certo: é a árvore abraçando a encosta.

Sobrou só `PROP_GROUND_BIAS` (0,006 da altura) pra base nunca ficar exatamente
coplanar com o terreno.

**O pine ganhou raiz depois disso, e nessa ordem.** O winter tree foi
regerado com saia (raio da base 0,037 → 0,102), o que sob o código antigo teria
sido *pior* que o oak: 0,95 m de folga a 20°, 1,37 m a 30°. É o skirt que torna
o modelo com raiz viável — sem ele, dar raiz a um conífero de 22 m só aumentaria
o buraco. A escada nova é 4202/1025/407/91 triângulos e o anel de contato
sobrevive à decimação (largura da base 0,203–0,212 nos quatro tiers), que era o
risco real: o skirt só ancora o que estiver no `y` mais baixo da malha.
Folhagem sem ajuste nenhum — `extractBranchAnchors` deu 321 anchors / 963 cards
contra 295 / 885 do modelo antigo.

Eu escrevi aqui que valeria pra rock "sem nada a mais". Estava errado — a
banda constante de 0,12 quebra em prop achatado. Ver §1.8.

**O que ficou de fora:** a normal não é recalculada depois da deformação, então
o sombreado da saia fica levemente errado na encosta — é a parte mais escondida
da malha e não apareceu em teste. E o plano tangente é uma aproximação de
primeira ordem: terreno muito rugoso dentro da pegada da árvore ainda deixa
resíduo.

### 1.8 Pedras de volta — FEITO

Quatro pedras novas, duas tiers cada. Três coisas mudaram junto, e nenhuma foi
escolha estética: as três caíram das medições.

**1. Os 8 arquivos não eram uma escada.** Eram 4 pedras × 2 tiers. Rodar o
`import-prop-lods.mjs` na pasta teria produzido `lod_0..lod_9` de uma pedra
fictícia. E os nomes não pareavam — `Meshy_AI__…025821` parece a `rock_1` e é a
`rock_3b`. Pareei por forma (proporção da caixa normalizada + altura do
centroide, ambas preservadas pela decimação): a distância do par certo ficou em
0,033–0,057 contra 0,346–0,877 do segundo colocado, 6–25× de separação.

**2. A banda do skirt não podia ser constante.** `PROP_SKIRT_BAND` era 0,12 da
altura, escolhido pra passar da saia de raiz do oak. Mas a correção que o shader
precisa aplicar escala com o quanto a base *avança de lado*, enquanto a banda
escalava com a *altura* — e a laje (`rock_4`) avança 2,9 da própria altura.
Espalhar 44% da espessura dela sobre um doze avos dela teria rasgado a malha.

Agora a banda vem do modelo: `max(baseRadius, PROP_SKIRT_MIN_BAND)`, uniform
por material, escrito uma vez na carga. Isso mantém o *ângulo* de cisalhamento
constante em vez da distância. Sem teto: passando da altura do modelo a
correção deixa de ser dobra e vira rotação da malha inteira sobre o plano do
chão — que é exatamente o que uma pedra chata quer, e só um prop mais largo na
base do que alto chega a pedir.

Árvore quase não sente (banda do oak 0,12 → 0,133, do pine continua no piso).
Pedra sente tudo:

| pedra | baseRadius | banda | contato a 45° antes | depois |
|---|---|---|---|---|
| rock_1 | 0,448 | 0,448 | 0,00 m | 0,00 m |
| rock_2 | 0,744 | 0,744 | 0,00 m | 0,00 m |
| rock_3 | 1,066 | 1,066 | 0,13 m | **0,00 m** |
| rock_4 | 2,924 | 2,924 | 0,33 m | **0,00 m** |

**3. A escala de pedra estava dimensionada pela altura.** Com `scale.y =
rockHeight * squash` e jitter horizontal até 2,6× em x e 2,2× em z, a laje 6,2:1
virava uma panqueca de **40 m**. Aquele jitter existia pra fingir variedade a
partir de duas malhas; quatro malhas cobrindo de 1,0 a 6,2 de proporção já
carregam isso. Agora a pedra é dimensionada pela **maior dimensão**
(`rockSize / max(model.width, 1)`), com só ±17% de estica pra quebrar
repetição. A `ROCK_HEIGHT_RANGE` virou `ROCK_SIZE_RANGE` e finalmente é lida de
`model.heightRange`, em vez de o intervalo estar duplicado hardcoded dentro de
`buildKindPlacements`.

Em `rockSize` 5,5 m as quatro dão 5,5 × 5,5 / 5,5 × 3,4 / 5,5 × 2,3 / 5,5 × 0,9
metros — bola, achatada, baixa e laje.

**Pedra também quer ficar encravada.** Um matacão apoiado exatamente no vértice
mais baixo lê como largado ali. `PROP_GROUND_BIAS` virou dois números: a árvore
segue com o fio de cabelo (0,006 da altura, porque enterrar tronco esconde a
raiz que faz ela parecer plantada) e a pedra afunda 0,06–0,20, sorteado por
instância pra um campo delas não parecer carimbado.

**Custo:** 1024² no tier 0 (paridade com as pedras antigas — §3 já registrava
que o jogador chega perto), 256² no tier 1, que só entra a partir de 227 m onde
uma pedra de 5 m tem ~23 px. 5,65 MB de VRAM por pedra, 22,6 MB nas quatro. Cair
pra 512²/256² levaria a 6,6 MB se pesar.

### 1.9 Dispersão cai 256× com a distância — NÃO FEITO

Densidades baixadas a pedido para `treeDensity 0.2` / `rockDensity 0.15`. Mas o
número de densidade **não é a alavanca** que parece ser, e vale registrar por quê
antes de alguém mexer nele de novo.

`buildKindPlacements` calcula quantos props colocar a partir da contagem de
*células da grade*, que é constante em 1024 (`(gridSize - 1)²`), e não da **área**
do chunk. Só que o chunk quadruplica de área a cada nível de LOD, e prop existe
de `maxLod` até `maxLod - 4`, com `propDistance` de 2200 m no editor. Resultado,
com R=50000 e as densidades novas:

| lod | chunk | faixa de câmera | área | árvores | árv/ha | espaçamento |
|---|---|---|---|---|---|---|
| 11 | 49 m | 50–125 m | 0,24 ha | 7 | 29,4 | 18 m |
| 10 | 98 m | 125–313 m | 0,95 ha | 7 | 7,3 | 37 m |
| 9 | 195 m | 313–781 m | 3,81 ha | 7 | 1,8 | 74 m |
| 8 | 391 m | 781–1953 m | 15,3 ha | 7 | 0,46 | 148 m |
| 7 | 781 m | 1953 m+ | 61 ha | 7 | 0,12 | 295 m |

**256× de queda dentro do alcance visível, em degraus de 4×.** Floresta fechada
no pé, árvores avulsas no meio, horizonte vazio. Baixar a densidade global
multiplica as cinco faixas igualmente — a razão entre elas não muda.

E tem um segundo problema no mesmo lugar: o RNG é semeado com
`nodeKey(face, lod, x, y)`, que **inclui o lod**. Chunk pai e filhos sorteiam
posições sem relação nenhuma, então dividir um chunk não refina a distribuição:
**reembaralha todas as árvores daquela região de uma vez**. O pop ao andar não é
só de quantidade, é de posição.

Caminhos, do mais barato ao mais certo:

1. **Escalar `targetCount` pela área do chunk.** Uma linha, mas esbarra em
   `MAX_TREE_INSTANCES_PER_CHUNK = 34`: manter 29 árv/ha num chunk de lod 9
   pediria 112 instâncias, e de lod 7, 1793. O teto existe pra limitar o
   raymarch de sombra (§1.2, ~3,4 ms por chunk) — escalar sem mexer nele só
   move o degrau de lugar.
2. **Encurtar `propDistance`** pra caber em menos faixas de LOD. Resolve por
   remoção, ao custo do alcance de vista.
3. **Tirar o placement do chunk de terreno.** Grade virtual de tamanho fixo
   (ex. 100 m) independente do LOD: densidade uniforme por construção e o
   reembaralhamento some, porque a célula não muda quando o terreno divide. É a
   resposta certa e a mais cara — hoje a camada de prop pertence ao chunk, é
   anexada em `chunk.mesh` e some junto com ele.

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

## 5. Antialiasing — FEITO (SMAA pós-tonemap)

`RenderPass` rasteriza em alvos com `samples = 0` (`engine.ts`), e antes deste
commit nada além do quad do `OutputPass` chegava ao framebuffer — ou seja, não
existia AA nenhum. `antialias: false` no renderer continua certo pelo mesmo
motivo de sempre: MSAA no backbuffer não teria aresta nenhuma pra resolver.

As duas rotas avaliadas eram MSAA no composer (`samples: 2`) e um pass
pós-tonemap. Ficou o segundo, como a análise original recomendava: MSAA
obrigaria **os dois** alvos a serem multisampled, porque a paridade de swap é
dinâmica (`needsSwap = hasClouds`, `UnderwaterPass.enabled`), o que sai em
RGBA16F multisampled em DPR 2 com até 4 resolves por frame.

`SMAAPass` entra **depois** do `OutputPass`, de propósito: SMAA detecta aresta
por luma e quer a imagem tonemapeada em LDR, não o alvo HalfFloat da cena. Os
alvos do composer seguem single-sampled e o depth read do cloud pass fica
intacto.

Dois detalhes que custaram leitura de fonte:

- **`setSize` manual na construção.** `EffectComposer.setSize` multiplica pelo
  pixel ratio e repassa pros passes, mas só roda sobre os passes que já existem.
  Pass adicionado depois nunca recebe um — e SMAA sem resolução de device
  caminha a busca de aresta na distância errada de texel. O `UnderwaterPass` já
  tinha a mesma linha pelo mesmo motivo.
- **Desligar não apaga a tela.** `EffectComposer.render` faz
  `pass.renderToScreen = (this.renderToScreen && this.isLastEnabledPass(i))`,
  então `smaaPass.enabled = false` devolve a tela pro `OutputPass` sem mais nada
  a mudar. Conferido no fonte do three 0.184, não assumido.

As duas texturas de lookup do SMAA são base64 inline, então nada é buscado da
rede — mas decodificam de forma assíncrona, então os primeiros frames passam
sem AA em vez de travar.

Exposto no editor como *Diagnostics → Antialias (SMAA)*, ligado por padrão, e
o HUD de diagnóstico mostra `aa=smaa|off`.

**Não medido:** o custo (a estimativa de 0,2–0,4 ms a 1080p é da análise
original, não medida aqui) e o resultado visual — o SwiftShader desta máquina
não completa um frame da cena.

`alphaToCoverage` continua ligado em grama e props e **continua inerte**: os
dois shaders escrevem alpha constante 1.0 e resolvem silhueta por `discard`
binário, e post-AA não muda isso — ele precisa de MSAA de verdade. Se um dia
existir, separar cobertura de silhueta do fade (dobrar o fade na cobertura vira
screen-door de 4 níveis).

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
