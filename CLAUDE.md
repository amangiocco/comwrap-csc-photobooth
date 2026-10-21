# Photobooth – video wall per video AI generati da n8n

## Obiettivo
Server locale (poi evolverà) che riceve via HTTP i video generati da un workflow n8n e li mostra
a tutto schermo come un LED wall, raggiungibile da browser.

## Decisioni prese con l'utente
- Stack: **Node.js** (Express 5 + multer, dotenv), al posto di Tomcat: più semplice.
- **Eventi multipli**: si creano da una pagina admin, ognuno si **accende/spegne**.
  Spento = non accetta video (409) e il wall diventa nero.
- I video arrivano da **una chiamata HTTP che n8n fa al server**:
  `POST /api/events/<slug>/videos` con file in multipart (qualsiasi nome di campo) oppure
  JSON `{ "url": "...", "title": "..." }` (il server scarica il video).
- Layout: **nessun logo**, griglia di **card quadrate, 6 per riga**, ognuna col suo video in loop;
  il nuovo arrivato va in alto a sinistra, gli altri scalano a destra e a capo (7 6 5 4 3 2 / 1), spazio minimo tra le card.
  All'inizio c'è una riga di card segnaposto (`WALL_PLACEHOLDER`, di default il video YouTube
  LXb3EKWsInQ, con iframe), trattate come i video più vecchi: i nuovi le spingono avanti.
  Tutti i video sono nel wall: si scorre in verticale ai più vecchi (barra e cursore solo mentre
  si muove il mouse, ritorno in cima dopo 60 s; i video fuori schermo sono in pausa).
  Un video che arriva in diretta prima viene **presentato al centro** (cornice luminosa animata,
  scritta «<userid>, ecco il tuo video», parametro `userid` della chiamata), poi vola nella prima
  card; durata `WALL_SHOWCASE_SECONDS` (default 8). Con il wall non visibile (altra scheda, o
  finestra coperta: su Windows Chrome la considera nascosta) i timer vanno a 1/min: la
  presentazione **aspetta** che il wall torni visibile e parte allora (saltarla non va bene: l'utente
  manda la richiesta da n8n con il wall dietro e poi vuole vederla, 2026-10-02).
  Il wall non dipende dal WebSocket: senza diretta ricarica la lista ogni 5 s (scritta «Non
  collegato in diretta» in basso) e i video nuovi trovati così hanno la loro presentazione. Le
  ricariche vanno una alla volta; un video in volo verso la card resta nella griglia.
  (All'inizio era a tutto schermo, uno dopo l'altro: cambiato su richiesta dell'utente.)
- Sicurezza: **due accessi separati** (richiesta utente 2026-10-12, `server/auth.js`).
  **Chiave API** (`PHOTOBOOTH_API_KEY` in `.env`, header `x-api-key` o `Authorization: Bearer`) per
  n8n e servizio di stampa: invii video/foto/mail, coda di stampa, gestione e pulizia eventi (scelta
  utente: le curl del pannello n8n restano valide). **Non apre la console.** **Console**: utente e
  password (`ADMIN_USER`, `ADMIN_PASSWORD_HASH` = hash scrypt; generata al primo avvio e stampata una
  volta, `npm run set-password` per cambiarla), sessione in cookie HttpOnly SameSite=Strict, 12 h
  rinnovate con l'uso, in memoria (riavvio = nuovo login), controllo Origin sulle scritture, blocco di
  5 min dopo 5 password sbagliate. La console può tutto; **solo la console**: `/api/info`, account e
  modelli email, template di stampa (caricamento/anteprima), log, `/api/admin/api-key` (per «Copia»).
  Nel browser nessuna chiave. **HTTPS della console** (richiesta utente 2026-10-21, `server/https.js`):
  in locale con certificato in `.env` (`HTTPS_CERT`/`HTTPS_KEY`, es. mkcert, porta `HTTPS_PORT`, di
  default 443) e su AWS dietro un proxy che fa HTTPS (`TRUST_PROXY`); quando c'è, `/admin` su http
  rimanda a https e il login su http dà 403, salvo da loopback. Chiamate con la chiave, wall e print
  restano anche su http (le curl di n8n non cambiano). Wall e pagina print restano **pubblici** (scelta utente 2026-10-12, da
  rivedere col deploy su AWS).
- Server in ascolto su tutte le interfacce, porta 80 (indirizzi senza porta).
- Indirizzo: **localhost con la porta in uso** (es. `http://localhost:80`) in link, esempi e
  messaggi; il dominio previsto all'inizio è stato tolto ovunque su richiesta dell'utente
  (2026-10-02). `PUBLIC_URL` in `.env` resta possibile ma è vuoto.

- **Un solo comando**: `npm start` avvia il server e, come processo figlio, il servizio di stampa
  (log con prefisso `[stampa]`; se cade riparte, se si ferma subito per configurazione il server resta
  su). `PRINT_AGENT=0` lo esclude (server su AWS: la stampa gira sul PC con `npm run print`).
- **Admin a tab** (richiesta utente 2026-10-02), pagina quasi a tutta larghezza:
  «Eventi» = barra nuovo evento + un accordion per evento (dentro: template di stampa, carta, email,
  chiamata n8n, e Video / Foto da stampare anch'essi accordion); «Email» = account SMTP;
  «Stampa» = stato del servizio e coda per evento. Tab e accordion aperti ricordati nel browser.
  La prova email dell'evento chiede solo il destinatario: manda una card di esempio disegnata nel
  browser e come link il wall; gli altri segnaposto mostrano il proprio nome, perché i valori veri
  arrivano dal servizio.
- **Stampa** (secondo servizio): n8n manda le foto a `POST /api/events/<slug>/photos` (file o URL,
  `userid`, `copies`); vanno in coda sul server. Il servizio `print/agent.js` gira
  sul PC con la stampante e **preleva** la coda (polling, solo chiamate in uscita: funziona col
  server su AWS), unisce la foto al template PSD con ag-psd + sharp, salva JPEG + PDF della misura
  del template, manda l'anteprima al server e stampa con pdf-to-printer su una stampante **USB**
  installata in Windows. La stampante foto non è ancora collegata (`PRINTER_NAME` vuoto = salva solo).
- Template: `templates/Comwrap-Network-TEMPLATE-COMWRAP-REPLysite.psd` (1080×1620, 200 dpi). La foto
  va **al posto del livello `card`** (nascosto, con maschera); sopra si usa la composita salvata da
  Photoshop. Il PSD ha testi segnaposto `{name}`, `{Performance}`, `{Style}`, `{Fun}`,
  `{technique}`, `{total}`: riscritti con i valori della chiamata (`userid` → `{name}` così come arriva, maiuscole/minuscole
  comprese: richiesta utente 2026-10-21,
  punteggi `total`, `technique`, `fun`, `style`, `performance` obbligatori, a 2 cifre) con
  @napi-rs/canvas, tarati sul testo di esempio. I caratteri che il font non ha (gli Alaska trial
  caricati il 2026-10-21 non hanno cifre né accentate) si prendono da Impact, con un avviso nel
  template. Al 2026-10-01 mancano: i font Alaska
  (`templates/fonts/`, ora si usa Impact) e il PSD risalvato con i 6 segnaposto nascosti.
- **Indirizzi per evento**: `/<slug>/wall` e `/<slug>/print`: GET la pagina, POST l'invio da n8n
  (video / foto); i vecchi `/wall/<slug>`, `/print/<slug>` reindirizzano, `/api/events/<slug>/videos`
  e `/photos` restano validi. Nomi evento riservati in `RESERVED_SLUGS` (store.js).
- **Live**: wall e print usano un WebSocket (`/api/events/<slug>/live`, `public/live.js`, `ws`), non
  EventSource: con SSE più di 6 schede saturavano le connessioni HTTP/1.1 del browser e tutto restava
  in pending (successo il 2026-10-02). SSE resta per compatibilità. Server su `::` (dual stack): su
  Windows `localhost` va prima su IPv6. Nel wall tutte le card visibili riproducono (richiesta esplicita dell'utente: niente video bloccati);
  i player YouTube partono scaglionati ogni 500 ms, fuori schermo tornano copertina.
- Card di esempio (placeholder) per evento: `showPlaceholder` (default sì), interruttore in admin;
  «Elimina tutti i video» la mette a false (richiesta utente). Il wall ricarica sul messaggio `settings`.
- Admin, «Chiamate da n8n» per evento: **tutte** le chiamate utili a n8n come comandi curl (bash),
  a gruppi (video, foto, email, evento, pulizia), ognuna con «Copia» che inserisce la chiave;
  provate tutte con curl su un server di prova (2026-10-02).
- Admin: «Elimina tutti i video» / «Elimina tutte le foto» (`DELETE /api/events/<slug>/videos|photos`).
- **Template a runtime**: PSD e font si caricano dall'admin per evento (`server/templates.js`,
  `data/templates/<slug>/`), controllati e con anteprima; la coda dà all'agente `template.version`
  e gli URL, l'agente scarica e tiene in cache (`os.tmpdir()/photobooth-templates`). Senza template
  caricato l'agente usa la cartella `templates/` del PC.
- **Disco**: il servizio di stampa non tiene copie (PDF in temp, cancellato dopo la stampa) salvo
  `PRINT_KEEP_FILES=1`; il server tiene originale (ristampe) e anteprima ridotta a 1200 px.
- **Carta**: impostazioni di stampa per evento (`server/print-settings.js`, admin): formato (default
  10×15 lucida), orientamento, adattamento, bordo (nessuno / uniforme / istantanea, mm, colore),
  margini, scala e formato del driver; `print/layout.js` impagina il foglio a 300 dpi.
- **Anteprima di stampa** su `/<slug>/print` (pagina separata dal wall, pubblica, live via SSE). A ogni
  nuova anteprima si apre una finestra di stampa classica (foglio + stampante, copie, formato carta);
  si chiude da sola 1,5 s dopo lo stato `printed`, altrimenti resta aperta con «Chiudi».
- **Email** (terzo servizio, `server/mail.js`, nodemailer): **un solo account SMTP per il server**,
  impostato dall'admin («Account email»: server, porta, SSL/STARTTLS/nessuna, utente, password,
  mittente, risposte a), salvato in `data/mail.json`; la password non torna mai al browser (campo
  vuoto = resta quella salvata). Da admin: «Prova la connessione» e «Invia mail di prova».
  **Un modello HTML per evento**, caricato dall'admin con le sue immagini (`data/mail/<slug>/`):
  le immagini con percorso relativo diventano allegati `cid:`, gli URL assoluti restano; anteprima
  in admin con i segnaposto evidenziati. **L'oggetto non è nel modello**: `subject` è obbligatorio
  nella chiamata, configurabile dal servizio, con segnaposto (richiesta utente 2026-10-02).
  n8n chiama `POST /<slug>/mail` (o `/api/events/<slug>/mail`) con la chiave, JSON/form/multipart.
  Obbligatori (decisione utente 2026-10-02): `to`, `subject`, `userid` (contiene **nome e cognome**), `link`
  (URL http/https della **pagina EDS** costruita nel flusso) e `card` (la card generata col PSD,
  **la manda n8n**: file nel multipart, qualsiasi campo, oppure URL nel campo `card` scaricato in
  un file temporaneo cancellato subito). Nel modello `{userid}`, `{link}` e `<img src="{card}">`:
  la card è **nel testo e anche allegata** (`card-Nome-Cognome.jpg`); se il modello non usa
  `{card}` è solo allegata. L'admin avvisa se il modello non usa uno dei tre (`unused`).
  `cc`/`bcc` facoltativi (max 50), gli altri campi (o
  l'oggetto `params`) riempiono `{nome}` / `{{nome}}` nel testo e nell'oggetto. Risposta: `ok`,
  `messageId`, `accepted`, `rejected`, `missing` (segnaposto senza valore, lasciati vuoti).
  Errori: 409 evento spento / senza modello / account non configurato, 400 indirizzi, 502 SMTP.
  **Privacy**: invio immediato, destinatari e valori non salvati da nessuna parte, log compresi.
  Al 2026-10-02 l'utente ha configurato un account Gmail (smtp.gmail.com:587), ma dalla rete
  dell'ufficio (10.21.x) i server SMTP di Google non sono raggiungibili su nessuna porta (587, 465,
  25, 443: timeout), mentre smtp.office365.com:587 sì. Gmail va provato da un'altra rete o da AWS.

- **Log** (richiesta utente 2026-10-05, `server/logs.js`): tab «Log» dell'admin con filtri (livello,
  tipo, evento, testo), aggiornamento in diretta ogni 5 s, «Carica voci più vecchie», download `.log`
  (testo) o JSON (`GET /api/logs`, `/api/logs/download`, con chiave). Si registrano le chiamate HTTP
  (con il motivo degli errori), le attività (video, foto, stampe, email, schermi in diretta) e tutto
  l'output su console di server e servizio di stampa (`[stampa]`), chiave API mascherata. Non si
  registrano le letture periodiche riuscite (polling di admin, wall, agente), corpi delle chiamate,
  `userid`, né indirizzi email (mascherati come `[email]`: regola privacy delle mail). File JSONL per
  giorno in `data/logs/`, **retention 2 giorni** (`LOG_RETENTION_DAYS`): voci e file più vecchi cancellati.

## Stato
Prima versione completa e funzionante (test `npm test` verdi, avvio provato).
- `server/store.js`: eventi in `data/events.json` (scritture in coda, rename con retry per i lock
  di Windows), video in `data/media/<slug>/`.
- `server/app.js`: API admin, upload da n8n (multipart o URL), wall e SSE, media con Range.
- `server/index.js`: .env, chiave generata al primo avvio, porta libera da 4700, URL LAN, Ctrl+C.
- `public/admin.*`, `public/wall.*`: pagine admin e wall (servite da `/static`).
- `server/photos.js`, `server/download.js`: foto da stampare e coda; download da URL condiviso.
- `print/agent.js`, `print/compose.js`: servizio di stampa (preleva, compone col PSD, stampa).
- `server/mail.js`: account SMTP, modelli email per evento, invio da n8n (UI in `public/admin.js`).
- `test/`: store, upload multipart/URL, errori, stream SSE, composizione PSD, coda e servizio di stampa,
  email (con un server SMTP finto in `test/helpers/smtp.js`).

Possibili evoluzioni: provare il wall su un vero browser/schermo, deploy fuori dalla LAN (HTTPS,
chiavi distinte admin/n8n).
