# Progresso: direção humana nas gravações

Plano: `docs/plano-direcao-humana-2026-10-27.md` (aprovado em 27/10/2026). Um PR por etapa, empilhados; nenhum merge sem o fundador.

## Etapas

- [x] **1a · Câmera antes do clique** (Fase 1, itens 1 e 2) · branch `feat/direcao-fase-1-camera`
  - [x] Todo zoom abre pelo menos 800 ms antes do clique, inclusive o primeiro (`proposeZoomRegions`, `clickSettleMs`)
  - [x] Nada é cortado nem acelerado de 1,5 s antes a 0,5 s depois de cada clique (`clickReserveRanges`, `pointerActivity`)
  - [x] O driver segura 700 ms o clique que abre um enquadramento novo (`opensNewShot`, `newShotHoldMs`)
  - [x] Testes: render-contract 98, browser 137, workspace inteiro verde
- [x] **0 · Estudo dos gestos humanos** · branch `feat/direcao-fase-0-estudo`
  - [x] Pesquisa: cinemática do apontar (minimum jerk, submovimentos, reentrada) e guias de screencast/zoom
  - [x] Catálogo `docs/gestos-humanos.md`: parâmetros do movimento, 7 gestos, regras de direção, exemplo da Nock
  - [ ] Medir em demos de referência do fundador (espera a lista dele; não bloqueia a Fase 1b)
- [x] **1b · Menos zoom e checagem de entrega** (Fase 1, itens 3 e 4) · branch `feat/direcao-fase-1b-menos-zoom`
  - [x] Sem zoom em clique que só avança o fluxo ("Próximo", "Voltar", "Continuar" ou página que muda em até 1,5 s); a tela seguinte abre um grupo novo e a câmera já está aberta e parada quando o botão é clicado (`movesFlowOn`)
  - [x] Grupo pelo contêiner do DOM: o driver mede o painel em volta do alvo (`CapturePointer.container`) e cliques no mesmo painel (IoU > 0,7) são um enquadramento só, no painel
  - [x] Teto de 4 zooms/min e 2 s abertos entre zooms; perto, a câmera segura em vez de sair e voltar; digitação e resultado nunca saem (`paceZooms`)
  - [x] Checagem de entrega: `camera_late` e `zoom_pumping` (`reviewCamera`, usado por `assessDemo` com o config do render); só em demos dirigidas
- [ ] **2 · Gestos no driver e nas ferramentas**
  - [ ] Percurso humano (curva, sino, passe do alvo, deriva)
  - [ ] `browser_point`, `browser_trace`, `browser_sweep`, `browser_read` (driver, servidor, extensão)
  - [ ] Ação semântica `emphasis` tratada pela câmera
  - [ ] `run-plan.ts` aceita `point`, `trace`, `sweep`, `read`
- [ ] **3 · Skill de direção** (toru-skills 0.5.0, `references/direction.md`, `recording-guide.ts`)
- [ ] **4 · Avaliação** (banco de 6 fluxos, métricas, nota do fundador; espera aprovação e extensão pronta)

## Registro

- 27/10: etapa 1a pronta (este arquivo criado), PR #18.
- 27/10: Fase 0 pronta (catálogo).
- 27/10: etapa 1b pronta, PR #20 (render-contract 107 testes, browser +2).
