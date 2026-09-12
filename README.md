# No Man’s Sky — exploração cozy multiplayer

O jogo principal usa os mesmos renderizadores, geração de terreno e configurações do editor. O servidor distribui o catálogo de planetas, o relógio do mundo e as poses dos exploradores. Movimento, colisão e pilotagem são calculados no cliente.

## Desenvolvimento local

Requisitos: Node.js 22+, pnpm 10 e SpacetimeDB **2.1.0**, compatível com o SDK instalado.

```sh
pnpm install
```

Em três terminais, a partir da raiz:

```sh
# 1. Banco persistente, apenas na interface local
pnpm spacetime:start

# 2. Compila, gera bindings, publica e observa o módulo
pnpm dev:server

# 3. Cliente Vite
pnpm dev
```

Abra [o jogo](http://localhost:5173/) ou [o editor](http://localhost:5173/?editor&perf).
Para testar outro explorador no mesmo navegador, abra [uma segunda aba](http://localhost:5173/?explorer=friend).
As identidades são separadas por sessão de aba, servidor, banco e parâmetro `explorer`; recarregar a aba preserva a identidade e recupera a pose salva.

O CLI foi instalado em `~/.local/bin/spacetime`. Os scripts do projeto encontram esse caminho automaticamente. Em uma máquina nova, siga a [instalação oficial](https://spacetimedb.com/install) e selecione `spacetime version install 2.1.0 --use --yes`.

O banco `no-mans-sky` fica em `~/.local/share/spacetime/data`. Encerrar o processo não apaga os dados. Os comandos de publicação usam `--delete-data=never`; uma migração incompatível falha para que possa ser tratada explicitamente. Não há publicação automática em Maincloud.

Para publicar uma vez e aplicar o catálogo compilado, sem iniciar o observador:

```sh
pnpm spacetime:publish:local
pnpm spacetime:generate
```

Os caminhos de geração estão em `server/spacetime.json`, conforme a [configuração do CLI](https://spacetimedb.com/docs/cli-reference/spacetime-json/). O arquivo `client/.env.example` documenta as variáveis opcionais. Os valores padrão já apontam para `ws://127.0.0.1:3000` e `no-mans-sky`.

## Explorar

- WASD: caminhar; Shift: correr; Espaço: pular.
- C: chamar a nave; E: embarcar ou sair quando pousada.
- Na nave: segurar W para decolar; W/S controlam potência; mouse dirige; A/D rolam; Alt permite olhar ao redor.
- E durante voo: pousar, se estiver baixo e devagar, sobre terra firme com inclinação aceitável.
- H: alternar caminhada/câmera livre, só no editor (`?editor`); no mundo multiplayer a tecla não faz nada. V: wireframe de desenvolvimento.
- Enter: abrir o chat; Enter envia, Esc fecha, Tab troca de canal. Enquanto o chat está aberto o jogo não recebe teclas e devolve o mouse; ao fechar, retoma os dois.

## Chat

Três canais, um por alcance. **Global** vale para o sistema inteiro. **Corpo celeste** alcança quem está no mesmo mundo — a partir de um raio acima da superfície, e as órbitas do catálogo são distantes o bastante para que as faixas não se sobreponham. **Local** alcança 1,2 km em volta de quem falou.

`chat_message` guarda a origem de cada mensagem no referencial de quem a enviou, a mesma convenção das poses: escrita no referencial do planeta, a conversa fica no chão enquanto o mundo gira. A distância do canal local é resolvida em cada cliente, e é isso que faz dois exploradores lado a lado se ouvirem quando um está a pé no referencial do planeta e o outro sentado na nave no referencial do mundo.

O servidor valida canal, lugar e tamanho (240 caracteres), e assina remetente e horário. O histórico é cortado em 80 mensagens por canal e lugar: é esse limite que torna barato assinar a tabela inteira. Sem tela de nomes, todos são `Explorer`; o cliente mostra o fim da identidade ao lado do nome para distinguir quem fala.

Mineral Dawn conserva as escarpas, microrelevo, vegetação por habitat e props estáveis entre LODs. Véu de Gelo tem vales glaciais, plataformas fraturadas, neve e gelo azul, sem vegetação terrestre. Íris é um gigante gasoso com faixas e vórtice em movimento, sem solo pousável; a assistência de voo limita o mergulho nas camadas profundas.

Âmbar acrescenta serras em tons de cobre, Cinza Serena é um pequeno mundo rochoso sem atmosfera e Aurora traz gelo lilás ao sistema exterior. São seis planetas exploráveis/visitáveis. A nave alcança 12 km/s no espaço; a velocidade continua limitada na aproximação do solo.

## Catálogo e sincronização

`server/spacetimedb/src/shared/world-catalog.ts` define os mundos. `world-settings.ts` guarda todos os parâmetros e `visual-presets.ts` guarda Mineral Dawn. `client/src/game/planet-factory.ts` é o caminho comum de construção no editor e no jogo.

A tabela `planet_appearance` guarda o JSON completo e sua revisão. `refresh_catalogue` aplica apenas os valores compilados no servidor, mantendo IDs, relógio e exploradores. A publicação local chama esse reducer; uma nova conexão também detecta perfis desatualizados. Alterações experimentais feitas nos sliders do editor não são publicadas automaticamente: incorpore os valores ao catálogo e publique.

Órbitas e dias usam radianos/segundo e uma época persistida em `world_clock`, sem reducer periódico. As poses são enviadas a 10 Hz, com coordenadas f64 e quaternion; personagens remotos são interpolados. No chão, a pose é local ao planeta. No espaço, é mundial. A corotação assistida diminui entre 2% e 12% do raio acima do nível de referência; a 12%, a nave deixa de acompanhar rotação e translação do planeta. Isso preserva o voo arcade sem gravidade e sem deriva, não simula mecânica orbital newtoniana.

O cliente mantém a exploração durante uma desconexão e tenta reconectar a cada dois segundos. Ao voltar, envia seu estado atual. Após recarregar em voo, restaura a pose com a nave parada. Novos exploradores podem chegar perto de um jogador que já esteja caminhando; uma primeira chegada busca terra iluminada.

Esta base é para sessões pequenas: todos os clientes recebem todas as poses e ainda não há seleção por proximidade, inventário, combate ou validação de trajetórias no servidor.

## Verificação

```sh
pnpm --dir client build
pnpm spacetime:build
pnpm --dir server/spacetimedb exec tsc --noEmit
node client/scripts/terrain-checks.mjs
```

Com o servidor e o Vite ativos, no console do navegador:

```js
const checks = await import('/scripts/gameplay-checks.js');
checks.runFlightFrameChecks();
await checks.runMultiplayerChecks();
```

O teste de rede cria duas identidades temporárias no banco local e desconecta ambas ao terminar. As linhas offline permanecem como histórico. Capturas e resultados estão em `docs/multiplayer-review/`.

## Anotações de direção visual

Selecionar cor da neve e areia

"Lua" durante a noite

Texture e color mixing no terreno (e grama também)

Árvore
Pedras
