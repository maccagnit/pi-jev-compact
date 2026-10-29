# Verifica — 29 settembre 2026

Stato: prototipo locale implementato e verificato; successivamente registrato nei pacchetti globali di Pi su richiesta dell'utente.

## Evidenza

| Verifica | Risultato |
|---|---|
| Test locali | 27/27 passati con Node test runner dopo la correzione 0.1.1 |
| Caricamento vero tramite Pi | Pi 0.87.1 carica `index.ts`, registra comando e tool |
| Compattazioni persistenti | Tre tramite `session.compact()`: fast, summary, fallback nativo; risposte dei modelli simulate |
| Riduzione fixture Pi | 53.522 → 6.690 token stimati da Pi, −87,5% |
| Integrità | 55 messaggi preesistenti invariati; tool call/result accoppiati |
| Ripresa | Sessione JSONL riaperta; recupero di un originale dopo due compattazioni verificato |
| Jev reale, tre decisioni | KEEP / KEEP / ARCHIVE; 818 token di input, 375 ms nell'ultima prova |
| Pipeline fast con Jev reale | Una richiesta, 1.567 token input Jev, 310 ms; nessuna chiamata generativa |
| Checkpoint pipeline fast | 198 token stimati contro 26.762 del tratto sintetico sostituito |
| Qwen reale, modalità summary | Nessun riepilogo utilizzabile entro 20 s; fallback a estratti completato |

La fixture contiene molti log ripetitivi ed è favorevole alla compressione. Il −87,5% non è un benchmark contro billion-context e non predice la qualità o il risparmio di una sessione reale. Il test con il motore Pi usa un provider simulato per la modalità summary; i test Jev reali sono separati. Nel test Qwen la risposta non conteneva token conteggiati: non è prova di inferenza riuscita e non stabilisce la causa dell'indisponibilità.

Le latenze Jev sono singole osservazioni, non medie o percentili. Il timeout configurato è 2,5 s, senza retry. I token del provider Jev vengono riportati come tali; i token del checkpoint sono stime locali. I campi `summaryInputEstimate` misurano il prompt potenziale della modalità summary: in fast questo prompt non viene inviato.

## Invarianti coperte

- Richieste utente esatte, precedenza delle richieste ripetute, cinque compattazioni consecutive.
- Istruzioni del turno spezzato incluse; confine recente scelto da Pi rispettato.
- I messaggi omessi dalla proiezione non entrano nel checkpoint; la ricerca esplicita conserva accesso agli originali del ramo.
- File letti/modificati conservati e classificati correttamente.
- Chiave Jev assente, errore HTTP/rete, timeout, risposta malformata e distribuzione incoerente.
- ARCHIVE a bassa probabilità ignorato; KEEP obbligatori non troncati per farli entrare.
- Riepilogo incompleto, citazioni inventate, timeout e annullamento utente.
- Budget del checkpoint e guadagno minimo; se la proposta personalizzata non è praticabile, il gestore lascia procedere la compattazione nativa.
- Recupero paginato completo, ID estranei rifiutati, riapertura da disco.
- Redazione di credenziali comuni prima della richiesta Jev e divieto di redirect.

## File e stato

Runtime attuale: `index.ts`, `init.ts`, `compact.ts`, `jev.ts`. Test ordinari: `test/compact.test.mjs`, `scripts/integration.mjs`, `scripts/live-jev.mjs`; recupero e reload nei test aggiunti sotto.

I test SDK creano una cartella temporanea indipendente e la rimuovono al termine. I test live hanno usato la chiave Jev già disponibile al proprietario, passata solo nell'ambiente del processo: nessuna chiave è stata salvata nel progetto. Il runtime dell'estensione legge solo `TYPESAFE_API_KEY`, senza dipendere da Hermes.

Nessuna modifica a Hermes, alle impostazioni globali di Pi o al pacchetto billion-context. Nessun processo residente aggiunto. Il confronto con sessioni reali prolungate resta da fare prima di considerare dimostrata una qualità equivalente a Hermes o superiore a billion-context.

## Installazione successiva per la prova

Il 29 settembre, su richiesta dell'utente, `pi install` ha registrato la cartella locale in `~/.pi/agent/settings.json`. Verificato direttamente nel TUI `pi config`: `Pi-Jev-Compact/index.ts` passa da `[x]` a `[ ]` e nuovamente a `[x]`, salvando rispettivamente `-index.ts` e `+index.ts`. Stato finale: abilitato. Tutte le altre impostazioni e i pacchetti precedenti sono invariati; billion-context resta disabilitato.

Backup precedente: `~/.pi/agent/settings.json.bak-jev-compact-20260929-010105`. Non sono state copiate credenziali: per Jev resta necessario fornire `TYPESAFE_API_KEY` all'ambiente del processo Pi; in assenza della chiave funziona il fallback locale.

## Correzione 0.1.1: `fallback_exceeds_budget`

L'errore segnalato è stato riprodotto offline su una copia della sessione locale più recente: riepilogo nativo precedente di 21.132 caratteri (7.097 token con lo stimatore dell'estensione) contro un limite fisso di 2.400. Il codice precedente tentava di conservarlo integralmente, poi annullava l'intera richiesta di compattazione. I test iniziali coprivano solo vecchi riepiloghi piccoli: era una lacuna della verifica.

La correzione tratta 2.400 come obiettivo ordinario e ammette un budget adattivo per il contenuto obbligatorio solo se viene rispettato il guadagno minimo (512 token e 30% del tratto sostituito). Per proposte non praticabili ed errori interni, il gestore restituisce `undefined`, permettendo il fallback nativo di Pi; solo l'abort dell'utente restituisce `cancel: true`.

Prova con `scripts/replay-session.mjs`, senza rete, senza Jev e senza chiamate al modello:

- 267 elementi originali conservati identici e riepilogo precedente incluso integralmente.
- 36 coppie di chiamata/risultato tool ancora valide.
- Contesto ricostruito stimato da Pi: **41.690 → 34.265**, guadagno **7.425**.
- Checkpoint: 7.803 token stimati dall'estensione, budget adattivo 8.549.
- Checkpoint salvato nella copia e verificato dopo riapertura del JSONL.
- Hash della sessione sorgente invariato; la copia temporanea è stata eliminata.

Le due stime usano metodi diversi: non vanno sommate o confrontate come misure dello stesso tokenizer. Queste misure non includono una nuova inferenza sul provider né garantiscono la stessa percentuale sulla UI della sessione attiva.

Regressioni aggiunte: migrazione da riepilogo nativo grande, richieste utente grandi con materiale comprimibile, fallback nativo completo attraverso `session.compact()`, fallback su errore e rispetto dell'abort. Backup del codice precedente: `~/.pi/agent/backups/pi-jev-compact-20260929-010611`.

## Versione 0.2.0: recupero `/jev-compact init`

Il recupero ha un percorso dedicato a due passaggi estrattivi locali. Non richiede una riduzione percentuale del singolo blocco, non conserva obbligatoriamente un vecchio checkpoint enorme nel prompt e non annulla l'operazione se il 45% è irraggiungibile. Il checkpoint è limitato a 2.400 token stimati; gli originali rimangono nel ramo recuperabile. Gli elenchi storici completi di file restano nei vecchi checkpoint, recuperabili per ID, invece di essere reintrodotti integralmente nei metadati del nuovo checkpoint.

Verifiche aggiunte in `scripts/init-integration.mjs`, usando il vero `AgentSessionRuntime` e il comando caricato da Pi 0.87.1:

- Esecuzione immediatamente dopo un compact: la preparazione nativa restituisce `undefined`, ma init completa il recupero.
- Passaggio effettivo alla copia persistita: nuovo ID, riferimento alla sessione originale, 107 elementi precedenti conservati, sorgente invariata.
- Fixture: 61.081 → 8.972 token stimati, con overhead sistema/strumenti incluso; zero chiamate API.
- Vecchio checkpoint enorme e richiesta utente enorme condensati senza `fallback_exceeds_budget`.
- Ultima coppia tool call/result enorme archiviata insieme; proiezione senza risultati orfani.
- Prompt/strumenti oltre il target: riduzione della cronologia applicata comunque, `targetReached: false` riportato.
- Messaggi omessi e ramo fratello esclusi dal checkpoint; recupero degli originali dopo riapertura.
- Un secondo init sotto il target non crea una copia. Un veto al cambio sessione elimina la copia non utilizzata.
- Compact ordinario fast dopo init riuscito con `keepRecentTokens: 20000` invariato; controlli off e messaggi in coda verificati.

Replay offline `scripts/replay-init.mjs` su una copia della sessione reale, dopo un primo compact ordinario:

- **34.265 → 20.677 token stimati**, circa 31,6% di una finestra da 65.536; target 29.491.
- Checkpoint di 2.399 token stimati dall'estensione, sei blocchi analizzati in due passaggi.
- 267 elementi originali conservati, 21 coppie tool ancora attive e valide, vecchio riepilogo recuperabile per ID.
- Nessuna chiamata API, hash della sessione sorgente invariato, file temporanei eliminati.

Le stime non sono misurazioni del tokenizer del provider. Il replay include il prompt di sistema registrato; la UI della sessione attiva può avere strumenti o prompt diversi. Non prova che tutti i dettagli importanti saranno presenti nel checkpoint: init è un recupero più aggressivo, con frammenti esplicitamente incompleti e recupero tramite `jev_recall`.

Suite ordinaria: 27/27 test passati; integrazione ordinaria e nuova integrazione init passate. Backup precedente all'aggiunta di init: `~/.pi/agent/backups/pi-jev-compact-before-init-20260929`.

## Correzione 0.2.1: reload e cache ESM

L'errore precedente continuava a comparire anche dopo un reload eseguito correttamente. I test iniziali avviavano processi nuovi: non verificavano l'aggiornamento di un'estensione già caricata. Riprodotto nello stesso processo: `DefaultResourceLoader.reload()` e `AgentSession.reload()` caricano di nuovo l'entrypoint TypeScript, ma un helper `.mjs` già importato restituisce ancora il vecchio codice dalla cache ESM nativa di Node. Riprodotto anche con jiti static e `tryNative: false`, la configurazione usata dalla distribuzione bundle di Pi.

Convertita l'intera catena dei moduli runtime a `.ts` (`init`, `compact`, `jev`) e aggiornati gli import. Questi moduli vengono ricaricati da jiti. Nessuna modifica al core di Pi, alla configurazione globale o alla sessione dell'utente. Aggiunta la versione 0.2.1 allo status e alle notifiche init.

`scripts/reload-integration.mjs` usa un solo processo e il vero `AgentSession.reload()`:

1. Carica una copia della precedente struttura e riproduce esattamente il rifiuto `fallback_exceeds_budget`.
2. Sostituisce il file `.mjs`, esegue reload e verifica che l'errore rimanga: riproduzione della segnalazione dell'utente.
3. Migra gli import a `.ts`, esegue reload e verifica che init usi il codice nuovo senza riavviare il processo.
4. Modifica nuovamente init, compactor e selettore transitivo; verifica che tutti e tre si aggiornino al reload.
5. Verifica la versione visibile e una compattazione ordinaria con i moduli aggiornati; nessuna chiamata API.

Passato con Node 26.8.2, lo stesso eseguibile usato dal processo Pi dell'utente. L'app Terminal non era accessibile tramite il controllo UI disponibile: la verifica riguarda il processo di test, non un comando inviato al terminale aperto dell'utente.
