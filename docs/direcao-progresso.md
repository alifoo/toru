# Progresso: direção humana nas gravações

Plano: `docs/plano-direcao-humana-2026-10-27.md` (aprovado em 27/10/2026). Um PR por etapa, empilhados; nenhum merge sem o fundador.

## Etapas

- [x] **1a · Câmera antes do clique** (Fase 1, itens 1 e 2) · branch `feat/direcao-fase-1-camera`
  - [x] Todo zoom abre pelo menos 800 ms antes do clique, inclusive o primeiro (`proposeZoomRegions`, `clickSettleMs`)
  - [x] Nada é cortado nem acelerado de 1,5 s antes a 0,5 s depois de cada clique (`clickReserveRanges`, `pointerActivity`)
  - [x] O driver segura 700 ms o clique que abre um enquadramento novo (`opensNewShot`, `newShotHoldMs`)
  - [x] Testes: render-contract 98, browser 137, workspace inteiro verde
- [ ] **0 · Estudo dos gestos humanos** · branch `feat/direcao-fase-0-estudo`
  - [ ] Referências (20 a 30 demos) e medidas do movimento
  - [ ] Catálogo `docs/gestos-humanos.md` com regras de direção
- [ ] **1b · Menos zoom e checagem de entrega** (Fase 1, itens 3 e 4)
  - [ ] Sem zoom em navegação e trocas de tela
  - [ ] Grupo pelo contêiner do DOM
  - [ ] Teto de ~4 zooms/min e 2 s abertos entre zooms
  - [ ] `qualityReview` reprova câmera em movimento no clique e bombeadas
- [ ] **2 · Gestos no driver e nas ferramentas**
  - [ ] Percurso humano (curva, sino, passe do alvo, deriva)
  - [ ] `browser_point`, `browser_trace`, `browser_sweep`, `browser_read` (driver, servidor, extensão)
  - [ ] Ação semântica `emphasis` tratada pela câmera
  - [ ] `run-plan.ts` aceita `point`, `trace`, `sweep`, `read`
- [ ] **3 · Skill de direção** (toru-skills 0.5.0, `references/direction.md`, `recording-guide.ts`)
- [ ] **4 · Avaliação** (banco de 6 fluxos, métricas, nota do fundador; espera aprovação e extensão pronta)

## Registro

- 27/10: etapa 1a pronta (este arquivo criado).
