# Pi Jev Compact

## Protezione dai cicli ripetuti — 0.2.2

`loop-guard.ts` è un'estensione separata, verificata su Pi **1.0.2**. Nell'installazione attuale è abilitata, mentre `index.ts` (il compattatore Jev) rimane disabilitato come scelto dall'utente. Entrambe si possono gestire separatamente da `pi config`.

- Per i soli profili `home-qwen` e `home-qwen-remote`, modello `orcarouter-qwen3.8-27b`, esclude le vecchie analisi `thinking` dal contesto reinviato. Testo visibile, tool call/result e archivio originale restano intatti. Il modello continua a poter ragionare sulla nuova richiesta.
- Dopo tre chiamate consecutive identiche con lo stesso risultato di errore, blocca la quarta con `terminate: true`. Riconosce anche `404: Not Found` prodotto da un comando che termina con exit code zero. Non è un rilevatore generico di ogni possibile ciclo: controlli riusciti, risultati diversi e nuove richieste dell'utente non vengono bloccati. Reload e compact non azzerano il conteggio, ricostruito dal ramo corrente.
- `/loop-recover` crea e apre una copia dal primo risultato del ciclo. Conserva la prima chiamata con il suo risultato, la richiesta originale e tutto il lavoro precedente; aggiunge una nota per cambiare approccio. Le ripetizioni restano nell'archivio e nella sessione originale, ma non nel ramo attivo. Non esegue automaticamente altri tool.

Per una sessione già aperta:

```text
/reload
/loop-recover
```

Poi inviare il messaggio con cui continuare. Il recupero richiede una sessione salvata e attende che Pi sia inattivo; non procede con messaggi in coda. L'indagine e i limiti della verifica sono in `INCIDENT-2026-10-04.md`.

Il compattatore Jev è stato sviluppato per Pi 0.87.1 e verificato anche su 1.0.2. Quando abilitato, il default è **fast**: una chiamata Jev al momento della compattazione e un checkpoint composto da estratti originali. Nessuna chiamata generativa, proxy, database aggiuntivo, processo in background o richiesta API a ogni turno.

## Funzionamento

- Usa `session_before_compact`, sia per `/compact` sia per la compattazione automatica di Pi.
- Pi decide il confine della cronologia recente: l'estensione lo conserva, senza separare le chiamate ai tool dai risultati.
- Le richieste utente nel tratto compattato restano testuali, anche attraverso più compattazioni. Ripetizioni identiche vengono deduplicate mantenendo la precedenza più recente.
- Conserva gli elenchi cumulativi dei file letti/modificati forniti da Pi.
- Seleziona localmente fino a otto estratti di massimo 800 caratteri, privilegiando materiale recente, corrispondenze con la richiesta corrente ed errori/decisioni. Le righe troppo lunghe rimangono nell'originale, non vengono presentate come estratti completi.
- Jev classifica gli estratti come KEEP, SUMMARIZE, ARCHIVE o UNCERTAIN. ARCHIVE viene applicato solo con probabilità almeno 0,90; KEEP e UNCERTAIN rimangono esatti. In modalità fast anche SUMMARIZE viene conservato come estratto, nei limiti del budget.
- Il checkpoint ha un obiettivo ordinario di 2.400 token **stimati**. Dalla versione 0.1.1 il budget può crescere per conservare integralmente un riepilogo precedente o testo protetto più grande: deve comunque liberare almeno 512 token stimati e almeno il 30% del tratto sostituito. Le stime locali usano byte UTF-8 / 3, non il tokenizer del provider.
- La cronologia originale resta nel JSONL di Pi. Il tool `jev_recall` cerca sul ramo corrente e permette di leggere gli originali con paginazione, anche dopo una riapertura.

Jev riceve solo la richiesta corrente abbreviata e gli estratti limitati, tramite l'endpoint ufficiale TypeSafe. Si applica una redazione di credenziali comuni; non è una garanzia di anonimizzazione. Il resto del transcript non viene spedito a Jev.

## Prova senza installazione globale

Pi deve ricevere `TYPESAFE_API_KEY` nel proprio ambiente. L'estensione non legge automaticamente credenziali da Hermes. In assenza della chiave usa una selezione locale conservativa; `/jev-compact status` mostra se Jev è disponibile.

```sh
pi -e '/Users/tommymac/Desktop/Claude Proj/Pi-Jev-Compact/index.ts'
```

Usare una sessione nuova o una copia per la prima prova. Disabilitare prima `billion-context` e altri compattatori: solo uno deve gestire la compattazione. È presente un controllo dei tool attivi `compress`, `decompress`, `acp_status`, ma non può identificare ogni possibile compattatore esterno.

Comandi dentro Pi:

```text
/jev-compact status
/jev-compact init
/compact
/jev-compact summary
/jev-compact fast
/jev-compact off
```

`fast` è il default a ogni caricamento. `summary` aggiunge una sola chiamata al modello attivo di Pi: input massimo 6.000 token stimati, output massimo 1.000 token, timeout 20 secondi. Il riepilogo deve terminare regolarmente; citazioni testuali non supportate vengono respinte. Se fallisce, si torna agli estratti. Questa verifica non dimostra la correttezza di ogni parafrasi generata.

`off` restituisce la gestione al compattatore nativo di Pi per la sessione. Non esegue subito una compattazione. I comandi di modalità non cambiano le impostazioni globali.

## Recuperare una sessione già molto carica

```text
/reload
/jev-compact init
```

`init` è il recupero straordinario della versione 0.2.0. Funziona anche immediatamente dopo un compact, quando Pi potrebbe rispondere `Already compacted`. Non usa i vincoli del compact ordinario e non può restituire `fallback_exceeds_budget`.

Dalla **0.2.1** tutti i moduli runtime sono `.ts`: i precedenti helper `.mjs` rimanevano nella cache ESM di Node anche dopo `/reload`, lasciando in esecuzione il vecchio init. La migrazione e le modifiche successive sono verificate nello stesso processo con il vero reload di Pi. `/jev-compact status` mostra `version: "0.2.1"`; le notifiche init riportano `Jev init v0.2.1`. Per caricare questa correzione nel processo già aperto occorre un reload dopo l'aggiornamento dei file.

Esegue due passaggi **locali**, senza chiamate Jev o generative: seleziona frammenti per blocchi della cronologia visibile, poi li riunisce in un checkpoint entro 2.400 token stimati. Privilegia richiesta corrente, vincoli, errori e lavoro pendente. Le vecchie richieste, i riepiloghi e gli elenchi di file molto lunghi vengono condensati: non sono tutti mantenuti testualmente nel prompt attivo. Ogni estratto riporta l'ID della fonte; il testo completo rimane recuperabile con `jev_recall`. I frammenti sono indicati come incompleti, non come un riepilogo semanticamente completo.

Prova confini recenti progressivamente più piccoli, fino a conservare solo il checkpoint se un singolo ultimo risultato tool è enorme. Chiamate e risultati vengono conservati o archiviati insieme. L'obiettivo del contesto totale è il **45% della finestra del modello**: è una stima che include prompt di sistema/strumenti senza contarli due volte. Se questi da soli impediscono il raggiungimento del target, applica comunque la riduzione utile e lo segnala. Il target non annulla il recupero.

Per usare le API di Pi senza scrivere nella sessione attiva, `init` crea una copia con un nuovo ID e riferimento alla sessione originale; Pi la apre automaticamente dopo la verifica su disco. La copia contiene l'intera cronologia originale, non soltanto il checkpoint. La sessione precedente rimane disponibile in `/resume`. La gestione ordinaria riparte in modalità fast, con le impostazioni globali di compact invariate. Ripetere `init` su un contesto già piccolo non crea altre copie.

Il comando richiede una sessione salvata e un modello con finestra nota. Attende la fine della risposta corrente e non sostituisce una sessione con messaggi ancora in coda. `off` e il controllo dei compattatori concorrenti valgono anche per `init`. Il percorso è verificato su Pi 0.87.1; usa la funzione interna `prepareCompaction` per rispettare la proiezione e i confini scelti da Pi, più le API pubbliche per creare/aprire la copia.

Per un'installazione persistente, dopo la prova:

```sh
pi install '/Users/tommymac/Desktop/Claude Proj/Pi-Jev-Compact'
```

Per rimuovere l'installazione persistente:

```sh
pi remove '/Users/tommymac/Desktop/Claude Proj/Pi-Jev-Compact'
```

Il pacchetto è registrato nelle impostazioni globali del Mac. Stato attuale: `loop-guard.ts` abilitato, `index.ts` disabilitato. In `pi config`, selezionare il singolo modulo e premere Spazio per abilitarlo/disabilitarlo; Esc chiude. Il toggle del compattatore è stato verificato in entrambe le direzioni. Per una sessione Pi già aperta usare `/reload` dopo la modifica. `billion-context` resta disabilitato.

## Quanto contesto recente conservare

La compattazione ordinaria rispetta `compaction.keepRecentTokens` di Pi, il cui default è 20.000. Solo `init` sceglie un confine più profondo per quella singola operazione. Per una finestra da 65.536 token, il test d'integrazione ordinario usa questa configurazione più aggressiva:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 8000
  }
}
```

È un frammento da integrare nelle impostazioni della sessione/progetto desiderato, non da sostituire all'intero file esistente. L'installazione ha aggiunto solo il pacchetto a `~/.pi/agent/settings.json`; i parametri di compattazione non sono stati modificati. Il contesto totale dopo il compact comprende anche il prompt di sistema, gli strumenti e il tratto recente; l'obiettivo 2.400 riguarda solo il checkpoint e non garantisce una percentuale fissa sul totale.

## Limiti deliberati

La selezione di otto estratti è una riduzione con perdita di contesto attivo. Gli originali sono recuperabili, ma non c'è garanzia che il modello li richieda sempre. La riduzione della cronologia recente è un compromesso fra costo e continuità.

Se un checkpoint personalizzato non può conservare il materiale obbligatorio e liberare abbastanza spazio, l'estensione restituisce il controllo alla compattazione nativa di Pi nella stessa richiesta. Non provoca `Compaction cancelled` per un limite interno di budget. Lo stesso fallback vale per gli errori dell'estensione; una cancellazione esplicita dell'utente resta una cancellazione. Il fallback nativo comporta la normale chiamata di riepilogo di Pi, con i suoi costi, limiti e possibili errori del provider.

La versione 0.1.0 falliva passando da un riepilogo nativo maggiore di 2.400 token alla modalità fast. La 0.1.1 è stata verificata su una copia di una sessione reale con un riepilogo precedente di 21.132 caratteri, conservandolo integralmente. Per aggiornare una sessione già aperta: `/reload`, quindi `/compact`.

Nessuna riscrittura distruttiva della cronologia e nessun equivalente che reinserisca tutto il transcript nel prompt. `jev_recall` recupera pagine mirate. L'archivio è il file di sessione Pi: eliminandolo si eliminano anche gli originali recuperabili. Nelle sessioni `--no-session` il recupero dura solo quanto la sessione in memoria.

Verificato su macOS con Pi 0.87.1. Windows e altre versioni non sono stati verificati. Non è stato eseguito un confronto controllato con `billion-context` su una sessione reale.

## Verifica

```sh
npm test
PI_PACKAGE_DIR=/Users/tommymac/.local/lib/node_modules/@earendil-works/pi-coding-agent npm run test:integration
npm run test:live
```

Il test live richiede `TYPESAFE_API_KEY` e spedisce esclusivamente dati sintetici. Per aggiungere il test opzionale sul Qwen configurato nel Mac:

```sh
PI_PACKAGE_DIR=/Users/tommymac/.local/lib/node_modules/@earendil-works/pi-coding-agent node scripts/live-jev.mjs --with-summary
```

`PI_PACKAGE_DIR` indica il pacchetto Pi già installato. È necessario se `npm root -g` punta a una diversa installazione Node. Non serve installare dipendenze runtime aggiuntive.

Risultati e limiti delle misurazioni: [VALIDATION.md](VALIDATION.md).

Fonti delle API: [compattazione Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md), [TypeSafe API](https://docs.typesafe.ai/introduction/quickstart). L'idea di separare decisioni Jev, protezione deterministica e recupero riprende il progetto locale Hermes-Jev-Context; il runtime Hermes non viene importato o modificato.
