# Pi Jev Compact

Pacchetto [Pi](https://github.com/earendil-works/pi) con due estensioni indipendenti:

- **`index.ts`, il compattatore Jev.** Al posto del riepilogo generato da Pi crea un checkpoint estrattivo e limitato. Le richieste dell'utente restano testuali, oppure diventano estratti etichettati se sono molto grandi. Conserva evidenze esatte selezionate e, facoltativamente, usa l'API [TypeSafe Jev](https://docs.typesafe.ai/introduction/quickstart) per decidere cosa tenere. La cronologia completa resta nel file di sessione di Pi; il modello può recuperarla con il tool `jev_recall`.
- **`loop-guard.ts`, la protezione dai fallimenti ripetuti.** Blocca la 4ª chiamata identica dopo tre errori identici e offre `/loop-recover`. Facoltativamente rimuove dalla cronologia reinviata i vecchi blocchi `thinking` per i modelli indicati.

La modalità predefinita non fa chiamate generative: al massimo una richiesta Jev per compattazione, nessuna senza chiave. Versione inglese (di riferimento): [README.md](README.md).

## Installazione

Richiede Pi ≥ 0.87.1 (verificato su 0.87.1, 1.0.2 e 1.4.0) e Node ≥ 22.19.

```sh
pi install git:github.com/<owner>/pi-jev-compact        # oppure: pi install https://github.com/<owner>/pi-jev-compact
pi install git:github.com/<owner>/pi-jev-compact@v0.3.0 # fissato a un tag
pi install ./pi-jev-compact                             # da una copia locale (non viene copiata)
```

Dopo l'installazione entrambe le estensioni sono attive. Si attivano/disattivano singolarmente con `pi config` (selezione + Spazio); nelle sessioni aperte serve `/reload`.

**Un solo compattatore.** Disabilitare gli altri (ad esempio `pi-native.js` di `billion-context`) prima di attivare `index.ts`. L'estensione si disattiva se vede i tool `compress`/`decompress`/`acp_status`, ma non riconosce ogni possibile compattatore.

## Configurazione

Tutto è facoltativo. Senza configurazione il compattatore lavora in modalità locale e la protezione non filtra alcun modello.

### Chiave TypeSafe Jev

A ogni compattazione la chiave viene cercata in quest'ordine:

1. variabile d'ambiente `TYPESAFE_API_KEY` del processo Pi;
2. un file con la chiave: per default `~/.config/jev/typesafe.key`, oppure il percorso in `typesafeApiKeyFile` (contenuto = chiave; gli spazi esterni vengono ignorati).

Il file è la scelta più affidabile: funziona nel TUI, con `pi -p` e quando Pi viene avviato da un altro programma che non eredita l'ambiente della shell. Su un nuovo computer basta creare il file predefinito. Tenerlo privato:

```sh
mkdir -p ~/.config/jev && (umask 077 && printf '%s' 'LA_TUA_CHIAVE' > ~/.config/jev/typesafe.key)
```

`/jev-compact status` mostra l'origine della chiave (`jevKey`: `env`, `file`, `none`, `file_empty`, `file_unreadable`). Ogni checkpoint registra l'esito in `details.metrics.jev`: `ok`, `missing_key`, `timeout`, `unavailable` o `input_budget`. Senza chiave tutti gli estratti selezionati vengono conservati (modalità locale).

### File di configurazione

Percorso: `<cartella agent di Pi>/pi-jev-compact.json`, di norma `~/.pi/agent/pi-jev-compact.json` (`PI_CODING_AGENT_DIR` lo sposta). Viene letto al caricamento dell'estensione: dopo una modifica usare `/reload`.

```json
{
  "typesafeApiKeyFile": "~/secrets/typesafe.key",
  "stripThinkingModels": ["my-llama-cpp/qwen*"]
}
```

| Chiave | Default | Significato |
|---|---|---|
| `typesafeApiKeyFile` | `~/.config/jev/typesafe.key` | File con la chiave TypeSafe, usato se `TYPESAFE_API_KEY` non è impostata. `~` viene espanso. Se il file predefinito manca si usa la modalità locale. |
| `stripThinkingModels` | `[]` | Pattern `provider/model-id` (jolly `*`). Per questi modelli la protezione esclude i `thinking` precedenti dalla richiesta, senza modificare la sessione salvata. Ha aiutato un Qwen locale a uscire da un ciclo di 112 chiamate ([docs/INCIDENT-2026-10-04.md](docs/INCIDENT-2026-10-04.md)). |

Un file malformato non impedisce l'avvio di Pi: si usano i default e `/jev-compact status` riporta `configError`.

### Impostazioni di compattazione di Pi

La compattazione ordinaria mantiene soglia e confine di Pi: compatta oltre `contextWindow − compaction.reserveTokens` (default 16.384) e conserva gli ultimi `compaction.keepRecentTokens` (default 20.000). Con una finestra da 98.304 token compatta a circa 82k e riparte da circa 25–30k (prompt di sistema, tool, checkpoint e coda recente). Per finestre più piccole ridurre `keepRecentTokens` in `settings.json` (per esempio 8000 con 64k).

## Comandi e tool

```text
/jev-compact status    versione, modalità, origine della chiave, conflitti, metriche dell'ultimo checkpoint
/jev-compact fast      default: checkpoint estrattivo, nessuna chiamata generativa
/jev-compact summary   aggiunge una chiamata limitata di riepilogo al modello attivo (se fallisce torna a fast)
/jev-compact off       restituisce la compattazione a Pi in questo processo (on la riattiva)
/jev-compact init      recupero straordinario di una sessione già troppo grande (vedi sotto)
/compact               comando normale di Pi; usa il checkpoint Jev quando attivo
/loop-recover          riprende da prima di un ciclo di errori ripetuti, in una copia conservata
```

`jev_recall` accetta `query` (sottostringa, maiuscole indifferenti, 6 risultati per pagina) oppure `id` (l'elemento originale in pagine da 4.000 caratteri), con `offset` per paginare. Lavora sul ramo corrente, anche dopo la riapertura della sessione.

## Come funziona una compattazione

1. L'hook `session_before_compact` di Pi fornisce i messaggi da sostituire e il confine. Il confine lo sceglie Pi, quindi le chiamate ai tool restano insieme ai loro risultati.
2. Le richieste dell'utente vengono fissate testualmente e riportate nelle compattazioni successive (la più recente per ultima). Se non entrano nel budget di recupero vengono limitate (0.3.0). Ogni richiesta conserva le righe complete che iniziano con NOTE, CORRECTION, IMPORTANT, must, never, do not, TODO e simili. Le richieste più recenti ricevono poi prime e ultime righe, o il testo completo, entro 2.400 token stimati. Ogni estratto riporta l'id dell'originale; le richieste che non entrano vengono contate e restano recuperabili con `jev_recall`.
3. Fino a 8 estratti di evidenza (righe complete, ≤ 800 caratteri) vengono scelti localmente: materiale recente, corrispondenze con la richiesta corrente, errori e decisioni.
4. Con la chiave, Jev classifica ogni estratto come KEEP / SUMMARIZE / ARCHIVE / UNCERTAIN. ARCHIVE si applica solo con probabilità ≥ 0,9. Vengono inviati solo la richiesta corrente abbreviata e gli estratti, dopo una redazione di credenziali comuni (chiavi PEM, bearer/basic, assegnazioni `key/token/password/secret` anche in JSON, `sk-`/`ts_`, chiavi AWS, GitHub, Slack, Google, JWT, credenziali negli URL). Non è una garanzia DLP.
5. Il checkpoint punta a 2.400 token stimati (byte UTF-8 / 3, circa il 25% sopra i token reali per il codice). Può crescere per conservare intero un riepilogo precedente, ma deve sempre liberare ≥ 512 token e ≥ 30% del tratto sostituito.
6. Se non si può costruire un checkpoint valido (per esempio troppo poco da recuperare) o l'estensione fallisce, nella stessa richiesta parte la compattazione nativa di Pi. Solo un'interruzione dell'utente annulla. Ogni passaggio al nativo viene salvato nella sessione come voce `pi-jev-compact-fallback` (non inviata al modello) con il motivo, perché in `pi -p` le notifiche non sono visibili.

### `/jev-compact init`

Recupero straordinario per una sessione già troppo grande. Due passaggi locali, senza chiamate API, costruiscono un checkpoint di frammenti puntando al 45% della finestra. Il risultato viene scritto in una **copia** della sessione, su cui Pi si sposta; l'originale resta in `/resume`. Richiede una sessione salvata, un agente inattivo e un modello con finestra nota. Usa la funzione interna `prepareCompaction` di Pi (`dist/core/compaction/compaction.js`), che non è API pubblica: una versione futura di Pi potrebbe rompere `init` senza toccare la compattazione ordinaria.

## Limiti noti

- Un checkpoint estrattivo perde contesto attivo. Gli originali sono recuperabili, ma il modello deve richiederli.
- Le richieste testuali possono portare un checkpoint fino al 70% del tratto sostituito quando ci stanno. Si libera meno spazio di un riepilogo e si compatta più spesso.
- La modalità `summary` non ha mai prodotto un riepilogo accettato da un Qwen locale entro 20 s. Conviene `fast`, salvo modelli veloci.
- Eliminare il file di sessione elimina gli originali recuperabili. Nelle sessioni `--no-session` restano solo in memoria.
- Verificato su macOS; Windows e Linux non sono verificati.

## Sviluppo

```sh
npm test
PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" npm run test:integration
TYPESAFE_API_KEY=... npm run test:live     # solo dati sintetici, inviati a TypeSafe
```

I test usano una cartella agent di Pi temporanea, mai la configurazione o il file chiave reali. Benchmark su sessione lunga: [bench/README.md](bench/README.md). Storico delle misure: [docs/VALIDATION.md](docs/VALIDATION.md), [docs/REVIEW-2026-10-29.md](docs/REVIEW-2026-10-29.md).

## Licenza

MIT, vedi [LICENSE](LICENSE).
