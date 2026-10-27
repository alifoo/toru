# Plano: direção humana nas gravações (câmera, gestos e skill)

27/10/2026 · status: proposta, aguardando aprovação

## Por que

Nas gravações da Nock de 27/10 (fluxo de Sinais e criação de sinal de e-commerce) o vídeo saiu com três defeitos de direção que nenhum ajuste de captura resolve:

1. **O clique acontece antes de a câmera chegar.** O cursor clica e só depois o zoom entra, então o espectador vê o resultado sem ver a ação.
2. **Zoom em quase todo clique.** Cada "Próximo" do assistente ganhou um zoom de entrada e saída. O vídeo pulsa e cansa.
3. **Nenhum gesto humano.** O cursor só viaja em linha até o alvo e clica. Ninguém aponta para uma tabela, contorna o número que importa ou passa o cursor por uma linha enquanto fala dela, coisas que qualquer pessoa faz numa demo.

## O que o código faz hoje

- **Câmera** (`packages/render-contract/src/index.ts`, `proposeZoomRegions`): uma região de zoom por grupo de cliques próximos (raio de 0,33 do quadro, até 9 s de intervalo). A região começa `leadInMs` = 900 ms antes do clique, **exceto a primeira, que começa no próprio clique**. Como a câmera do renderizador ainda leva cerca de 1 s (`cameraLeadMs`) para assentar, o primeiro zoom de cada vídeo chega depois do clique. Nas demais, `travelStartBefore` só adianta a câmera quando há telemetria do percurso. Depois, os cortes de espera (`removableSpans`) e a aceleração dos intervalos em que o agente está pensando (`thinkingSpeed` = 3×) mexem na linha do tempo e podem comer esse adiantamento.
- **Ponteiro** (`packages/browser/src/webdriver.ts`): o percurso leva 550 ms (`pointerTravelMs`), com uma pausa de 160 ms (`travelPauseMs`) antes do clique. O percurso é uma linha reta interpolada, sem curva, sem desaceleração humana e sem micro-movimento em repouso.
- **Ferramentas do agente** (`apps/mcp/src/server.ts`): só existem `browser_click`, `browser_move`, `browser_type`, `browser_scroll`, `browser_key`, `browser_select` e `browser_wait`. Não há nenhuma ação de ênfase.
- **Plano** (`apps/mcp/src/run-plan.ts`): as ações aceitas são `click|type|select|press|scroll|wait|navigate`. Não há como planejar um gesto.
- **Limite da gravação**: cerca de 2 minutos (`remainingRecordingMs`). Gestos somam tempo, então precisam ser curtos.

## Objetivo e como medimos

Um vídeo do Toru deve parecer dirigido por uma pessoa que conhece o produto. Critérios, medidos a partir de `events.json` e da linha do tempo renderizada:

| Métrica | Hoje (estimado) | Meta |
|---|---|---|
| Cliques em que a câmera ainda está em movimento no momento do clique | primeiro de cada vídeo e vários outros | 0 |
| Antecedência entre a câmera assentar e o clique | negativa no primeiro | ≥ 300 ms |
| Zooms por minuto de vídeo | ~1 por clique | ≤ 4 |
| Zooms que entram e saem em menos de 2 s ("bombeada") | vários | 0 |
| Telas de resultado com um gesto de atenção antes do fim | 0 | 100% |
| Nota do fundador (1 a 5) num banco fixo de vídeos | — | ≥ 4 |

## Fase 0: estudo das ações humanas (2 a 3 dias)

Antes de implementar, catalogar o que as pessoas fazem quando gravam uma demo.

1. **Referências**: 20 a 30 demos gravadas por pessoas (Arcade, Screen Studio, Tella, Loom, Supademo, Storylane, lançamentos de produto no YouTube) e as nossas próprias gravações manuais. Para cada uma, anotar os gestos, quando aparecem e quanto duram.
2. **Medidas do movimento**: a partir de gravações de tela com o cursor real, medir velocidade e forma do percurso (curvatura, perfil de velocidade em sino, pequeno passe do alvo antes de parar), pausa antes de clicar e o que o cursor faz parado (deriva de alguns pixels).
3. **Catálogo de gestos** (entregável, em `docs/gestos-humanos.md`). Para cada gesto: quando usar, duração, amplitude e como a câmera deve reagir. Lista inicial a validar:
   - **Apontar e repousar**: ir até um elemento e ficar parado com uma leve deriva. É o "olha aqui".
   - **Contornar**: uma volta (elipse) em torno de um número, cartão ou bloco de resultado.
   - **Sublinhar**: passar sob uma linha de texto da esquerda para a direita.
   - **Varrer**: percorrer linhas de uma tabela ou lista de cima para baixo, como quem lê.
   - **Hesitar**: uma pausa curta sobre um botão importante antes de clicar.
   - **Rolar lendo**: rolagem lenta com pausas, em vez de um salto.
   - **Sair de cena**: estacionar o cursor fora do conteúdo no resultado final (já existe com `browser_move`, mas só no final).
4. **Regras de direção**: quantas ênfases cabem numa tela, o que fazer em telas de transição (assistentes, "Próximo") e o que nunca fazer (contornar o tempo todo, girar sem motivo).

## Fase 1: câmera que chega antes do clique e zoom com critério (3 a 4 dias)

1. **Câmera antes do clique, sempre.**
   - A região passa a começar `cameraLeadMs` + 300 ms antes do clique em todos os casos, inclusive o primeiro.
   - Nenhum corte ou aceleração pode cair na janela que vai de 1,5 s antes do clique até 0,5 s depois dele (`removableSpans` e os intervalos de aceleração respeitam essa reserva).
   - Teste em `render-contract` com uma linha do tempo sintética cobrindo o primeiro clique, um clique depois de uma espera longa e um clique logo após navegação.
2. **O driver espera a câmera.** Quando o alvo fica longe do enquadramento atual (fora do raio do grupo), o driver segura o clique o tempo de a câmera chegar, com uma pausa de 600 a 800 ms antes de apertar, em vez dos 160 ms de hoje. Vale só para cliques que abrem um grupo novo, para não deixar os outros lentos.
3. **Menos zoom.**
   - Botões de navegação ("Próximo", "Voltar", abas, links de menu) e cliques que trocam a tela inteira não ganham zoom próprio: ficam no plano aberto.
   - O grupo passa a ser o painel do DOM (o contêiner do elemento clicado), não só a distância, então cliques no mesmo formulário ficam num único zoom.
   - Teto de zooms por minuto, e pelo menos 2 s em plano aberto entre dois zooms.
   - O zoom fica reservado para o que se lê: digitação, um resultado, um elemento pequeno que o espectador precisa ver.
4. **Checagem de entrega.** `qualityReview` passa a reprovar vídeos com câmera em movimento no clique ou com bombeadas, para não gastar crédito com vídeo ruim.

## Fase 2: gestos no driver e nas ferramentas (4 a 5 dias)

1. **Movimento humano em todo percurso.** Curva leve (Bézier com pontos de controle aleatórios dentro de limites), velocidade em sino (minimum-jerk), um pequeno passe do alvo na chegada e deriva de 1 a 3 px quando parado. Fica em `packages/browser/src/webdriver.ts`, com a telemetria atual (os percursos já são gravados).
2. **Novas ações**, com as mesmas garantias das atuais (só dentro da página, sem clicar):

   | Ferramenta | O que faz | Duração |
   |---|---|---|
   | `browser_point` | apontar e repousar num elemento | 0,8 a 1,5 s |
   | `browser_trace` | contornar um elemento, com `shape: circle\|underline` | 0,8 a 1,2 s |
   | `browser_sweep` | varrer linhas de uma lista ou tabela (`rows` = quantas) | ~0,3 s por linha |
   | `browser_read` | rolar lendo uma área, com pausas | por altura |

   Todas aceitam `ref` ou `x,y` como as atuais e devolvem a captura de tela.
3. **A câmera entende os gestos.** Cada gesto vira uma ação semântica `emphasis` na linha do tempo, com a caixa do elemento. A câmera trata isso como um enquadramento suave sobre a caixa (sem zoom-bombeada), ou como o momento de resultado quando vier logo antes de `mark_demo_moment` com `kind: result`.
4. **Hesitação automática.** Antes de cliques marcados como importantes no plano, o driver faz a hesitação sozinho, sem o agente precisar pedir.
5. **Plano.** `run-plan.ts` passa a aceitar as ações `point`, `trace`, `sweep` e `read`, para que o agente as escreva no roteiro e a tela de acompanhamento mostre.

## Fase 3: skill de direção para os agentes (1 a 2 dias)

1. **Guia** no skill (`toru-skills/skills/toru/SKILL.md`, com uma referência nova `references/direction.md`) e no guia do servidor (`apps/mcp/src/recording-guide.ts`):
   - O vocabulário de gestos, quando usar cada um e quando não usar.
   - Uma ênfase por tela de conteúdo, no máximo duas.
   - Em telas de transição, nada de gesto: clicar e seguir.
   - Antes do resultado final, apontar ou contornar a prova e depois sair de cena.
   - Nunca clicar logo ao chegar num botão que muda a tela inteira; deixar a hesitação acontecer.
2. **Exemplos de plano com gestos**: um assistente de várias etapas (o de Sinais da Nock é um bom caso), uma tabela de resultados e um formulário.
3. **Versão** do skill 0.5.0, com o `last-updated` e a tabela de atualização.

## Fase 4: avaliação (contínua, 1 dia por rodada)

1. **Banco fixo de 6 fluxos**:
   - Nock: catálogo de Sinais, criação de sinal e planilha de resultados.
   - O site do Toru.
   - Um SaaS público com tabela.
   - Um formulário longo.

   Cada rodada grava os 6 antes e depois da mudança, nos mesmos tamanhos (1440x900 e 1920x1080).
2. **Métricas automáticas** da tabela de objetivos, calculadas por um script sobre `events.json` e a linha do tempo de render, salvas por rodada.
3. **Nota do fundador**, de 1 a 5, nos 6 vídeos, sem saber qual versão é qual.
4. **Custo**: cerca de 12 créditos do Toru por rodada (90 disponíveis hoje). Rodar só com mudança relevante.

## Ordem e entregas

| Ordem | Entrega | Depende de |
|---|---|---|
| 1 | Fase 1, itens 1 e 2 (câmera antes do clique) | nada; é o defeito mais visível |
| 2 | Fase 0 (estudo e catálogo) | pode correr em paralelo com o item 1 |
| 3 | Fase 1, itens 3 e 4 (menos zoom e checagem) | primeira rodada de avaliação |
| 4 | Fase 2 (gestos) | catálogo aprovado |
| 5 | Fase 3 (skill) | Fase 2 em produção |
| 6 | Fase 4 em cada etapa | — |

Um PR por fase, com a rodada de avaliação anexada.

## Riscos

- **Gesto artificial vira o novo defeito**: contornar demais parece robô. As regras da Fase 0 e o teto de ênfases por tela existem para isso, e a nota do fundador decide.
- **Vídeo mais longo que o limite de 2 min**: gestos curtos, nada de gesto em telas de transição, e a aceleração dos tempos de espera continua.
- **Toru for Mac**: o driver do Mac usa o mesmo caminho de ferramentas, mas o movimento é outro. Fica fora da primeira entrega, com a câmera corrigida para os dois.
- **Extensão da loja**: mudanças no driver que rodam dentro da extensão do Chrome só valem depois de publicar uma versão nova na Chrome Web Store.

## Decisões que preciso de você

1. Aprovar o plano e a ordem (câmera primeiro).
2. Se há demos de referência que você considera o padrão a seguir.
3. O teto de zoom: ≤ 4 por minuto está bom?
4. Os nomes das ferramentas novas (`browser_point`, `browser_trace`, `browser_sweep`, `browser_read`).
