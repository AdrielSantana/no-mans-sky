# Props estáveis entre LODs

A quadtree continua adequada para o terreno, e a troca de geometria dos modelos continua reduzindo o custo à distância. O problema anterior era sortear outra população para cada chunk e usar sua malha temporária para definir a posição e a inclinação dos objetos.

## Correção

- A população começa nas faces do planeta. Cada filho herda as props do pai que pertencem à sua área, antes de acrescentar detalhes. O início dessa hierarquia independe dos níveis visíveis configurados no renderer.
- A propriedade espacial usa coordenadas UV de precisão dupla e intervalos sem sobreposição. Modelo, matriz e coordenadas herdadas são preservados exatamente.
- Novas props consultam a altura detalhada compartilhada e uma normal com escala fixa, em vez da triangulação do LOD visível. Alterar a resolução da malha não muda seus pontos de ancoragem.
- O cache contém apenas dados de posicionamento, com até 1024 entradas por planeta. Evicção e reconstrução produzem o mesmo resultado. Os buffers de iluminação e recursos de GPU pertencem às camadas renderizadas.
- A preparação é incremental, com orçamento de 1,5 ms por atualização. Cada candidato cede a execução. A finalização de uma camada é indivisível e pode ultrapassar ligeiramente esse orçamento.
- O pai permanece visível e retido até os filhos terem geometria e props prontas. A redução de detalhe também espera o pai. O carregamento inicial, sem representação anterior, continua mostrando o terreno disponível.
- Áreas sem props também são registradas como prontas, evitando repetir sua geração em todos os frames. Trabalhos pendentes são descartados quando chunks, configurações ou o renderer são descartados.

Mantidos os limites de 34 árvores e 48 rochas por chunk e os LODs de troncos, pedras e folhagem. Props extras podem aparecer ao aproximar; as já existentes conservam sua identidade. Essa revisão não altera o sistema de distribuição de grama.

A oclusão por horizonte e a iluminação direta continuam sendo calculadas. A ancoragem nova não herda os atributos de AO da malha temporária; esses fatores locais começam neutros. Uma futura aproximação de AO para props deve usar amostras estáveis também.

## Verificação

```sh
pnpm --dir client build
pnpm --dir client exec eslint src/game/planet/planet-props.ts src/game/planet/planet-renderer.ts src/game/planet/terrain-geometry.ts
```

No console de `/?editor&perf`:

```js
await (await import('/scripts/prop-lod-checks.js')).runPropLodChecks()
await (await import('/scripts/landscape-checks.js')).runLandscapeChecks()
await (await import('/scripts/visual-checks.js')).runVisualChecks()
```

O teste de LOD verifica duas subdivisões, a volta ao pai, reconstrução sem cache, independência da resolução da malha, limites de instâncias, propriedade exclusiva e transições atômicas. Na área de teste, as 65 props do pai foram herdadas exatamente uma vez; os filhos adicionaram outras 172.

Com o jogador no solo, o teste integrado faz uma excursão de câmera e retorna ao modo de caminhada:

```js
await (await import('/scripts/prop-lod-checks.js')).runLivePropLodCheck()
```

A câmera sobe até 750 m, limitada a 40% da distância de exibição das props para mantê-las no teste, aguarda a preparação, volta e compara as matrizes das props que mudaram de chunk. Também verifica que alternar o LOD dos modelos não altera as matrizes das instâncias.

## Limites

A primeira geração desta revisão redistribui as props, pois a regra de sorteio mudou. A estabilidade vale para a nova regra com os mesmos parâmetros de geração e densidade.

O terreno ainda muda de triangulação; em malhas distantes pode haver uma pequena diferença entre a superfície aproximada desenhada e a altura detalhada fixa da prop. Esta correção não implementa morphing do terreno ou fade de densidade. A exclusão de proximidade entre props novas de chunks vizinhos também continua sendo um trabalho separado.

No teste completo no editor, a preparação consumiu até 1,5 ms em 95% dos frames medidos e atingiu um máximo de 1,8 ms. Ao estabilizar, havia 417 chunks visíveis, 352 props, nenhuma preparação pendente e 598 entradas no cache. Essas medições são desta etapa de CPU durante uma simulação controlada; não são uma medida de FPS do jogo.

O teste integrado concluído fez 614 comparações de matrizes e registrou 60 transferências entre chunks, com **zero transformações alteradas**. A população visível passou de 352 para 262 props ao afastar e voltou às mesmas 352 no retorno, sem filas pendentes ou erros de shader. O resultado completo está em [excursion-result.json](excursion-result.json).

A retenção do pai durante uma redução de detalhe tem uma verificação própria: mesmo com os filhos cobrindo toda a área, o pai recém-carregado não pode ser descartado enquanto sua preparação estiver pendente.
